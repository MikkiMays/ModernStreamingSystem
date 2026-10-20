/**
 * Кнопки разговора в интерфейсе самой системы — Media Session API (W1, `docs/mobile.md` §3).
 *
 * Где это видно на самом деле:
 * - настольный Chrome — в окне «картинка в картинке» кнопки микрофона, камеры и «Завершить»;
 * - Safari 18.4+ — человек может выключить микрофон или камеру из интерфейса Safari, и страница
 *   об этом узнаёт (`togglemicrophone`), а мы сообщаем Safari, что включено (`setMicrophoneActive`);
 * - Chrome на Android карточку для звонка не покажет: медиасессия из одних WebRTC-плееров у него
 *   неуправляемая. Вреда от этого нет, пользы — тоже; на Android разговор держит уведомление
 *   «… использует микрофон» или приложение Cord.
 *
 * Классом `MediaSession` не назван нарочно: так называется владелец комнаты в `session.ts`.
 * Каждый вызов — в `try/catch`: неизвестное действие бросает `TypeError`, а Safari до 27 бросал и
 * на известных.
 */
export type SystemAction = 'togglemicrophone' | 'togglecamera' | 'hangup' | 'enterpictureinpicture';

export interface SystemControlsHandlers {
  microphone: () => void;
  camera: () => void;
  hangup: () => void;
  /** Свернуть в окно (W3: настольный Chrome зовёт это сам, когда вкладку уводят из фокуса). */
  pictureInPicture?: () => void;
}

/** Та часть `navigator.mediaSession`, которой мы пользуемся; в тестах — подделка. */
export interface MediaSessionLike {
  metadata: unknown;
  setActionHandler(action: string, handler: (() => void) | null): void;
  setMicrophoneActive?: (active: boolean) => void | Promise<void>;
  setCameraActive?: (active: boolean) => void | Promise<void>;
}

export interface CallMetadata {
  title: string;
  artist: string;
  artwork: { src: string; sizes: string; type: string }[];
}

const ACTIONS: SystemAction[] = ['togglemicrophone', 'togglecamera', 'hangup', 'enterpictureinpicture'];

function browserSession(): MediaSessionLike | null {
  return typeof navigator !== 'undefined' && 'mediaSession' in navigator
    ? (navigator.mediaSession as unknown as MediaSessionLike)
    : null;
}

function makeMetadata(data: CallMetadata): unknown {
  // `MediaMetadata` нет в jsdom и в старых движках: тогда метаданные — обычный объект, которого
  // Safari и Chrome не читают, но и не ломаются.
  const Metadata = (globalThis as { MediaMetadata?: new (init: CallMetadata) => unknown }).MediaMetadata;
  return Metadata ? new Metadata(data) : data;
}

export class SystemControls {
  private installed = new Set<SystemAction>();
  private microphone: boolean | null = null;
  private camera: boolean | null = null;
  private disposed = false;

  constructor(
    handlers: SystemControlsHandlers,
    private readonly session: MediaSessionLike | null = browserSession(),
  ) {
    if (!session) return;
    const map: Record<SystemAction, (() => void) | undefined> = {
      togglemicrophone: handlers.microphone,
      togglecamera: handlers.camera,
      hangup: handlers.hangup,
      enterpictureinpicture: handlers.pictureInPicture,
    };
    for (const action of ACTIONS) {
      const handler = map[action];
      if (!handler) continue;
      try {
        session.setActionHandler(action, () => {
          if (!this.disposed) handler();
        });
        this.installed.add(action);
      } catch {
        /* Этот браузер такого действия не знает — кнопки просто не будет. */
      }
    }
  }

  /** Какие действия браузер принял. */
  get actions(): ReadonlySet<SystemAction> {
    return this.installed;
  }

  describe(data: CallMetadata) {
    if (!this.session || this.disposed) return;
    try {
      this.session.metadata = makeMetadata(data);
    } catch {
      /* Метаданные — украшение; без них кнопки работают так же. */
    }
  }

  /** Что сейчас включено — чтобы значки системы не врали после нажатия в нашем пульте. */
  reflect(state: { microphone: boolean; camera: boolean }) {
    const session = this.session;
    if (!session || this.disposed) return;
    if (state.microphone !== this.microphone) {
      this.microphone = state.microphone;
      try {
        void Promise.resolve(session.setMicrophoneActive?.(state.microphone)).catch(() => {});
      } catch {
        /* Safari до 18.4 метода не знает. */
      }
    }
    if (state.camera !== this.camera) {
      this.camera = state.camera;
      try {
        void Promise.resolve(session.setCameraActive?.(state.camera)).catch(() => {});
      } catch {
        /* Так же. */
      }
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const session = this.session;
    if (!session) return;
    for (const action of this.installed) {
      try {
        session.setActionHandler(action, null);
      } catch {
        /* Снимать нечего. */
      }
    }
    this.installed.clear();
    try {
      session.metadata = null;
    } catch {
      /* Так же. */
    }
  }
}
