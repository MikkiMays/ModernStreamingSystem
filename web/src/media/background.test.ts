import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AudioWaker,
  backgroundAdvice,
  FROZEN_GAP_MS,
  GAP_WORTH_TELLING_MS,
  HEARTBEAT_MS,
  MicInterruptions,
  PageLifecycle,
  RESUME_WAIT_MS,
  ScreenWake,
  wantsWakeLock,
  type LifecycleEnvironment,
  type ReturnInfo,
  type WakeLockApi,
} from './background';
import type { Platform } from './platform';

const IOS_SAFARI: Platform = { os: 'ios', mobile: true, standalone: false, app: false };
const IOS_HOME: Platform = { os: 'ios', mobile: true, standalone: true, app: false };
const ANDROID: Platform = { os: 'android', mobile: true, standalone: false, app: false };
const ANDROID_APP: Platform = { os: 'android', mobile: true, standalone: false, app: true };
const DESKTOP: Platform = { os: 'other', mobile: false, standalone: false, app: false };

afterEach(() => {
  vi.useRealTimers();
});

function page() {
  let clock = 0;
  let heartbeat: (() => void) | undefined;
  const document = Object.assign(new EventTarget(), { hidden: false });
  const window = new EventTarget();
  const env: LifecycleEnvironment = {
    document,
    window,
    now: () => clock,
    setInterval: (callback) => {
      heartbeat = callback;
      return 1;
    },
    clearInterval: () => {
      heartbeat = undefined;
    },
  };
  const hidden = vi.fn();
  const returned = vi.fn<(info: ReturnInfo) => void>();
  const lifecycle = new PageLifecycle({ hidden, returned }, env);
  const transition = (type: 'pagehide' | 'pageshow', persisted: boolean) =>
    window.dispatchEvent(Object.assign(new Event(type), { persisted }));
  return {
    lifecycle,
    hidden,
    returned,
    /** Прошло время; тики сердца — только если страница не стояла. */
    advance(ms: number, ticking = true) {
      if (!ticking) {
        clock += ms;
        return;
      }
      for (let left = ms; left > 0; left -= HEARTBEAT_MS) {
        clock += Math.min(HEARTBEAT_MS, left);
        heartbeat?.();
      }
    },
    hide() {
      document.hidden = true;
      document.dispatchEvent(new Event('visibilitychange'));
    },
    show() {
      document.hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
    },
    freeze: () => document.dispatchEvent(new Event('freeze')),
    resume: () => document.dispatchEvent(new Event('resume')),
    transition,
    get beating() {
      return heartbeat !== undefined;
    },
  };
}

describe('жизненный цикл страницы: ушли и вернулись', () => {
  it('свернули и развернули: один уход, одно возвращение со временем отсутствия, без заморозки', () => {
    const p = page();
    p.hide();
    p.hide();
    p.advance(30_000);
    p.show();
    expect(p.hidden).toHaveBeenCalledTimes(1);
    expect(p.returned).toHaveBeenCalledWith({ awayMs: 30_000, frozen: false, restored: false });
    expect(p.lifecycle.away).toBe(false);
  });

  it('возвращение без ухода — не событие', () => {
    const p = page();
    p.show();
    expect(p.returned).not.toHaveBeenCalled();
  });

  it('JS стоял (Safari молча усыпил страницу) — по перерыву в тиках это заморозка', () => {
    const p = page();
    p.hide();
    p.advance(4_000);
    p.advance(FROZEN_GAP_MS, false);
    p.show();
    expect(p.returned).toHaveBeenCalledWith(expect.objectContaining({ frozen: true }));
  });

  it('перерыв в тиках замечается и тиком, случившимся до возвращения', () => {
    const p = page();
    p.hide();
    p.advance(FROZEN_GAP_MS + 1_000, false);
    p.advance(HEARTBEAT_MS);
    p.show();
    expect(p.returned).toHaveBeenCalledWith(expect.objectContaining({ frozen: true }));
  });

  it('Chrome: freeze и resume — заморозка; resume скрытой страницы ещё не возвращение', () => {
    const p = page();
    p.hide();
    p.freeze();
    p.resume();
    expect(p.returned).not.toHaveBeenCalled();
    p.show();
    expect(p.returned).toHaveBeenCalledWith(expect.objectContaining({ frozen: true }));
  });

  it('следующий уход начинается заново: прежняя заморозка не наследуется', () => {
    const p = page();
    p.hide();
    p.freeze();
    p.show();
    p.hide();
    p.advance(4_000);
    p.show();
    expect(p.returned).toHaveBeenLastCalledWith({ awayMs: 4_000, frozen: false, restored: false });
  });

  it('bfcache: pagehide с persisted — уход, pageshow с persisted — возвращение из заморозки', () => {
    const p = page();
    p.transition('pagehide', true);
    expect(p.hidden).toHaveBeenCalledTimes(1);
    p.transition('pageshow', true);
    expect(p.returned).toHaveBeenCalledWith(expect.objectContaining({ frozen: true, restored: true }));
  });

  it('pagehide без persisted (выгрузка, перезагрузка) ничего не делает: выход из встречи — не здесь', () => {
    const p = page();
    p.transition('pagehide', false);
    p.transition('pageshow', false);
    expect(p.hidden).not.toHaveBeenCalled();
    expect(p.returned).not.toHaveBeenCalled();
  });

  it('после dispose событий нет и сердце остановлено', () => {
    const p = page();
    p.lifecycle.dispose();
    p.hide();
    p.show();
    expect(p.hidden).not.toHaveBeenCalled();
    expect(p.beating).toBe(false);
  });
});

describe('Wake Lock: когда держать экран', () => {
  const base = { inCall: true, visible: true, video: false, captured: true };

  it('видеозвонок держит экран везде', () => {
    for (const platform of [IOS_SAFARI, ANDROID, ANDROID_APP, DESKTOP])
      expect(wantsWakeLock({ ...base, video: true, platform })).toBe(true);
  });

  it('голосовой разговор с захваченным микрофоном экран не держит: телефон в кармане — нормально', () => {
    expect(wantsWakeLock({ ...base, platform: IOS_SAFARI })).toBe(false);
    expect(wantsWakeLock({ ...base, platform: ANDROID })).toBe(false);
    expect(wantsWakeLock({ ...base, platform: DESKTOP })).toBe(false);
  });

  it('iPhone «Домой» держит экран всегда: там погасший экран глушит микрофон', () => {
    expect(wantsWakeLock({ ...base, platform: IOS_HOME })).toBe(true);
  });

  it('телефон без захвата микрофона держит экран: вкладку в фоне не защищает ничто', () => {
    expect(wantsWakeLock({ ...base, captured: false, platform: ANDROID })).toBe(true);
    expect(wantsWakeLock({ ...base, captured: false, platform: DESKTOP })).toBe(false);
  });

  it('в приложении Cord фон держит своя служба — экран только для видео', () => {
    expect(wantsWakeLock({ ...base, captured: false, platform: ANDROID_APP })).toBe(false);
  });

  it('вне встречи и на скрытой странице — никогда', () => {
    expect(wantsWakeLock({ ...base, video: true, inCall: false, platform: ANDROID })).toBe(false);
    expect(wantsWakeLock({ ...base, video: true, visible: false, platform: ANDROID })).toBe(false);
  });
});

describe('что сказать про фон', () => {
  it('по платформе и захвату', () => {
    expect(backgroundAdvice(IOS_SAFARI, true)).toBe('ios-safari');
    expect(backgroundAdvice(ANDROID, true)).toBe('android');
    expect(backgroundAdvice(ANDROID, false)).toBe('no-microphone');
    expect(backgroundAdvice(IOS_SAFARI, false)).toBe('no-microphone');
    expect(backgroundAdvice(ANDROID_APP, false)).toBe('app');
    expect(backgroundAdvice(DESKTOP, false)).toBeNull();
  });

  it('iPhone «Домой» — первым: там и с микрофоном фон не держится', () => {
    expect(backgroundAdvice(IOS_HOME, true)).toBe('ios-home');
    expect(backgroundAdvice(IOS_HOME, false)).toBe('ios-home');
  });
});

function wakeLock() {
  const sentinels: { released: boolean; release: ReturnType<typeof vi.fn> }[] = [];
  const api: WakeLockApi = {
    request: vi.fn(async () => {
      const sentinel = {
        released: false,
        release: vi.fn(async () => {
          sentinel.released = true;
        }),
      };
      sentinels.push(sentinel);
      return sentinel;
    }),
  };
  return { api, sentinels };
}

describe('ScreenWake', () => {
  it('берёт блокировку один раз и отпускает, когда расхотели', async () => {
    const { api, sentinels } = wakeLock();
    const wake = new ScreenWake(api, () => true);
    wake.want(true);
    wake.want(true);
    await vi.waitFor(() => expect(wake.held).toBe(true));
    expect(api.request).toHaveBeenCalledTimes(1);
    wake.want(false);
    await vi.waitFor(() => expect(sentinels[0]!.release).toHaveBeenCalled());
    expect(wake.held).toBe(false);
  });

  it('браузер отпустил блокировку на скрытой странице — по возвращении она берётся снова', async () => {
    const { api, sentinels } = wakeLock();
    let visible = true;
    const wake = new ScreenWake(api, () => visible);
    wake.want(true);
    await vi.waitFor(() => expect(wake.held).toBe(true));
    visible = false;
    sentinels[0]!.released = true;
    wake.refresh();
    await Promise.resolve();
    expect(api.request).toHaveBeenCalledTimes(1);
    visible = true;
    wake.refresh();
    await vi.waitFor(() => expect(api.request).toHaveBeenCalledTimes(2));
  });

  it('расхотели, пока ждали ответа, — отпускает сразу по приходе', async () => {
    const { api, sentinels } = wakeLock();
    const wake = new ScreenWake(api, () => true);
    wake.want(true);
    wake.want(false);
    await vi.waitFor(() => expect(sentinels[0]?.release).toHaveBeenCalled());
    expect(wake.held).toBe(false);
  });

  it('отказ браузера — не ошибка; без API — ничего', async () => {
    const refused = new ScreenWake({ request: vi.fn(async () => Promise.reject(new Error('NotAllowed'))) });
    refused.want(true);
    await Promise.resolve();
    expect(refused.held).toBe(false);
    const none = new ScreenWake(null);
    none.want(true);
    expect(none.supported).toBe(false);
  });
});

describe('когда телефон глушил микрофон', () => {
  it('один перерыв: с и до', () => {
    const gaps = new MicInterruptions();
    gaps.muted(1_000, true);
    gaps.unmuted(61_000);
    expect(gaps.take(70_000)).toEqual({ from: 1_000, to: 61_000 });
    expect(gaps.take(80_000)).toBeNull();
  });

  it('несколько перерывов — от начала первого до конца последнего', () => {
    const gaps = new MicInterruptions();
    gaps.muted(1_000, true);
    gaps.unmuted(10_000);
    gaps.muted(20_000, true);
    gaps.unmuted(40_000);
    expect(gaps.take(50_000)).toEqual({ from: 1_000, to: 40_000 });
  });

  it('микрофон так и не вернулся — конца нет, и перерыв остаётся открытым', () => {
    const gaps = new MicInterruptions();
    gaps.muted(1_000, true);
    expect(gaps.take(30_000)).toEqual({ from: 1_000, to: null });
    gaps.unmuted(40_000);
    expect(gaps.take(41_000)).toEqual({ from: 1_000, to: 40_000 });
  });

  it('короткий сбой и заглушённый самим человеком микрофон — не новость', () => {
    const gaps = new MicInterruptions();
    gaps.muted(1_000, true);
    gaps.unmuted(1_000 + GAP_WORTH_TELLING_MS - 1);
    gaps.muted(5_000, false);
    gaps.unmuted(60_000);
    expect(gaps.take(70_000)).toBeNull();
  });

  it('человек выключил микрофон сам — открытый перерыв забывается', () => {
    const gaps = new MicInterruptions();
    gaps.muted(1_000, true);
    gaps.forget();
    expect(gaps.take(60_000)).toBeNull();
  });
});

function audioContext(state: string, wakes: boolean) {
  const context = Object.assign(new EventTarget(), {
    state,
    resume: vi.fn(() => {
      if (!wakes) return new Promise<void>(() => {});
      context.state = 'running';
      context.dispatchEvent(new Event('statechange'));
      return Promise.resolve();
    }),
  });
  return context;
}

describe('будильник звука собеседников', () => {
  it('разбудил — кнопка не нужна', async () => {
    const context = audioContext('suspended', true);
    const waker = new AudioWaker(context, () => true, null);
    expect(await waker.wake()).toBe(true);
    expect(waker.blocked.get()).toBe(false);
  });

  it('Safari без жеста держит resume висеть — через паузу показываем кнопку, а касание будит', async () => {
    vi.useFakeTimers();
    const context = audioContext('interrupted', false);
    const gestures = new EventTarget();
    const waker = new AudioWaker(context, () => true, gestures);
    const woke = waker.wake();
    await vi.advanceTimersByTimeAsync(RESUME_WAIT_MS);
    expect(await woke).toBe(false);
    expect(waker.blocked.get()).toBe(true);
    context.resume.mockImplementation(() => {
      context.state = 'running';
      context.dispatchEvent(new Event('statechange'));
      return Promise.resolve();
    });
    gestures.dispatchEvent(new Event('touchend'));
    await vi.advanceTimersByTimeAsync(0);
    expect(waker.blocked.get()).toBe(false);
  });

  it('скрытой странице кнопку не показывает', async () => {
    vi.useFakeTimers();
    const waker = new AudioWaker(audioContext('suspended', false), () => false, null);
    const woke = waker.wake();
    await vi.advanceTimersByTimeAsync(RESUME_WAIT_MS);
    await woke;
    expect(waker.blocked.get()).toBe(false);
  });

  it('контекст уснул сам (обычный звонок) — будит без нашего вызова', async () => {
    const context = audioContext('running', true);
    const waker = new AudioWaker(context, () => true, null);
    context.state = 'interrupted';
    context.dispatchEvent(new Event('statechange'));
    await vi.waitFor(() => expect(context.resume).toHaveBeenCalled());
    expect(waker.running).toBe(true);
  });

  it('без контекста (WebAudio нет) — звук «идёт»', async () => {
    const waker = new AudioWaker(null, () => true, null);
    expect(await waker.wake()).toBe(true);
  });
});
