import type { CodecSwitch, PublishSource } from './codec-planner';
import type { VideoCodec } from './call-quality';
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

/**
 * Отдача за окно (R152): чем и как кодировалась своя камера и свой показ — для долей кодеков и HW/SW в
 * Grafana (`cord_client_publish_seconds_total`). Секунды — по разнице `qualityLimitationDurations`
 * самого крупного слоя, то есть по часам кодировщика, а не опроса.
 */
export interface TxTrack {
  source: PublishSource;
  codec: VideoCodec;
  hw: 'hw' | 'sw' | 'unknown';
  seconds: number;
  /** Сколько из них кодировщик ограничивал процессор, канал и прочее. */
  cpuSeconds: number;
  bandwidthSeconds: number;
  otherSeconds: number;
}

export interface RxSummary {
  tracks: RxTrack[];
  /** Своя отдача; нет — ничего не публиковали. Старое ядро поле пропускает. */
  tx?: TxTrack[];
  /** Смены кодека отдачи за окно (`cord_client_codec_switch_total`). */
  switches?: CodecSwitch[];
}

/** Один замер отдачи источника: сколько секунд прошло и сколько из них чем ограничено. */
export interface TxObservation {
  source: PublishSource;
  codec: VideoCodec;
  hw: TxTrack['hw'];
  seconds: number;
  cpuSeconds: number;
  bandwidthSeconds: number;
  otherSeconds: number;
}

/** Сколько записей отдачи в одной сводке: два источника, по смене кодека посреди окна. */
export const MAX_TX = 4;
/** Сколько смен кодека в одной сводке: при окне 30 с между сменами больше не бывает. */
export const MAX_SWITCHES = 8;

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
  private tx = new Map<string, TxTrack>();
  private switches: CodecSwitch[] = [];

  /** Замер своей отдачи (`MediaSession.sampleUpstream`, раз в 3 с). */
  observeTx(observation: TxObservation) {
    if (!(observation.seconds > 0)) return;
    const key = `${observation.source}/${observation.codec}/${observation.hw}`;
    const entry = this.tx.get(key) ?? {
      source: observation.source,
      codec: observation.codec,
      hw: observation.hw,
      seconds: 0,
      cpuSeconds: 0,
      bandwidthSeconds: 0,
      otherSeconds: 0,
    };
    entry.seconds += observation.seconds;
    entry.cpuSeconds += Math.max(0, observation.cpuSeconds);
    entry.bandwidthSeconds += Math.max(0, observation.bandwidthSeconds);
    entry.otherSeconds += Math.max(0, observation.otherSeconds);
    this.tx.set(key, entry);
  }

  /** Смены кодека отдачи (`CodecPlanner.takeSwitches`). */
  noteSwitches(switches: readonly CodecSwitch[]) {
    this.switches.push(...switches);
  }

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
    const round = (value: number) => Math.round(Math.min(60, value) * 10) / 10;
    const tx = [...this.tx.values()]
      .sort((a, b) => b.seconds - a.seconds)
      .slice(0, MAX_TX)
      .map((entry) => ({
        ...entry,
        seconds: round(entry.seconds),
        cpuSeconds: round(Math.min(entry.cpuSeconds, entry.seconds)),
        bandwidthSeconds: round(Math.min(entry.bandwidthSeconds, entry.seconds)),
        otherSeconds: round(Math.min(entry.otherSeconds, entry.seconds)),
      }));
    const switches = this.switches.slice(-MAX_SWITCHES);
    this.tx.clear();
    this.switches = [];
    if (!tracks.length && !tx.length && !switches.length) return null;
    return { tracks, ...(tx.length ? { tx } : {}), ...(switches.length ? { switches } : {}) };
  }

  /** Соединение пересобрано: прежние счётчики ни о чём не говорят, окно начинается заново. */
  reset() {
    this.previous.clear();
    this.window.clear();
    this.since = null;
    // Отдача и смены кодека копятся по своим часам и переподключения переживают.
  }
}
