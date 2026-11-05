/**
 * Сторож камеры (R189, И4): чтобы камера, которую человек включил, возвращалась сама — в той же
 * публикации, без нажатий и без «включите камеру заново».
 *
 * Что ломалось. Захват кончился (`ended`: сон, USB, другое приложение) — LiveKit один раз пробует
 * перезахватить тем же устройством точно (`{exact}`), а при отказе молча глушит публикацию
 * («could not restart track, muting instead»): кнопка «Включить камеру», и никто больше не пробует.
 * Кадры перестали приходить (`muted` у захвата) — LiveKit через 5 с снимал дорожку с отправителя
 * (`pauseUpstream`) и говорил зрителям «камера выключена», а у себя кнопка горела. Чего не хватало —
 * того, что есть у микрофона (`mic-sentinel.ts`): кто-то, кто смотрит на захват и лечит.
 *
 * Что делаем. Раз в секунду (и сразу по `devicechange` и возвращению на вкладку) смотрим на камеру:
 * - захват кончился — после короткой льготы {@link ENDED_GRACE_MS} перезахват (обработчик `ended` LiveKit
 *   с камеры снят: его перезахват точно тем же устройством при отказе глушил публикацию);
 * - публикация заглушена, а человек камеру не выключал (`wanted`) — так делает LiveKit после своей
 *   неудачи, если обработчик всё же остался: перезахват и снятие заглушки;
 * - захват заглушён системой дольше {@link MUTED_FOR_MS} при видимой странице — перезахват;
 * - публикации нет, хотя камера нужна, связь есть и никто её не публикует — публикация заново;
 * - кадры не кодируются {@link STALL_MS} при живом захвате и живом подписчике — перезахват.
 *
 * Попытки — с отступом {@link BACKOFF_MS} **без предела, пока камера нужна человеку**: устройство
 * возвращается и через минуту, и через десять. С третьей неудачи подряд — любая камера той же стороны
 * (`anyDevice`), устройство — пожеланием (`ideal`), не требованием. Отказ в разрешении не лечится:
 * сторож останавливается до следующего нажатия, а сессия выключает камеру и говорит человеку.
 *
 * Сторож не вмешивается в нажатие, смену устройства, переворот, смену качества и `restoreTracks`:
 * пока сессия занята камерой (`busy`), он только смотрит. Один восстановитель на камеру.
 */
export type HealReason = 'ended' | 'muted' | 'silenced' | 'missing' | 'stalled';

/** Виды событий камеры — в журнал камеры и счётчик ядра (`core/failure.ts` → `KINDS`). */
export type CameraKind =
  | 'camera-ended'
  | 'camera-muted'
  | 'camera-silenced'
  | 'camera-missing'
  | 'camera-stalled'
  | 'camera-healed'
  | 'camera-heal-failed'
  | 'camera-denied';

/** Что сторож видит у камеры прямо сейчас. */
export interface CameraLook {
  /** Захват камеры (сырая дорожка, не выход фона); `null` — публикации нет вовсе. */
  raw: { readonly readyState: string; readonly muted: boolean } | null;
  /** Публикация заглушена (`track.isMuted` у LiveKit). */
  silenced: boolean;
  /** Кадров закодировано за всё время (`framesEncoded`); `null` — статистики нет. */
  framesEncoded: number | null;
  /** Кто-то подписан, и верхний слой не спит (dynacast `active: false` не считается). */
  watched: boolean;
}

export interface HealRequest {
  reason: HealReason;
  /** Неудач подряд в этом эпизоде — до этой попытки. */
  failures: number;
  /** Своё устройство не вернулось трижды — брать любую камеру той же стороны. */
  anyDevice: boolean;
}

export interface GuardDeps {
  look: () => CameraLook;
  /** Человек хочет камеру (включена в интерфейсе). */
  wanted: () => boolean;
  /** Сессия сама занята камерой: нажатие, смена устройства, качество, восстановление после обрыва. */
  busy: () => boolean;
  connected: () => boolean;
  visible: () => boolean;
  heal: (request: HealRequest) => Promise<void>;
  /** Разрешения нет: сторож остановлен, сессия выключает камеру и говорит человеку. */
  denied: (error: unknown) => void;
  /** Событие — в журнал камеры и счётчик. */
  note: (kind: CameraKind, detail?: string) => void;
  /** Идёт лечение — своя плитка показывает «Камера переподключается…». */
  healing: (active: boolean) => void;
  now?: () => number;
}

export const MUTED_FOR_MS = 3_000;
export const STALL_MS = 6_000;
export const ENDED_GRACE_MS = 500;
export const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;
export const OWN_DEVICE_TRIES = 3;

const DENIED = new Set(['NotAllowedError', 'PermissionDeniedError', 'SecurityError']);
/** Отказ в разрешении — по имени ошибки браузера, как в `core/failure.ts`. */
export function permissionDenied(error: unknown): boolean {
  return (
    (error instanceof Error || error instanceof DOMException) && DENIED.has((error as { name: string }).name)
  );
}

export class CameraGuard {
  private mutedSince: number | null = null;
  private endedSince: number | null = null;
  private stalledSince: number | null = null;
  private lastFrames: number | null = null;
  private restarting = false;
  /** Эпизод лечения открыт: обнаружение уже записано, идут попытки. */
  private episode: HealReason | null = null;
  private failures = 0;
  private nextAt = 0;
  /** Последняя попытка удалась — ждём такта, который это подтвердит (или опровергнет). */
  private confirming = false;
  /** Отказ в разрешении: до следующего нажатия ничего не лечим. */
  private stopped = false;

  constructor(private readonly deps: GuardDeps) {}

  /** Идёт ли эпизод лечения. */
  get active(): boolean {
    return this.episode !== null;
  }

  /** Человек нажал на камеру: эпизод закрыт, запрет после отказа снят. */
  reset(): void {
    this.closeEpisode();
    this.stopped = false;
    this.mutedSince = null;
    this.endedSince = null;
    this.stalledSince = null;
    this.lastFrames = null;
  }

  /** Устройства сменились или вернулись на вкладку: если ждём отступа — пробовать сейчас. */
  poke(): Promise<void> {
    if (this.episode && !this.restarting) this.nextAt = 0;
    return this.check();
  }

  /** Один взгляд на камеру; лечение — не чаще одного за раз. */
  async check(): Promise<void> {
    if (!this.deps.wanted() || this.stopped) {
      if (this.episode) this.closeEpisode();
      this.mutedSince = null;
      this.endedSince = null;
      this.stalledSince = null;
      return;
    }
    if (this.restarting || this.deps.busy()) return;
    const now = this.now();
    const reason = this.decide(this.deps.look(), now);
    if (!reason) {
      if (this.episode && this.confirming) {
        this.deps.note('camera-healed', this.episode);
        this.closeEpisode();
      }
      return;
    }
    if (this.confirming) {
      // Перезахват прошёл, а камера снова не та: попытка не помогла — считаем неудачей, ждём отступа.
      this.confirming = false;
      this.fail('not-recovered');
      return;
    }
    if (now < this.nextAt) return;
    if (!this.episode) {
      this.episode = reason;
      this.deps.note(`camera-${reason}`);
      this.deps.healing(true);
    }
    this.restarting = true;
    try {
      await this.deps.heal({
        reason,
        failures: this.failures,
        anyDevice: this.failures >= OWN_DEVICE_TRIES,
      });
      this.confirming = true;
      this.lastFrames = null;
      this.stalledSince = null;
      this.mutedSince = null;
      this.endedSince = null;
    } catch (error) {
      if (permissionDenied(error)) {
        this.deps.note('camera-denied');
        this.closeEpisode();
        this.stopped = true;
        this.deps.denied(error);
        return;
      }
      this.fail(error instanceof Error || error instanceof DOMException ? error.name : 'error');
    } finally {
      this.restarting = false;
    }
  }

  private fail(detail: string) {
    this.failures++;
    this.deps.note('camera-heal-failed', detail);
    this.nextAt = this.now() + BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length) - 1]!;
  }

  private closeEpisode() {
    const was = this.episode !== null;
    this.episode = null;
    this.failures = 0;
    this.nextAt = 0;
    this.confirming = false;
    if (was) this.deps.healing(false);
  }

  private decide(look: CameraLook, now: number): HealReason | null {
    if (!look.raw) {
      this.mutedSince = null;
      this.endedSince = null;
      this.stalledSince = null;
      return this.deps.connected() ? 'missing' : null;
    }
    if (look.raw.readyState !== 'live') {
      this.mutedSince = null;
      this.stalledSince = null;
      // Льгота у `ended` — чтобы не наложиться на свой же перезапуск (смена устройства, качество), который
      // останавливает захват до нового `getUserMedia`; у `silenced` льготы нет.
      if (look.silenced) return 'silenced';
      this.endedSince ??= now;
      return now - this.endedSince >= ENDED_GRACE_MS ? 'ended' : null;
    }
    this.endedSince = null;
    if (look.silenced) return 'silenced';
    if (look.raw.muted) {
      this.stalledSince = null;
      this.mutedSince ??= now;
      return now - this.mutedSince >= MUTED_FOR_MS && this.deps.visible() ? 'muted' : null;
    }
    this.mutedSince = null;
    if (look.framesEncoded === null || !look.watched) {
      this.stalledSince = null;
      this.lastFrames = look.framesEncoded;
      return null;
    }
    if (this.lastFrames !== null && look.framesEncoded === this.lastFrames) {
      this.stalledSince ??= now;
      if (now - this.stalledSince >= STALL_MS) return 'stalled';
    } else {
      this.stalledSince = null;
    }
    this.lastFrames = look.framesEncoded;
    return null;
  }

  private now() {
    return (this.deps.now ?? Date.now)();
  }
}
