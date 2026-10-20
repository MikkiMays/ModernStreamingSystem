/**
 * Разговор в фоне: что страница может сделать сама, когда телефон убрали в карман (E12, T16).
 *
 * Разбор платформ — `docs/mobile.md`. Коротко: разговор в фоне держит **живой захват микрофона**
 * (Android Chrome поднимает на него свой foreground service, Safari оставляет аудиосессию), а не
 * Wake Lock и не service worker. Поэтому здесь нет ни «тихого звука для карточки», ни попыток
 * удержать процесс — только то, что действительно работает:
 *
 * 1. **Ничего не рвать при уходе с экрана.** Дорожки, подписки и соединение остаются как были;
 *    окно восстановления придерживается (`RecoveryWindow.hold`), камеру в фоне гасит сама ОС и
 *    `livekit-client` и сам же поднимает её по возвращении.
 * 2. **Быстро вернуться.** Браузер мог заморозить страницу (Chrome — событием `freeze`, Safari —
 *    молча). Замороженный сигнальный сокет SDK ещё считает живым до таймаута пинга, поэтому по
 *    возвращении из заморозки сразу просим бесшовный resume (`reconnect-plan.ts`, T50), будим звук
 *    (`AudioContext` после фона и после обычного звонка стоит в `suspended`/`interrupted`) и
 *    перечитываем комнату.
 * 3. **Не давать экрану гаснуть там, где это и есть конец разговора** — Wake Lock ({@link wantsWakeLock}).
 * 4. **Честно сказать, где платформа разговор не удержит** ({@link backgroundAdvice}).
 */
import type { Platform } from './platform';
import { Store } from '../core/store';

/**
 * Перерыв в тиках таймера, после которого страницу считаем замороженной.
 *
 * Скрытая вкладка с живым WebRTC не попадает под «интенсивное» троттлинг таймеров (раз в минуту),
 * обычное — раз в секунду. Перерыв в десять секунд значит, что JS не исполнялся вовсе: страницу
 * заморозили или ОС усыпила процесс. Так замечается и Safari, где события `freeze` нет.
 */
export const FROZEN_GAP_MS = 10_000;
/** Как часто страница отмечается «я жива». Дёшево: одно сравнение раз в две секунды. */
export const HEARTBEAT_MS = 2_000;

export interface ReturnInfo {
  /** Сколько страница не была на экране. */
  awayMs: number;
  /** JS стоял: событие `freeze`, перерыв в тиках или возвращение из bfcache. */
  frozen: boolean;
  /** Страницу вернули из bfcache (`pageshow` с `persisted`). */
  restored: boolean;
}

export interface LifecycleTarget {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

export interface LifecycleEnvironment {
  document: LifecycleTarget & { readonly hidden: boolean };
  window: LifecycleTarget;
  now: () => number;
  setInterval: (callback: () => void, ms: number) => unknown;
  clearInterval: (id: unknown) => void;
}

const browserEnvironment = (): LifecycleEnvironment => ({
  document,
  window,
  now: () => performance.now(),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
});

/**
 * Жизненный цикл страницы, сведённый к двум событиям: «ушли» и «вернулись».
 *
 * `visibilitychange` — экран погас, браузер свёрнут, открыта другая вкладка. `freeze`/`resume`
 * (Chrome, Page Lifecycle) — страницу остановили целиком. `pagehide`/`pageshow` с `persisted` —
 * страница ушла в bfcache и вернулась оттуда; без `persisted` `pagehide` — это выгрузка, и
 * делать на ней ничего не нужно: перезагрузка возвращает во встречу тем же участником, а выход
 * без слов досчитает сервер. Выход из встречи на `pagehide` здесь нарочно не шлётся — на телефоне
 * он приходит и тогда, когда человек просто переключился на другое приложение.
 */
export class PageLifecycle {
  private hiddenAt: number | null = null;
  private frozen = false;
  private restored = false;
  private lastTick: number;
  private timer: unknown;
  private disposed = false;

  constructor(
    private readonly handlers: { hidden?: () => void; returned?: (info: ReturnInfo) => void },
    private readonly env: LifecycleEnvironment = browserEnvironment(),
  ) {
    this.lastTick = env.now();
    if (env.document.hidden) this.hiddenAt = this.lastTick;
    env.document.addEventListener('visibilitychange', this.visibility);
    env.document.addEventListener('freeze', this.freeze);
    env.document.addEventListener('resume', this.resume);
    env.window.addEventListener('pagehide', this.pagehide);
    env.window.addEventListener('pageshow', this.pageshow);
    this.timer = env.setInterval(this.tick, HEARTBEAT_MS);
  }

  /** Страница сейчас не на экране. */
  get away() {
    return this.hiddenAt !== null;
  }

  private tick = () => {
    const now = this.env.now();
    if (now - this.lastTick >= FROZEN_GAP_MS && this.hiddenAt !== null) this.frozen = true;
    this.lastTick = now;
  };

  private leave() {
    if (this.hiddenAt !== null) return;
    this.hiddenAt = this.env.now();
    this.frozen = false;
    this.restored = false;
    this.handlers.hidden?.();
  }

  private back() {
    if (this.hiddenAt === null || this.env.document.hidden) return;
    const now = this.env.now();
    // Тик мог не успеть случиться после заморозки: перерыв видно и отсюда.
    if (now - this.lastTick >= FROZEN_GAP_MS) this.frozen = true;
    const info: ReturnInfo = { awayMs: now - this.hiddenAt, frozen: this.frozen, restored: this.restored };
    this.hiddenAt = null;
    this.frozen = false;
    this.restored = false;
    this.lastTick = now;
    this.handlers.returned?.(info);
  }

  private visibility = () => {
    if (this.disposed) return;
    if (this.env.document.hidden) this.leave();
    else this.back();
  };

  private freeze = () => {
    if (this.disposed) return;
    this.leave();
    this.frozen = true;
  };

  private resume = () => {
    if (this.disposed) return;
    this.frozen = true;
    // `resume` приходит и для скрытой страницы (её разморозили, чтобы доставить событие):
    // «вернулись» — только когда она снова на экране.
    this.back();
  };

  private pagehide = (event: Event) => {
    if (this.disposed || !(event as PageTransitionEvent).persisted) return;
    this.leave();
  };

  private pageshow = (event: Event) => {
    if (this.disposed || !(event as PageTransitionEvent).persisted) return;
    this.frozen = true;
    this.restored = true;
    this.back();
  };

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.env.clearInterval(this.timer);
    this.env.document.removeEventListener('visibilitychange', this.visibility);
    this.env.document.removeEventListener('freeze', this.freeze);
    this.env.document.removeEventListener('resume', this.resume);
    this.env.window.removeEventListener('pagehide', this.pagehide);
    this.env.window.removeEventListener('pageshow', this.pageshow);
  }
}

export interface WakeLockInputs {
  /** Встреча идёт: медиа подключено или восстанавливается. */
  inCall: boolean;
  /** Страница на экране. Скрытой странице Wake Lock не дают, и он отпускается сам. */
  visible: boolean;
  /** В разговоре есть картинка: своя камера, чужая камера или демонстрация. */
  video: boolean;
  /** Микрофон захвачен (включён или удержан выключенным, `MediaSession.holdMicrophone`). */
  captured: boolean;
  platform: Platform;
}

/**
 * Держать ли экран включённым.
 *
 * Wake Lock держит **экран**, не процесс, и в фоне не помогает ничем. Зато он не даёт экрану
 * погаснуть по таймеру бездействия, а погасший экран — это уход в фон со всеми последствиями:
 * - **видеозвонок** — камеру в фоне ОС выключает, а картинку собеседника не показать: экран при
 *   видео держат включённым все звонилки, и ручная блокировка остаётся в руках человека;
 * - **iPhone, экран «Домой»** — там микрофон глушится сразу при уходе с экрана (`docs/mobile.md` §2);
 * - **телефон без захвата микрофона** (доступ не дали) — вкладку в фоне не держит ничто.
 *
 * Голосовой разговор с захваченным микрофоном экран не держит: телефон в кармане — нормальный
 * разговор, его держит ОС. В приложении Cord фон держит своя служба, поэтому там — только видео.
 */
export function wantsWakeLock(inputs: WakeLockInputs): boolean {
  if (!inputs.inCall || !inputs.visible) return false;
  if (inputs.video) return true;
  if (inputs.platform.app) return false;
  // WebView Telegram в фоне не защищено ничем — погасший экран там и есть конец разговора.
  if (inputs.platform.telegram && inputs.platform.mobile) return true;
  if (inputs.platform.os === 'ios' && inputs.platform.standalone) return true;
  return inputs.platform.mobile && !inputs.captured;
}

/**
 * Что сказать человеку про разговор в фоне на этой платформе (W7 в `docs/mobile.md` §3).
 *
 * - `ios-safari` — держится, пока включён захват микрофона; камера в фоне выключается;
 * - `ios-home` — веб-приложение «Домой»: микрофон глушится при уходе с экрана, лучше Safari;
 * - `android` — держится, пока в шторке «… использует микрофон»;
 * - `no-microphone` — телефон без захвата: фон не защищён ничем;
 * - `telegram` — Mini App: фоном распоряжается Telegram, разговор держится, пока Telegram открыт;
 * - `app` — приложение Cord: держит своя служба, говорить не о чем;
 * - `null` — ПК: фон не вопрос.
 */
export type BackgroundAdvice =
  'ios-safari' | 'ios-home' | 'android' | 'no-microphone' | 'telegram' | 'app' | null;

export function backgroundAdvice(platform: Platform, captured: boolean): BackgroundAdvice {
  if (!platform.mobile) return null;
  if (platform.app) return 'app';
  if (platform.telegram) return 'telegram';
  // «Домой» — первым: там и с микрофоном разговор в фоне не держится.
  if (platform.os === 'ios' && platform.standalone) return 'ios-home';
  if (!captured) return 'no-microphone';
  return platform.os === 'ios' ? 'ios-safari' : 'android';
}

interface WakeLockSentinelLike {
  readonly released: boolean;
  release(): Promise<void>;
}

export interface WakeLockApi {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

/**
 * Wake Lock экрана по желанию: `want(true)` — держать, пока страница на экране; `want(false)` —
 * отпустить. Скрытая страница теряет блокировку сама, поэтому возвращение берёт её снова.
 */
export class ScreenWake {
  private wanted = false;
  private sentinel: WakeLockSentinelLike | null = null;
  private pending: Promise<void> | null = null;

  constructor(
    private readonly api: WakeLockApi | null = (typeof navigator !== 'undefined' &&
      (navigator as { wakeLock?: WakeLockApi }).wakeLock) ||
      null,
    private readonly visible: () => boolean = () => typeof document === 'undefined' || !document.hidden,
  ) {}

  get supported() {
    return this.api !== null;
  }

  get held() {
    return !!this.sentinel && !this.sentinel.released;
  }

  want(on: boolean) {
    this.wanted = on;
    void this.sync();
  }

  /** Страница вернулась на экран: блокировка, отпущенная браузером, берётся снова. */
  refresh() {
    void this.sync();
  }

  private async sync(): Promise<void> {
    if (!this.api) return;
    // Запросы по одному: два параллельных `request` дали бы две блокировки, и одна осталась бы висеть.
    while (this.pending) await this.pending;
    if (this.wanted && this.visible() && !this.held) {
      this.pending = this.api
        .request('screen')
        .then((sentinel) => {
          this.sentinel = sentinel;
        })
        .catch(() => {
          // Отказ — нормален: экономия батареи, нет жеста, политика. Экран просто погаснет как обычно.
        })
        .finally(() => {
          this.pending = null;
        });
      await this.pending;
    }
    // Пока ждали ответа, держать могли расхотеть — тогда отпустить сразу.
    if (!this.wanted) await this.release();
  }

  private async release() {
    const sentinel = this.sentinel;
    this.sentinel = null;
    if (sentinel && !sentinel.released) await sentinel.release().catch(() => {});
  }

  dispose() {
    this.wanted = false;
    void this.sync();
  }
}

/** Перерыв захвата короче этого — не новость: так выглядит смена устройства или сбой драйвера. */
export const GAP_WORTH_TELLING_MS = 2_000;

/** Отрезок, когда микрофон был включён у человека, но телефон не давал с него звук. */
export interface MicGap {
  /** Начало, по `Date.now()`: показывается часами. */
  from: number;
  /** Конец; `null` — телефон так и не вернул микрофон. */
  to: number | null;
}

/**
 * Когда ОС глушила микрофон, который человек оставил включённым (W4, `docs/mobile.md` §3).
 *
 * Худший случай iPhone с экрана «Домой»: человек свернул встречу, говорит — а его не слышно, и
 * ни он, ни собеседник не знают почему. ОС сообщает об этом событием `mute` у `MediaStreamTrack`
 * (не путать с выключением кнопкой: там `enabled = false`, и событий нет). Здесь отрезки копятся,
 * а по возвращении на экран {@link take} отдаёт один отрезок «с … по …» для плашки.
 */
export class MicInterruptions {
  private open: number | null = null;
  private closed: MicGap[] = [];

  /** ОС заглушила захват. `wanted` — микрофон включён у человека: иначе его и так не слышно. */
  muted(at: number, wanted: boolean) {
    if (wanted && this.open === null) this.open = at;
  }

  unmuted(at: number) {
    if (this.open === null) return;
    if (at - this.open >= GAP_WORTH_TELLING_MS) this.closed.push({ from: this.open, to: at });
    this.open = null;
  }

  /** Человек сам выключил микрофон: дальше тишина — его выбор, а не телефона. */
  forget() {
    this.open = null;
  }

  /**
   * Что рассказать: от начала первого перерыва до конца последнего. Незакрытый перерыв остаётся
   * открытым и после рассказа — он продолжается, и его конец ещё придёт.
   */
  take(now: number): MicGap | null {
    const open = this.open !== null && now - this.open >= GAP_WORTH_TELLING_MS ? this.open : null;
    if (!this.closed.length && open === null) return null;
    const first = this.closed[0];
    const last = this.closed[this.closed.length - 1];
    this.closed = [];
    return { from: first ? first.from : open!, to: open !== null ? null : last!.to };
  }
}

interface AudioContextLike {
  readonly state: string;
  resume(): Promise<void>;
  addEventListener(type: 'statechange', listener: () => void): void;
  removeEventListener(type: 'statechange', listener: () => void): void;
}

/** Столько ждём `resume()`: без жеста Safari оставляет обещание висеть, а не отказывает. */
export const RESUME_WAIT_MS = 300;

/**
 * События, в которых браузер считает нажатие жестом человека и разрешает звук. `pointerdown` касанием
 * жестом не считается (только `pointerup`/`touchend`), а WebKit исторически будит звук на `touchend` и
 * `click` — слушаем всё: лишний вызов на работающем контексте ничего не делает.
 */
const GESTURES = ['pointerup', 'touchend', 'click', 'keydown'] as const;

/**
 * Будильник звука собеседников.
 *
 * Чужой звук у нас идёт через WebAudio (`webAudioMix`), и после фона, обычного звонка или Siri
 * `AudioContext` стоит в `suspended` или `interrupted` (iOS) — собеседник «пропал», хотя связь жива.
 * Разбудить его можно `resume()`, а без жеста человека Safari этого не даёт. Поэтому будим на каждом
 * поводе — возвращение на экран, смена состояния, любое касание страницы, — а если не вышло,
 * {@link blocked} говорит интерфейсу показать кнопку «Включить звук».
 */
export class AudioWaker {
  readonly blocked: Store<boolean> = new Store<boolean>(false);
  private disposed = false;

  constructor(
    private readonly context: AudioContextLike | null,
    private readonly visible: () => boolean = () => typeof document === 'undefined' || !document.hidden,
    private readonly gestures: LifecycleTarget | null = typeof document !== 'undefined' ? document : null,
  ) {
    context?.addEventListener('statechange', this.changed);
    for (const type of GESTURES) this.gestures?.addEventListener(type, this.gesture);
  }

  get running() {
    return !this.context || this.context.state === 'running';
  }

  /** Попробовать разбудить. `true` — звук идёт. */
  async wake(): Promise<boolean> {
    const context = this.context;
    if (this.disposed || !context || context.state === 'closed') return true;
    if (context.state !== 'running') {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        context.resume().catch(() => {}),
        new Promise((resolve) => {
          timer = setTimeout(resolve, RESUME_WAIT_MS);
        }),
      ]);
      clearTimeout(timer);
    }
    if (this.disposed) return true;
    // Скрытой странице кнопку не показываем: её всё равно никто не нажмёт, а по возвращении
    // будильник попробует ещё раз.
    this.blocked.set(context.state !== 'running' && this.visible());
    return context.state === 'running';
  }

  private changed = () => {
    if (this.disposed || !this.context) return;
    if (this.context.state === 'running') this.blocked.set(false);
    else if (this.context.state !== 'closed' && this.visible()) void this.wake();
  };

  private gesture = () => {
    if (!this.running) void this.wake();
  };

  dispose() {
    this.disposed = true;
    this.blocked.set(false);
    this.context?.removeEventListener('statechange', this.changed);
    for (const type of GESTURES) this.gestures?.removeEventListener(type, this.gesture);
  }
}
