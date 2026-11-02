/**
 * Задержка начала стерео-дорожки до полного запаса (R182) — логика без браузера.
 *
 * Здесь решается, что делать с очередным закодированным кадром принятой дорожки: отдать декодеру сразу
 * или придержать, пока не наберётся запас, и тогда отдать всё пачкой. Поток (`receive-hold.worker.ts`)
 * только переносит кадры; всё, что можно проверить без WebRTC, проверяется здесь (`receive-hold.test.ts`).
 */

/** Сообщения сессии потоку: сколько держать (всем новым или одной дорожке) и «отпусти сейчас». */
export type HoldMessage = { type: 'hold'; ms: number; id?: number } | { type: 'release'; id: number };

/** Отсчётов RTP в миллисекунде: Opus и RED считают время в 48 кГц. */
const TICKS_PER_MS = 48;

/**
 * Стерео ли кадр Opus — по биту `s` в байте TOC (RFC 6716 §3.1).
 *
 * Музыку и звук показа Cord шлёт стерео, речь — всегда моно (R113, `microphoneOptions`). Кадр RED
 * (RFC 2198) несёт повторы впереди и основной кадр в конце: заголовки повторов — по 4 байта с битом
 * F=1, последний — 1 байт; длины повторов — в младших 10 битах заголовка. `null` — кадр не разобрать.
 */
export function opusStereo(payload: Uint8Array, red: boolean): boolean | null {
  if (payload.length === 0) return null;
  if (!red) return (payload[0]! & 0x04) !== 0;
  let at = 0;
  let redundant = 0;
  while (at < payload.length && (payload[at]! & 0x80) !== 0) {
    if (at + 3 >= payload.length) return null;
    redundant += ((payload[at + 2]! & 0x03) << 8) | payload[at + 3]!;
    at += 4;
  }
  const primary = at + 1 + redundant;
  return primary < payload.length ? (payload[primary]! & 0x04) !== 0 : null;
}

export interface HoldFrame {
  /** Источник: смена — это новый поток (новая подписка на той же секции SDP). */
  ssrc: number;
  rtpTimestamp: number;
  /** Стерео ли поток; `null` — не разобрали, тогда не держим. */
  stereo: boolean | null;
  /** Когда кадр пришёл, мс (`performance.now()` потока). */
  arrivalMs: number;
}

/**
 * Придерживает начало каждого нового стерео-потока, пока в руках не наберётся `holdMs` звука, и отдаёт
 * накопленное разом. Моно (речь) идёт насквозь всегда.
 *
 * ЗАЧЕМ. Буфер приёма (NetEq) начинает играть с первого же пакета, а запас до цели набирает растяжением
 * звука — по 8–10 % темпа. Вошедший посреди музыки слышал так первые шесть секунд: живой замер 02.11.2026,
 * THD+N −12…−27 дБ вместо −46. Когда первые 600 мс приходят пачкой, NetEq стартует уже с полным
 * запасом, и растягивать нечего: музыка звучит на 0,6 с позже — и сразу чисто.
 */
export class HoldGate<T> {
  private ssrc: number | null = null;
  private lastArrival: number | null = null;
  private first: number | null = null;
  private held: T[] = [];
  private holding = false;
  constructor(private holdMs: number) {}

  /** Сколько держать: цель запаса меняется с путём медиа и с тем, что успела насчитать сессия. */
  setHold(ms: number) {
    this.holdMs = Math.max(0, ms);
  }

  get pending() {
    return this.held.length;
  }

  /**
   * Кадр пришёл; возвращает то, что пора отдать декодеру (в порядке прихода).
   *
   * Новым потоком считается и прежний источник после тишины дольше самого запаса: за это время NetEq
   * уже выбрал всё, что было, и начал бы набирать запас заново растяжением (переподписка с тем же
   * SSRC, обрыв сети). Перерыв короче запаса — обычная задержка пакетов: буфер её переживает, и
   * держать тогда нельзя — это опустошило бы его.
   */
  push(frame: T, meta: HoldFrame): T[] {
    const resumed =
      this.lastArrival !== null && this.holdMs > 0 && meta.arrivalMs - this.lastArrival >= this.holdMs;
    this.lastArrival = meta.arrivalMs;
    if (meta.ssrc !== this.ssrc || resumed) {
      // Новый поток. Недоотданное от прежнего отдаём сразу — декодер его выбросит, если оно уже не нужно.
      const stale = this.release();
      this.ssrc = meta.ssrc;
      this.holding = meta.stereo === true && this.holdMs > 0;
      this.first = null;
      if (stale.length) return [...stale, ...this.push(frame, meta)];
    }
    if (!this.holding) return [frame];
    this.first ??= meta.rtpTimestamp;
    this.held.push(frame);
    const spanMs = ((meta.rtpTimestamp - this.first) >>> 0) / TICKS_PER_MS;
    return spanMs >= this.holdMs ? this.release() : [];
  }

  /** Отдать всё накопленное и дальше пропускать насквозь до следующего потока. */
  release(): T[] {
    this.holding = false;
    const out = this.held;
    this.held = [];
    return out;
  }
}
