/**
 * Сколько заняло нажатие на микрофон и из чего сложилось (R191).
 *
 * «Включается долго» случается редко и у людей, а не на стенде, — и без числа остаётся только гадать:
 * захват, смена устройства или занятая кнопка. Поэтому медленное нажатие само пишет, что его задержало: в
 * журнал микрофона (`Диагностика`, обращение) и в счётчик `mic-slow`. Человеку — ничего.
 * Здесь только числа и слова без имён и устройств (П8).
 */

/** Живой замер 07.11.2026: здоровое включение — 2–30 мс до `enabled` и сигнала в сокет. */
export const MIC_SLOW_MS = 300;
/** Первое включение — это законные захват, шумодав и публикация: так долго уже не норма. */
export const FIRST_CAPTURE_SLOW_MS = 3000;

export interface MicPress {
  totalMs: number;
  /** Ждало занятое устройство (`deviceFree`). */
  waitMs: number;
  /** Ждало, пока система снимет заглушку с захвата, и перезахват (`wakeHeldMicrophone`). */
  wakeMs: number;
  /** `unmute` LiveKit: мгновенно, если не пришлось захватывать заново. */
  unmuteMs: number;
  processorMs: number;
  /** Захват пришлось менять уже по нажатию. */
  recaptured: boolean;
  /** Первое включение за встречу: захват и публикация. */
  firstCapture?: boolean;
  /** Состояние комнаты в момент нажатия. */
  signal: string;
  /** Оборот сокета сигнала по последнему пингу, мс; 0 — неизвестно. */
  rtt: number;
}

/** Строка журнала, если нажатие было медленным; иначе `null`. */
export function micSlowDetail(press: MicPress): string | null {
  if (press.totalMs < (press.firstCapture ? FIRST_CAPTURE_SLOW_MS : MIC_SLOW_MS)) return null;
  const parts = [`total=${Math.round(press.totalMs)}`];
  const step = (name: string, ms: number) => {
    if (ms > 0) parts.push(`${name}=${Math.round(ms)}`);
  };
  step('wait', press.waitMs);
  step('wake', press.wakeMs);
  step('unmute', press.unmuteMs);
  step('proc', press.processorMs);
  if (press.recaptured) parts.push('recapture');
  if (press.firstCapture) parts.push('first-capture');
  parts.push(`signal=${press.signal}`);
  if (press.rtt > 0) parts.push(`rtt=${press.rtt}`);
  return parts.join(' ');
}

/** Секундомер нажатия: с самого нажатия, даже если оно ждало, пока устройство освободится. */
export class PressTimer {
  private readonly startedAt: number;
  private mark: number;
  constructor(
    private readonly now: () => number = () => performance.now(),
    pressedAt?: number,
  ) {
    this.startedAt = pressedAt ?? now();
    this.mark = this.startedAt;
  }

  /** Сколько прошло с прошлой отметки. */
  lap(): number {
    const at = this.now();
    const ms = at - this.mark;
    this.mark = at;
    return ms;
  }

  total(): number {
    return this.now() - this.startedAt;
  }
}
