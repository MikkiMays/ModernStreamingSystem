import type { LinkPath, LinkState } from './link-quality';

/**
 * Итог звонка для владельца сервера (`POST /rooms/{id}/client-report`, docs/observability.md §15).
 *
 * ЧТО УХОДИТ. Только числа и слова из перечислений: секунды звонка, медиана оборота, средние потери и
 * джиттер приёма, средний битрейт приёма, замирания картинки, путь связи и кодек картинки, которую
 * человек смотрел дольше всего, и кодек своей отдачи (R152). Ни имён, ни адресов, ни номеров участников
 * и дорожек — ядро и не примет ничего, кроме этих полей (`ClientQuality.Report`).
 *
 * ОТКУДА. Из того же опроса статистики, что раз в две секунды решает запас буфера
 * (`PlayoutController.tick`): путь, оборот, потери и джиттер — `LinkState`, байты, кодек и замирания —
 * `inbound-rtp` тех же отчётов. Своего опроса getStats здесь нет; кодек отдачи приносит опрос
 * отдачи (`notePublished`).
 */
export type VideoCodec = 'vp8' | 'vp9' | 'h264' | 'h265' | 'av1' | 'other';

export interface CallReport {
  seconds: number;
  rttMs: number | null;
  lossPercent: number | null;
  jitterMs: number | null;
  bitrateKbps: number | null;
  freezes: number;
  freezeSeconds: number;
  /** Секунды, когда потери были больше {@link LOSSY_PERCENT}. */
  lossySeconds: number;
  path: LinkPath;
  codec: VideoCodec | null;
  /**
   * Кодек своей отдачи — тот, которым ушло больше всего байт (R152); `null` — видео не публиковали.
   * Старое ядро поле пропускает.
   */
  publishCodec?: VideoCodec | null;
}

/** Короче этого — не звонок, а заглянул и ушёл: итог не шлётся. */
export const MIN_SECONDS = 10;
/** Сутки — потолок ядра для одного итога. */
export const MAX_SECONDS = 86_400;
/** Потери выше этого — «минута с потерями» вкладки «Качество». */
export const LOSSY_PERCENT = 5;
/** Промежуток между опросами длиннее этого (вкладка спала, связь пересобиралась) звонком не считается. */
const GAP_MS = 10_000;
/** Сколько последних замеров оборота держится для медианы: час опросов раз в две секунды. */
const RTT_SAMPLES = 1800;

/** Кодек картинки по `mimeType` статистики: `video/VP8` → `vp8`; незнакомый — `other`. */
export function codecOf(mime: unknown): VideoCodec | null {
  if (typeof mime !== 'string' || !mime.toLowerCase().startsWith('video/')) return null;
  const name = mime.slice(6).toLowerCase();
  if (name === 'vp8' || name === 'vp9' || name === 'h264' || name === 'av1') return name;
  if (name === 'h265' || name === 'hevc') return 'h265';
  return 'other';
}

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export class CallQuality {
  private last: number | null = null;
  private seconds = 0;
  private lossy = 0;
  private rtts: number[] = [];
  private loss = { sum: 0, count: 0 };
  private jitter = { sum: 0, count: 0 };
  private bytes = new Map<string, number>();
  private received = 0;
  private freezes = new Map<string, { count: number; seconds: number }>();
  private codecs = new Map<VideoCodec, number>();
  private sent = new Map<VideoCodec, number>();
  private paths = new Map<LinkPath, number>();

  /** Своя отдача за интервал: кодек и байты (`MediaSession.sampleUpstream`). */
  notePublished(codec: VideoCodec, bytes: number) {
    if (bytes > 0) this.sent.set(codec, (this.sent.get(codec) ?? 0) + bytes);
  }

  /** Один опрос: состояние канала и отчёты getStats подписанных дорожек. */
  observe(link: LinkState, reports: readonly RTCStatsReport[], now: number) {
    const dt = this.last === null ? 0 : now - this.last;
    this.last = now;
    const counted = dt > 0 && dt <= GAP_MS;
    if (counted) {
      this.seconds += dt / 1000;
      if (link.lossPercent !== null && link.lossPercent > LOSSY_PERCENT) this.lossy += dt / 1000;
    }
    if (link.rttMs !== null) {
      this.rtts.push(link.rttMs);
      if (this.rtts.length > RTT_SAMPLES) this.rtts.shift();
    }
    if (link.lossPercent !== null) {
      this.loss.sum += link.lossPercent;
      this.loss.count++;
    }
    if (link.jitterMs !== null) {
      this.jitter.sum += link.jitterMs;
      this.jitter.count++;
    }
    if (link.path !== 'unknown') this.paths.set(link.path, (this.paths.get(link.path) ?? 0) + 1);
    for (const report of reports)
      report.forEach((stat) => {
        if (stat.type !== 'inbound-rtp') return;
        const bytes = finite(stat.bytesReceived) ?? 0;
        const before = this.bytes.get(stat.id);
        this.bytes.set(stat.id, bytes);
        const delta = before !== undefined && bytes >= before ? bytes - before : 0;
        if (counted) this.received += delta;
        if ((stat.kind ?? stat.mediaType) !== 'video') return;
        const codec = codecOf(report.get(stat.codecId)?.mimeType);
        if (codec && delta > 0) this.codecs.set(codec, (this.codecs.get(codec) ?? 0) + delta);
        const count = finite(stat.freezeCount);
        if (count !== null) {
          const known = this.freezes.get(stat.id);
          this.freezes.set(stat.id, {
            count: Math.max(known?.count ?? 0, count),
            seconds: Math.max(known?.seconds ?? 0, finite(stat.totalFreezesDuration) ?? 0),
          });
        }
      });
  }

  /** Итог звонка или `null`, если звонка не было (короче {@link MIN_SECONDS}). */
  summary(): CallReport | null {
    if (this.seconds < MIN_SECONDS) return null;
    const seconds = Math.min(MAX_SECONDS, Math.round(this.seconds));
    const sorted = [...this.rtts].sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : null;
    let freezes = 0;
    let freezeSeconds = 0;
    for (const value of this.freezes.values()) {
      freezes += value.count;
      freezeSeconds += value.seconds;
    }
    const most = <T>(map: Map<T, number>): T | null =>
      [...map.entries()].reduce<[T, number] | null>(
        (best, entry) => (!best || entry[1] > best[1] ? entry : best),
        null,
      )?.[0] ?? null;
    return {
      seconds,
      rttMs: median === null ? null : Math.min(60_000, Math.round(median)),
      lossPercent: this.loss.count
        ? Math.min(100, Math.round((this.loss.sum / this.loss.count) * 10) / 10)
        : null,
      jitterMs: this.jitter.count ? Math.min(60_000, Math.round(this.jitter.sum / this.jitter.count)) : null,
      bitrateKbps:
        this.received > 0 ? Math.min(1_000_000, Math.round((this.received * 8) / 1000 / this.seconds)) : null,
      freezes: Math.min(100_000, Math.round(freezes)),
      freezeSeconds: Math.min(seconds, Math.round(freezeSeconds)),
      lossySeconds: Math.min(seconds, Math.round(this.lossy)),
      path: most(this.paths) ?? 'unknown',
      codec: most(this.codecs),
      publishCodec: most(this.sent),
    };
  }
}
