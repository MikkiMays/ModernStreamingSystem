import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Watch } from '../../../api/types';
import type { CinemaApi, CinemaSource } from '../../../core/cinema';
import { pendingFailures, resetFailures } from '../../../core/failure';
import type { Meeting } from '../../../core/meeting';
import type { Preferences } from '../../../core/preferences';
import { Store } from '../../../core/store';
import type { Playhead } from './playhead';
import { usePlayback } from './usePlayback';
import type { Echo } from './useRoomSync';

/*
  Сторож застрявшего плеера в сборе (R216): позиция стоит при полном буфере — толчок, потом поток заново,
  потом честный отказ; каждое застревание — в счётчик ядра. Сам порядок ступеней — `stall.test.ts`.
*/

const WATCH: Watch = {
  provider: 'youtube',
  kind: 'video',
  contentId: 'aqz-KE-bpKQ',
  title: null,
  openedBy: 'me',
  paused: false,
  positionMs: 0,
  anchorAt: 0,
  revision: 1,
};

const file = (url: string): CinemaSource => ({
  provider: 'youtube',
  contentId: 'aqz-KE-bpKQ',
  title: 'Big Buck Bunny',
  author: '',
  duration: 635,
  live: false,
  kind: 'file',
  url,
  expiresAt: Date.now() + 3600_000,
  notice: null,
  language: 'en',
  captions: [],
  poster: null,
});

function setup() {
  const resolve = vi.fn((_p: string, _c: string, _k: string, options?: { refresh?: boolean }) =>
    Promise.resolve(file(options?.refresh ? `/fetch?n=${resolve.mock.calls.length}` : '/fetch?first')),
  );
  const api = { resolve } as unknown as CinemaApi;
  const meeting = {
    media: { deafened: new Store(false), saveSettings: vi.fn() },
  } as unknown as Meeting;
  const element = document.createElement('video');
  let position = 12;
  Object.defineProperty(element, 'currentTime', {
    configurable: true,
    get: () => position,
    set: (value: number) => {
      position = value;
    },
  });
  // Загружено далеко вперёд, а позиция стоит: это конвейер (декодер), а не сеть.
  Object.defineProperty(element, 'buffered', {
    configurable: true,
    value: { length: 1, start: () => 0, end: () => 60 },
  });
  let still = 0;
  const playhead = {
    stalledMs: () => still,
    playedMs: () => (still ? 0 : 5000),
    audioStalled: false,
  } as unknown as Playhead;
  const echo: Echo = { suppress: vi.fn(), quiet: () => false };
  const hook = renderHook(() =>
    usePlayback({
      meeting,
      api,
      watch: WATCH,
      video: { current: element },
      echo,
      preferences: { watchVolume: 70, watchAudio: '' } as Preferences,
      playhead,
    }),
  );
  return {
    hook,
    resolve,
    echo,
    position: () => position,
    stall: (ms: number) => {
      still = ms;
    },
  };
}

const pass = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => {
  vi.useFakeTimers();
  resetFailures();
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('сторож застрявшего плеера в usePlayback (R216)', () => {
  it('буфер полон, позиция стоит: толчок, поток заново, а через 40 с застревания — отказ с кнопкой', async () => {
    const room = setup();
    await pass(0);
    expect(room.hook.result.current.source?.url).toBe('/fetch?first');
    act(() => room.hook.result.current.setStatus('ready'));

    room.stall(2500);
    await pass(500);
    // Толчок: у файла своего лечения нет — позиция двигается на 50 мс, и это не человек.
    expect(room.position()).toBeCloseTo(12.05, 6);
    expect(room.echo.suppress).toHaveBeenCalledWith(4000);
    expect(pendingFailures()).toEqual([{ place: 'cinema', code: 'cinema-stalled', count: 1 }]);

    room.stall(15_000);
    await pass(1000);
    // Пересборки у файла нет — дальше по лестнице: поток открывается заново, с `refresh`.
    expect(room.resolve).toHaveBeenCalledTimes(2);
    expect(room.resolve.mock.calls[1]![3]).toMatchObject({ refresh: true, adaptive: false });
    expect(room.hook.result.current.source?.url).toBe('/fetch?n=2');

    // Новый поток — новая лестница; не пошло и там — после второго и третьего «заново» честный отказ.
    for (const url of ['/fetch?n=3']) {
      act(() => room.hook.result.current.setStatus('ready'));
      room.stall(15_000);
      await pass(1500);
      expect(room.hook.result.current.source?.url).toBe(url);
    }
    act(() => room.hook.result.current.setStatus('ready'));
    room.stall(15_000);
    await pass(1500);
    expect(room.hook.result.current.status).toBe('failed');
    expect(room.hook.result.current.error).toBe('Видео не грузится. Проверьте сеть и попробуйте ещё раз');
    expect(pendingFailures()).toContainEqual({ place: 'cinema', code: 'cinema-heal-failed', count: 1 });
  });

  it('картинка пошла после лечения — застревание кончилось, и счётчик знает, что вылечили', async () => {
    const room = setup();
    await pass(0);
    act(() => room.hook.result.current.setStatus('ready'));
    room.stall(3000);
    await pass(500);
    room.stall(0);
    await pass(500);
    expect(pendingFailures()).toEqual([
      { place: 'cinema', code: 'cinema-stalled', count: 1 },
      { place: 'cinema', code: 'cinema-healed', count: 1 },
    ]);
  });

  it('пока плеер открывается, сторож его не толкает, но и «Открываем…» вечно не висит', async () => {
    const room = setup();
    await pass(0);
    room.stall(30_000);
    await pass(2000);
    expect(room.resolve).toHaveBeenCalledTimes(1);
    expect(room.position()).toBe(12);
    // Первого кадра нет 25 с — поток заново; и ещё раз; дальше — отказ с «Повторить».
    await pass(23_000);
    expect(room.resolve).toHaveBeenCalledTimes(2);
    await pass(25_000);
    expect(room.resolve).toHaveBeenCalledTimes(3);
    await pass(25_000);
    expect(room.hook.result.current.status).toBe('failed');
    expect(room.hook.result.current.error).toBe('Видео не грузится. Проверьте сеть и попробуйте ещё раз');
  });
});
