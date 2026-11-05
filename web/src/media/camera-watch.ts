/**
 * Сторож чужой камеры у зрителя (R189, И5).
 *
 * ЗАЧЕМ. До него у зрителя было две слепые зоны, и обе без единого следа: камера, которая так и не
 * пришла после подписки (плитка с аватаром до конца встречи), и `<video>`, который стоит при живых
 * кадрах из сети. А кадры, остановившиеся без слова SFU, чинились, только если шёл звук: `pauses.holds`
 * считал такую тишину паузой и выключал сторож зависаний. Человек видел застывшего собеседника, а
 * собеседник — что камера включена.
 *
 * ЧТО РЕШАЕТ. Только «что делать сейчас» — по одному опросу `checkLive` на дорожку. Исполняют сессия
 * (подписка) и пул (`media/video-pool.ts`, элемент); здесь нет ни LiveKit, ни браузера, и всё время — в
 * аргументах.
 *
 * ПРАВИЛА.
 * 1. **SFU сказал «пауза» — ничего.** Кадров нет по его решению, переподписка не вернёт канал (R119).
 * 2. **Желанная без дорожки дольше {@link NO_TRACK_MS}** (или SDK сказал, что подписка не удалась) —
 *    переключить подписку.
 * 3. **`framesReceived` стоит дольше {@link FLAT_FRAMES_MS}** — переподписка, со звуком или без него:
 *    новый DownTrack на SFU — это и новый запрос ключевого кадра.
 * 4. **Кадры декодируются, а на экран не попадают, или `video.paused`** — лесенка элемента: `play`,
 *    перепривязка, новый элемент. Сеть здесь ни при чём, поэтому и подписка не трогается.
 * 5. **Против петель.** Отступ {@link BACKOFF_MS} на дорожку, сначала — после {@link HEALTHY_MS}
 *    здоровых кадров; одно действие за раз; {@link GRACE_MS} после публикации, включения, переноса
 *    плитки и снятия паузы — там кадрам законно нужно время.
 *
 * Пропуск (`skip`) — заглушена, не видна, участник переподключается: смотреть не на что.
 */

/** Сколько желанная камера может быть без дорожки. */
export const NO_TRACK_MS = 5000;
/** Сколько кадры из сети могут не расти. */
export const FLAT_FRAMES_MS = 4000;
/** Сколько декодированные кадры могут не попадать на экран. */
export const UNRENDERED_MS = 4000;
/** Сколько здоровых кадров считается выздоровлением: отступ и лесенка — сначала. */
export const HEALTHY_MS = 5000;
/** Кадрам законно нужно время: после публикации, включения, переноса плитки, снятия паузы. */
export const GRACE_MS = 3000;
/** Отступ между действиями над одной дорожкой; последний — дальше без предела. */
export const BACKOFF_MS = [8000, 16000, 32000, 60000] as const;

export type CameraAction = 'none' | 'subscribe' | 'play' | 'reattach' | 'replace' | 'resubscribe';

/** Один опрос дорожки. Чего нет (статистика не ответила, элемента нет), то не повод ни для чего. */
export interface CameraSample {
  now: number;
  /** Опознавательный знак подписки (сама дорожка LiveKit): новая — новые счётчики и грация. */
  subscription: unknown;
  hasTrack: boolean;
  /** SFU сказал «пауза» и кадры не пошли. */
  sfuPaused: boolean;
  framesReceived?: number;
  framesDecoded?: number;
  /** Счётчик кадров на экране (`media/video-pool.ts`); нет — браузер не умеет или элемента нет. */
  rendered?: number;
  elementPaused?: boolean;
  /** Отметка последнего переноса плитки: сменилась — грация. */
  movedAt?: number;
  /** `LiveHealth`: декодер стоит при живых кадрах или буфер раздут. */
  stalled?: boolean;
}

const LADDER = ['play', 'reattach', 'replace'] as const;

export class CameraWatch {
  private graceUntil: number;
  private nextAt = 0;
  private attempt = 0;
  private rung = 0;
  private busy = false;
  private skipped = false;
  private failed = false;
  private wasPaused = false;
  private seen = false;
  private subscription: unknown;
  private movedAt?: number;
  private received?: number;
  private decoded?: number;
  private rendered?: number;
  private noTrackSince?: number;
  private flatSince?: number;
  private renderedAt?: number;
  private healthySince?: number;

  constructor(now: number) {
    this.graceUntil = now + GRACE_MS;
  }

  /** Смотреть не на что: заглушена, не видна, участник переподключается. */
  skip() {
    this.skipped = true;
  }

  /** SDK сказал, что подписка не удалась: не ждать {@link NO_TRACK_MS}. */
  subscriptionFailed() {
    this.failed = true;
  }

  /** Действие закончено (успехом или нет): следующее — не раньше отступа. */
  settled() {
    this.busy = false;
  }

  observe(sample: CameraSample): CameraAction {
    const { now } = sample;
    if (this.skipped) {
      this.skipped = false;
      this.restart(now);
    }
    if (sample.subscription !== this.subscription) {
      if (this.seen) this.restart(now);
      this.subscription = sample.subscription;
    }
    this.seen = true;
    if (sample.movedAt !== this.movedAt) {
      if (this.movedAt !== undefined) this.restart(now);
      this.movedAt = sample.movedAt;
    }
    if (sample.sfuPaused) {
      this.wasPaused = true;
      this.forget();
      return 'none';
    }
    if (this.wasPaused) {
      this.wasPaused = false;
      this.restart(now);
    }
    if (!sample.hasTrack) return this.withoutTrack(now);
    this.noTrackSince = undefined;
    const flat = this.flatFor(sample);
    const unrendered = this.unrenderedFor(sample);
    this.noteHealth(sample, flat, unrendered);
    if (this.busy || now < this.graceUntil || now < this.nextAt) return 'none';
    if (sample.elementPaused) return this.act(now, this.nextRung());
    if (sample.stalled || flat >= FLAT_FRAMES_MS) return this.act(now, 'resubscribe');
    if (unrendered >= UNRENDERED_MS) return this.act(now, this.nextRung());
    return 'none';
  }

  private withoutTrack(now: number): CameraAction {
    this.noTrackSince ??= now;
    if (this.busy || now < this.graceUntil || now < this.nextAt) return 'none';
    if (this.failed || now - this.noTrackSince >= NO_TRACK_MS) {
      this.failed = false;
      this.noTrackSince = now;
      return this.act(now, 'subscribe');
    }
    return 'none';
  }

  /** Сколько кадры из сети не растут. Счётчик меньше прежнего — новая подписка, считать заново. */
  private flatFor({ now, framesReceived }: CameraSample) {
    if (framesReceived === undefined) {
      this.received = this.flatSince = undefined;
      return 0;
    }
    if (framesReceived !== this.received || this.flatSince === undefined) {
      this.received = framesReceived;
      this.flatSince = now;
      return 0;
    }
    return now - this.flatSince;
  }

  /** Сколько декодированные кадры прибывают, а на экран не попадает ничего. */
  private unrenderedFor({ now, framesDecoded, rendered }: CameraSample) {
    const decodedGrew =
      framesDecoded !== undefined && this.decoded !== undefined && framesDecoded > this.decoded;
    const renderedGrew = rendered !== this.rendered;
    this.decoded = framesDecoded;
    this.rendered = rendered;
    // Показывать нечего — и «не показывается» не считается: это уже забота проверки кадров из сети.
    if (rendered === undefined || renderedGrew || !decodedGrew || this.renderedAt === undefined) {
      this.renderedAt = now;
      return 0;
    }
    return now - this.renderedAt;
  }

  private noteHealth({ now, elementPaused, framesReceived }: CameraSample, flat: number, unrendered: number) {
    const healthy = framesReceived !== undefined && flat === 0 && unrendered === 0 && !elementPaused;
    if (!healthy) {
      this.healthySince = undefined;
      return;
    }
    this.healthySince ??= now;
    if (now - this.healthySince >= HEALTHY_MS) {
      this.attempt = 0;
      this.rung = 0;
    }
  }

  private nextRung(): CameraAction {
    const rung = LADDER[Math.min(this.rung, LADDER.length - 1)]!;
    this.rung++;
    return rung;
  }

  private act(now: number, action: CameraAction): CameraAction {
    this.busy = true;
    this.nextAt = now + BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt++;
    this.forget();
    return action;
  }

  private restart(now: number) {
    this.graceUntil = now + GRACE_MS;
    this.forget();
  }

  /** Отсчёты — с начала. Отступ и лесенка остаются: их сбрасывают только здоровые кадры. */
  private forget() {
    this.received = this.decoded = this.rendered = undefined;
    this.noTrackSince = this.flatSince = this.renderedAt = this.healthySince = undefined;
  }
}
