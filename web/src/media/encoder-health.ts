import type { FailReason } from './codec-policy';

/**
 * Сторож одного кодировщика (камеры или показа — у каждого свой, R152): когда отступить на ступень
 * ниже по лестнице (`codec-policy.ts`), когда вернуться и когда только подсказать человеку.
 *
 * ПРИЗНАКИ ОТСТУПА — три, каждый подряд, а не однажды:
 * - `qualityLimitationReason === 'cpu'` `FALL_SAMPLES` раз (при такте 3 с — около 9 с): одиночный
 *   всплеск на статике за перегрузку не считаем;
 * - время кодирования кадра больше `ENCODE_SHARE` его бюджета (`1000 / fps`) `FALL_SAMPLES` раз:
 *   кодировщик ещё успевает, но вот-вот перестанет — Chromium назовёт это `cpu` позже, чем надо;
 * - ждали аппаратный кодировщик, а работает программный (`powerEfficientEncoder === false` или имя
 *   libvpx/libaom/OpenH264) `SOFTWARE_SAMPLES` раз: так выглядит аппаратный AV1, который драйвер не
 *   поднял, или K-SVC, который Media Foundation не умеет.
 *
 * НИЖЕ НЕКУДА — ПОДСКАЗКА, А НЕ ПОНИЖЕНИЕ. На программном H.264 (последняя ступень) при `cpu` сторож
 * ничего не меняет: выбранные кадр и частота — нижняя граница (X10, Р-19). Он только говорит, что
 * процессор не успевает, — человеку решать, закрыть ли тяжёлое или выбрать меньшее качество.
 *
 * ВОЗВРАТ. Отступ из-за нагрузки часто временный (открыли тяжёлое приложение), поэтому первый возврат
 * — через `RESTORE_BASE` спокойных замеров (≈12 с), каждый следующий вдвое терпеливее, а после
 * `MAX_FALLS` отступов за сессию возвратов нет: каждый прыжок — переопубликация и моргание плитки.
 * «Аппаратный оказался программным» не возвращается вовсе — он и через минуту будет программным.
 *
 * Сторож живёт всю встречу: переподключение его не пересоздаёт (раньше `new EncoderHealth()` на
 * каждом `connected` обнулял число отступов, и после resume кодек прыгал через два замера).
 */
export interface EncoderSample {
  /** `qualityLimitationReason`: `cpu` / `bandwidth` / `other` / `none`; `unknown` — браузер молчит (Safari). */
  limitation: string;
  /** Среднее время кодирования кадра за интервал, мс (Δ`totalEncodeTime` / Δ`framesEncoded`); `null` — нет данных. */
  encodeMs: number | null;
  /** Выбранная частота — от неё бюджет кадра. */
  targetFps: number;
  /** Кодирует процессор; `null` — браузер не говорит. */
  software: boolean | null;
}

export interface HealthContext {
  /** Решение ждёт аппаратный кодировщик. */
  expectHw: boolean;
  /** Ниже по лестнице ничего нет (программный H.264, VP8): вместо отступа — подсказка. */
  lowest: boolean;
  /** Есть отступ из-за нагрузки, к которому можно вернуться. */
  restorable: boolean;
}

export type HealthResult =
  | { verdict: 'none' }
  | { verdict: 'fallback'; reason: FailReason }
  | { verdict: 'hint'; reason: 'cpu' | 'encode-time' }
  | { verdict: 'restore' };

export class EncoderHealth {
  static readonly FALL_SAMPLES = 3;
  static readonly SOFTWARE_SAMPLES = 2;
  static readonly RESTORE_BASE = 4;
  static readonly MAX_FALLS = 3;
  /** Доля бюджета кадра, после которой кодировщик считается не успевающим. */
  static readonly ENCODE_SHARE = 0.8;
  private cpu = 0;
  private slow = 0;
  private soft = 0;
  private calm = 0;
  private falls = 0;

  /** Сколько раз за сессию отступали из-за нагрузки. */
  get loadFalls() {
    return this.falls;
  }

  observe(sample: EncoderSample, context: HealthContext): HealthResult {
    if (context.expectHw && sample.software === true) this.soft++;
    else if (sample.software === false || !context.expectHw) this.soft = 0;
    if (this.soft >= EncoderHealth.SOFTWARE_SAMPLES) {
      this.restart();
      return { verdict: 'fallback', reason: 'software' };
    }
    // `unknown` — Safari молчит: ни жалобой, ни спокойствием это не считаем.
    if (sample.limitation === 'cpu') this.cpu++;
    else if (sample.limitation !== 'unknown') this.cpu = 0;
    const budget = sample.targetFps > 0 ? 1000 / sample.targetFps : Infinity;
    const slow = sample.encodeMs !== null && sample.encodeMs > EncoderHealth.ENCODE_SHARE * budget;
    if (slow) this.slow++;
    else if (sample.encodeMs !== null) this.slow = 0;
    const overload: 'cpu' | 'encode-time' | null =
      this.cpu >= EncoderHealth.FALL_SAMPLES
        ? 'cpu'
        : this.slow >= EncoderHealth.FALL_SAMPLES
          ? 'encode-time'
          : null;
    if (overload) {
      this.cpu = 0;
      this.slow = 0;
      this.calm = 0;
      if (context.lowest) return { verdict: 'hint', reason: overload };
      this.falls++;
      return { verdict: 'fallback', reason: overload };
    }
    if (!context.restorable || this.falls >= EncoderHealth.MAX_FALLS) {
      this.calm = 0;
      return { verdict: 'none' };
    }
    // «Спокойно» — не `cpu` и кадр в бюджете: нехватка канала к процессору отношения не имеет, а
    // молчание браузера осторожно считаем за не-спокойно, чтобы не вернуться на тяжёлое вслепую.
    this.calm = sample.limitation === 'cpu' || sample.limitation === 'unknown' || slow ? 0 : this.calm + 1;
    const needed = EncoderHealth.RESTORE_BASE * 2 ** Math.max(0, this.falls - 1);
    if (this.calm >= needed) {
      this.calm = 0;
      return { verdict: 'restore' };
    }
    return { verdict: 'none' };
  }

  /** Новый кодировщик (переопубликация): подряд считается заново, память об отступах остаётся. */
  restart() {
    this.cpu = 0;
    this.slow = 0;
    this.soft = 0;
    this.calm = 0;
  }
}

/** Имена программных кодировщиков в `encoderImplementation` Chromium и Safari. */
const SOFTWARE = /libvpx|libaom|openh264|svt|dav1d|ffmpeg|software/i;

/**
 * Программный ли кодировщик — по статистике `outbound-rtp`. `powerEfficientEncoder` прямее имени: его
 * Chromium ставит по `is_hardware_accelerated`; имя — запасной признак (`SimulcastEncoderAdapter
 * (libvpx, libvpx)`, `MediaFoundationVideoEncodeAccelerator (NVIDIA …)`).
 */
export function softwareEncoder(stat: { powerEfficientEncoder?: unknown; encoderImplementation?: unknown }) {
  if (typeof stat.powerEfficientEncoder === 'boolean') return !stat.powerEfficientEncoder;
  if (typeof stat.encoderImplementation !== 'string' || !stat.encoderImplementation) return null;
  return SOFTWARE.test(stat.encoderImplementation);
}

/** Самый крупный слой отдачи — по нему судим о кодировщике. */
export interface TopLayer {
  id: string;
  /** `video/AV1`; `null` — браузер не связал слой с кодеком. */
  mime: string | null;
  /** `sdpFmtpLine` кодека: профиль H.264/H.265/VP9. */
  fmtp: string | null;
  scalabilityMode: string | null;
  software: boolean | null;
  implementation: string | null;
  encodeTime: number | null;
  frames: number;
  /** `qualityLimitationDurations`, с. */
  limits: { cpu: number; bandwidth: number; other: number } | null;
}

/** Что видно в одном отчёте `getStats` своей видеодорожки. */
export interface UpstreamReading {
  width: number;
  height: number;
  fps: number;
  bytes: number;
  at: number;
  /** Причина ограничения любого слоя; `unknown` — браузер не называет (Safari). */
  limitation: string;
  /** Есть опубликованный, но спящий слой (dynacast). */
  dormant: boolean;
  /** Слоёв в отчёте — simulcast виден их числом. */
  layers: number;
  top: TopLayer | null;
}

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export function readUpstream(report: RTCStatsReport | undefined): UpstreamReading {
  const reading: UpstreamReading = {
    width: 0,
    height: 0,
    fps: 0,
    bytes: 0,
    at: 0,
    limitation: 'none',
    dormant: false,
    layers: 0,
    top: null,
  };
  let named = false;
  report?.forEach((stat) => {
    if (stat.type !== 'outbound-rtp' || (stat.kind ?? stat.mediaType) !== 'video') return;
    reading.layers++;
    if (typeof stat.qualityLimitationReason === 'string') named = true;
    if (typeof stat.qualityLimitationReason === 'string' && stat.qualityLimitationReason !== 'none')
      reading.limitation = stat.qualityLimitationReason;
    reading.bytes += Number(stat.bytesSent ?? 0);
    reading.at = Math.max(reading.at, Number(stat.timestamp ?? 0));
    if (stat.active === false) reading.dormant = true;
    // Слоёв может быть несколько; «что мы отдаём» — это самый крупный из них.
    const frame = Number(stat.frameWidth ?? 0);
    if (frame < reading.width || (frame === 0 && reading.top)) return;
    reading.width = frame;
    reading.height = Number(stat.frameHeight ?? 0);
    reading.fps = Number(stat.framesPerSecond ?? 0);
    const codec = report.get(stat.codecId);
    const durations = stat.qualityLimitationDurations as Record<string, unknown> | undefined;
    reading.top = {
      id: String(stat.id),
      mime: typeof codec?.mimeType === 'string' ? codec.mimeType : null,
      fmtp: typeof codec?.sdpFmtpLine === 'string' && codec.sdpFmtpLine ? codec.sdpFmtpLine : null,
      scalabilityMode: typeof stat.scalabilityMode === 'string' ? stat.scalabilityMode : null,
      software: softwareEncoder(stat),
      implementation: typeof stat.encoderImplementation === 'string' ? stat.encoderImplementation : null,
      encodeTime: finite(stat.totalEncodeTime),
      frames: Number(stat.framesEncoded ?? 0),
      limits: durations
        ? {
            cpu: finite(durations.cpu) ?? 0,
            bandwidth: finite(durations.bandwidth) ?? 0,
            other: finite(durations.other) ?? 0,
          }
        : null,
    };
  });
  if (!named && reading.layers) reading.limitation = 'unknown';
  return reading;
}

/** Разница двух отчётов одного источника: замер для сторожа и секунды для сводки отдачи. */
export interface UpstreamDelta {
  seconds: number;
  bytes: number;
  encodeMs: number | null;
  limited: { cpu: number; bandwidth: number; other: number };
}

export function upstreamDelta(previous: UpstreamReading | undefined, next: UpstreamReading): UpstreamDelta {
  const none = { seconds: 0, bytes: 0, encodeMs: null, limited: { cpu: 0, bandwidth: 0, other: 0 } };
  if (!previous || next.at <= previous.at) return none;
  const seconds = (next.at - previous.at) / 1000;
  const bytes = Math.max(0, next.bytes - previous.bytes);
  const before = previous.top;
  const after = next.top;
  // Другой верхний слой (переопубликация, simulcast перестроился) — его счётчики начались заново.
  const same = !!before && !!after && before.id === after.id;
  const frames = same ? after!.frames - before!.frames : 0;
  const encodeMs =
    same && frames > 0 && after!.encodeTime !== null && before!.encodeTime !== null
      ? Math.max(0, ((after!.encodeTime - before!.encodeTime) * 1000) / frames)
      : null;
  const limit = (key: 'cpu' | 'bandwidth' | 'other') =>
    same && after!.limits && before!.limits ? Math.max(0, after!.limits[key] - before!.limits[key]) : 0;
  return {
    seconds,
    bytes,
    encodeMs,
    limited: { cpu: limit('cpu'), bandwidth: limit('bandwidth'), other: limit('other') },
  };
}
