/**
 * Один опрос статистики на всю комнату — и одно решение по каждой дорожке.
 *
 * Здесь нет ни LiveKit, ни React: контроллеру дают список дорожек, умеющих отдать свой
 * отчёт getStats, и он раздаёт приёмникам запас буфера. Всё, что можно было проверить
 * без браузера, проверяется без браузера.
 */

import { LinkMonitor, unknownLink, type LinkState } from './link-quality';
import {
  applyPlayoutTarget,
  PlayoutBuffer,
  profileFor,
  type NetworkMode,
  type PlayoutClass,
  type PlayoutDecision,
  type PlayoutSample,
} from './playout';

export interface PlayoutTrack {
  /** Устойчивый идентификатор дорожки: trackSid публикации. */
  id: string;
  kind: PlayoutClass;
  /**
   * Что с чем показывается вместе: камера с микрофоном, экран со звуком экрана.
   *
   * Нужно ради губ. Запас приёма — это **минимальная** задержка воспроизведения, и если
   * видео потребовало себе секунду, а разговор живёт на ста миллисекундах, то картинка и
   * голос разъезжаются ровно на эту разницу. Свести их обратно браузер уже не может: мы
   * сами запретили ему показывать кадр раньше.
   */
  group?: string;
  receiver?: RTCRtpReceiver;
  stats(): Promise<RTCStatsReport | undefined>;
}

export interface PlayoutReport extends PlayoutDecision {
  id: string;
  kind: PlayoutClass;
  applied: boolean;
}

/** Меньшую разницу нет смысла просить: перезапись цели не бесплатна, а на слух её нет. */
const MEANINGFUL_MS = 20;

const kindOf = (value: unknown): 'audio' | 'video' | undefined =>
  value === 'audio' || value === 'video' ? value : undefined;

function readInbound(report: RTCStatsReport, kind: PlayoutClass): PlayoutSample | null {
  const wanted = kind === 'video' ? 'video' : 'audio';
  let found: PlayoutSample | null = null;
  report.forEach((stat) => {
    if (stat.type !== 'inbound-rtp') return;
    if (kindOf(stat.kind ?? stat.mediaType) !== wanted) return;
    // Несколько inbound-rtp одного вида в отчёте одной дорожки — это слои одной и той же
    // картинки. Нужен тот, по которому вообще есть что считать.
    if (found && (stat.totalSamplesReceived ?? stat.framesDecoded ?? 0) === 0) return;
    found = stat as PlayoutSample;
  });
  return found;
}

export class PlayoutController {
  private buffers = new Map<string, { buffer: PlayoutBuffer; appliedMs: number | null }>();
  private monitor = new LinkMonitor();
  private mode: NetworkMode = 'auto';
  private linkState: LinkState = unknownLink;

  get link() {
    return this.linkState;
  }

  setMode(mode: NetworkMode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.retune(true);
  }

  /** Соединение пересобрано: прежние счётчики и прежний путь больше ни о чём не говорят. */
  reset() {
    this.buffers.clear();
    this.monitor.reset();
    this.linkState = unknownLink;
  }

  forget(id: string) {
    this.buffers.delete(id);
  }

  private retune(reseat = false) {
    for (const [, entry] of this.buffers) {
      entry.buffer.retune(profileFor(entry.buffer.kind, this.mode, this.linkState), reseat);
      // Приёмнику придётся сказать заново: без этого он останется с прежней цифрой до
      // следующего заметного изменения, то есть режим переключился бы только на словах.
      entry.appliedMs = null;
    }
  }

  /**
   * Один проход по всем подписанным дорожкам. Возвращает то, что было решено, — этим
   * пользуются и диагностика, и тесты; вызывающему достаточно вызывать это по таймеру.
   */
  async tick(tracks: PlayoutTrack[], now = Date.now()): Promise<PlayoutReport[]> {
    const live = new Set(tracks.map((track) => track.id));
    for (const id of this.buffers.keys()) if (!live.has(id)) this.buffers.delete(id);
    const reports = await Promise.all(
      tracks.map(async (track) => {
        const report = await track.stats().catch(() => undefined);
        return report ? ({ track, report } as const) : null;
      }),
    );
    const collected = reports.filter((value): value is { track: PlayoutTrack; report: RTCStatsReport } =>
      Boolean(value),
    );
    // Все подписки живут на одном соединении, поэтому путь и оборот берутся из любого
    // отчёта. Первый попавшийся — такой же, как любой другой, и стоит дешевле остальных.
    const previousOrdered = this.linkState.ordered;
    if (collected.length) this.linkState = this.monitor.observe(collected[0]!.report);
    if (this.linkState.ordered !== previousOrdered) this.retune();

    const result: PlayoutReport[] = [];
    // Звук считается первым: видео берёт запас у своего звука, а не наоборот. Наоборот было
    // бы хуже всего — голос ждал бы картинку, и разговор стал бы рацией из-за одного фриза.
    const ordered = [...collected].sort(
      (a, b) => Number(a.track.kind === 'video') - Number(b.track.kind === 'video'),
    );
    const heard = new Map<string, number>();
    for (const { track, report } of ordered) {
      const sample = readInbound(report, track.kind);
      if (!sample) continue;
      let entry = this.buffers.get(track.id);
      if (!entry) {
        entry = {
          buffer: new PlayoutBuffer(track.kind, profileFor(track.kind, this.mode, this.linkState), now),
          appliedMs: null,
        };
        this.buffers.set(track.id, entry);
      } else if (entry.buffer.kind !== track.kind) {
        // Дорожка сменила роль: музыкального бота выключили, участник остался. Начинаем
        // заново, иначе разговор унаследует запас, набранный для музыки.
        entry = {
          buffer: new PlayoutBuffer(track.kind, profileFor(track.kind, this.mode, this.linkState), now),
          appliedMs: null,
        };
        this.buffers.set(track.id, entry);
      }
      const decision = entry.buffer.observe(sample, now);
      if (track.kind !== 'video' && track.group) heard.set(track.group, decision.targetMs);
      // У картинки нет своего права на задержку: она обязана совпадать с губами. Поэтому,
      // когда рядом есть звук того же участника, видео просит ровно столько же, сколько он, —
      // в границах, где это для видео вообще имеет смысл. Свой счёт остаётся только у
      // дорожки без звука: у демонстрации экрана, которую показывают молча.
      const together = track.kind === 'video' && track.group ? heard.get(track.group) : undefined;
      const profile = profileFor(track.kind, this.mode, this.linkState);
      const targetMs =
        together === undefined
          ? decision.targetMs
          : Math.round(Math.min(profile.ceilingMs, Math.max(profile.floorMs, together)));
      let applied = false;
      if (entry.appliedMs === null || Math.abs(targetMs - entry.appliedMs) >= MEANINGFUL_MS) {
        applied = applyPlayoutTarget(track.receiver, targetMs);
        if (applied) entry.appliedMs = targetMs;
      }
      result.push({ ...decision, targetMs, id: track.id, kind: track.kind, applied });
    }
    return result;
  }

  /**
   * Запас для только что подписанной дорожки, ещё до первой статистики. Без этого первые
   * секунды новая дорожка живёт с нулевым запасом — то есть ровно в том состоянии, от
   * которого всё это и было затеяно.
   */
  prime(track: PlayoutTrack, now = Date.now()) {
    const profile = profileFor(track.kind, this.mode, this.linkState);
    const entry = this.buffers.get(track.id);
    if (!entry || entry.buffer.kind !== track.kind) {
      this.buffers.set(track.id, {
        buffer: new PlayoutBuffer(track.kind, profile, now),
        appliedMs: applyPlayoutTarget(track.receiver, profile.startMs) ? profile.startMs : null,
      });
      return profile.startMs;
    }
    applyPlayoutTarget(track.receiver, entry.buffer.target);
    entry.appliedMs = entry.buffer.target;
    return entry.buffer.target;
  }

  /** Сколько запаса мы сами попросили для этой дорожки, или 0, если ещё не просили. */
  targetFor(id: string) {
    const entry = this.buffers.get(id);
    // Именно попросили, а не насчитали: у видео эти числа расходятся, когда оно идёт за
    // своим звуком, а спрашивают отсюда для того, чтобы не считать наш запас отставанием.
    return entry?.appliedMs ?? entry?.buffer.target ?? 0;
  }

  targets(): { id: string; kind: PlayoutClass; targetMs: number }[] {
    return [...this.buffers].map(([id, entry]) => ({
      id,
      kind: entry.buffer.kind,
      targetMs: entry.appliedMs ?? entry.buffer.target,
    }));
  }
}
