/**
 * Сторож микрофона (R147): чтобы после фона и погашенного экрана на Android микрофон снова звучал.
 *
 * Что ломалось. Система глушит захват, пока Cord в фоне (`muted` у дорожки), или отбирает его вовсе
 * (`ended` — звонок GSM, другое приложение с микрофоном). LiveKit перезахватывает микрофон только при
 * включении и только если дорожка уже `ended`, а заглушённая, но «живая» дорожка так и оставалась
 * немой: на экране микрофон включён, а собеседники не слышат.
 *
 * Что делаем. Раз в секунду (и сразу по возвращении на экран) смотрим на сырую дорожку: кончилась —
 * перезахватить сразу; заглушена дольше двух секунд, пока страница на экране, — тоже. В фоне
 * заглушённую не трогаем: перезахват без экрана браузер может и не дать, а система снимет заглушку
 * сама, когда отпустит микрофон.
 */
export interface SentinelTrack {
  readonly mediaStreamTrack: { readonly readyState: string; readonly muted: boolean };
  restartTrack(): Promise<unknown>;
}

export interface SentinelDeps {
  /** Своя дорожка микрофона, если опубликована. */
  track: () => SentinelTrack | undefined;
  /** Человек хочет говорить (микрофон включён в интерфейсе). */
  wanted: () => boolean;
  visible: () => boolean;
  now?: () => number;
  /** Перезахватили — для журнала и счётчика. */
  restarted?: (reason: 'ended' | 'muted') => void;
}

export const MUTED_FOR_MS = 2_000;

export class MicSentinel {
  private mutedSince: number | null = null;
  private restarting = false;

  constructor(private readonly deps: SentinelDeps) {}

  /** Один взгляд на дорожку; перезахват — не чаще одного за раз. */
  async check(): Promise<void> {
    const track = this.deps.track();
    if (!track || !this.deps.wanted() || this.restarting) {
      if (!track || !this.deps.wanted()) this.mutedSince = null;
      return;
    }
    const now = (this.deps.now ?? Date.now)();
    const raw = track.mediaStreamTrack;
    const ended = raw.readyState !== 'live';
    if (!ended && raw.muted) this.mutedSince ??= now;
    else if (!ended) this.mutedSince = null;
    const stuck =
      !ended && this.mutedSince !== null && now - this.mutedSince >= MUTED_FOR_MS && this.deps.visible();
    if (!ended && !stuck) return;
    this.restarting = true;
    try {
      await track.restartTrack();
      this.deps.restarted?.(ended ? 'ended' : 'muted');
    } catch {
      /* Не дали захватить (фон, отказ) — попробуем на следующем такте или по возвращении на экран. */
    } finally {
      this.restarting = false;
      this.mutedSince = null;
    }
  }
}
