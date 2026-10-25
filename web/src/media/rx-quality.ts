import { measuredDelayMs, type PlayoutClass, type PlayoutSample } from './playout';

/**
 * Сводка приёма раз в десять секунд для метров ядра (`POST /rooms/{id}/quality`, W1b шаг 4,
 * docs/observability.md §4).
 *
 * ЧТО УХОДИТ. По каждому классу дорожки (`conversation` | `media` | `video`) — разности счётчиков
 * inbound-rtp за окно: отсчёты заглушки без тишины DTX, отсчёты всего, начала заглушки (слышимые
 * провалы), потерянные пакеты; запас буфера, который мы просим, и его фактическая задержка. Ни номеров
 * дорожек, ни участников: ядро кладёт это только в гистограммы по классу (`RxQuality.java`).
 *
 * ОТКУДА. Из того же опроса раз в две секунды, что решает запас буфера (`PlayoutController.tick`):
 * `PlayoutController.samples` — последние отчёты по дорожкам. Своего getStats здесь нет. Итог звонка
 * (`call-quality.ts`) — один раз в конце; эта сводка — пока разговор идёт, чтобы «музыка лагает» было
 * видно графиком, а не словами.
 */
export interface RxTrack {
  kind: PlayoutClass;
  concealed: number;
  total: number;
  events: number;
  lost: number;
  targetMs: number;
  delayMs: number | null;
}

export interface RxSummary {
  tracks: RxTrack[];
}

/** Как часто уходит сводка; ядро не примет чаще (`QualityController.WINDOW`). */
export const INTERVAL_MS = 10_000;

export interface RxObservation {
  id: string;
  kind: PlayoutClass;
  sample: PlayoutSample;
  targetMs: number;
}

interface Window {
  concealed: number;
  total: number;
  events: number;
  lost: number;
  targetMs: number;
  delays: number[];
}

const finite = (value: number | undefined) =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;
const delta = (current: PlayoutSample, previous: PlayoutSample, key: keyof PlayoutSample) =>
  Math.max(0, finite(current[key] as number | undefined) - finite(previous[key] as number | undefined));

export class RxQuality {
  private previous = new Map<string, PlayoutSample>();
  private window = new Map<PlayoutClass, Window>();
  private since: number | null = null;

  /** Один опрос: отчёты всех подписанных дорожек с их запасом. */
  observe(observations: readonly RxObservation[], now: number) {
    if (this.since === null) this.since = now;
    const live = new Set<string>();
    for (const { id, kind, sample, targetMs } of observations) {
      live.add(id);
      const before = this.previous.get(id);
      this.previous.set(id, sample);
      // Первый отчёт дорожки — точка отсчёта, разности считать не с чего.
      if (!before) continue;
      const entry = this.window.get(kind) ?? {
        concealed: 0,
        total: 0,
        events: 0,
        lost: 0,
        targetMs,
        delays: [],
      };
      entry.concealed += Math.max(
        0,
        delta(sample, before, 'concealedSamples') - delta(sample, before, 'silentConcealedSamples'),
      );
      entry.total += delta(sample, before, 'totalSamplesReceived');
      entry.events += delta(sample, before, 'concealmentEvents');
      entry.lost += delta(sample, before, 'packetsLost');
      entry.targetMs = targetMs;
      const delay = measuredDelayMs(sample, before);
      if (delay !== null) entry.delays.push(delay);
      this.window.set(kind, entry);
    }
    for (const id of this.previous.keys()) if (!live.has(id)) this.previous.delete(id);
  }

  /** Сводка за окно, когда прошло {@link INTERVAL_MS}; иначе `null`. Окно начинается заново. */
  flush(now: number): RxSummary | null {
    if (this.since === null || now - this.since < INTERVAL_MS) return null;
    this.since = now;
    const tracks: RxTrack[] = [];
    for (const [kind, entry] of this.window) {
      const delays = entry.delays;
      tracks.push({
        kind,
        concealed: Math.round(entry.concealed),
        total: Math.round(entry.total),
        events: Math.round(entry.events),
        lost: Math.round(entry.lost),
        targetMs: Math.max(0, Math.round(entry.targetMs)),
        delayMs: delays.length
          ? Math.round(delays.reduce((sum, value) => sum + value, 0) / delays.length)
          : null,
      });
    }
    this.window.clear();
    return tracks.length ? { tracks } : null;
  }

  /** Соединение пересобрано: прежние счётчики ни о чём не говорят, окно начинается заново. */
  reset() {
    this.previous.clear();
    this.window.clear();
    this.since = null;
  }
}
