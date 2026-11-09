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

function setup({ buffered = true }: { buffered?: boolean } = {}) {
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
    value: buffered
      ? { length: 1, start: () => 0, end: () => 60 }
      : { length: 0, start: () => 0, end: () => 0 },
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
  it('буфер полон, позиция стоит: толчок, поток заново без нового разбора, потом — отказ с кнопкой', async () => {
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
    // Ступени — не чаще раза в 2 с, сколько бы ни стояло: каждой — время показать, помогла ли она.
    await pass(1500);
    const first = room.hook.result.current.source;
    await pass(2500);
    /*
      Пересборки у файла нет — дальше по лестнице: поток заново. Данные впереди есть — встал конвейер, и
      площадка ни при чём: новый движок на том же адресе, без нового разбора (каждый разбор YouTube — это
      запросы yt-dlp с адреса сервера).
    */
    expect(room.resolve).toHaveBeenCalledTimes(1);
    expect(room.hook.result.current.source).not.toBe(first);
    expect(room.hook.result.current.source?.url).toBe('/fetch?first');

    // Новый движок — новая лестница; не пошло и там — после второго «заново» честный отказ.
    act(() => room.hook.result.current.setStatus('ready'));
    room.stall(15_000);
    await pass(5000);
    expect(room.resolve).toHaveBeenCalledTimes(1);
    act(() => room.hook.result.current.setStatus('ready'));
    room.stall(15_000);
    await pass(5000);
    expect(room.hook.result.current.status).toBe('failed');
    expect(room.hook.result.current.error).toBe('Видео не грузится. Проверьте сеть и попробуйте ещё раз');
    expect(pendingFailures()).toContainEqual({ place: 'cinema', code: 'cinema-heal-failed', count: 1 });
    // Движок под отказом ожил сам — картинка идёт, отказ снимается, а не висит поверх фильма.
    room.stall(0);
    await pass(500);
    expect(room.hook.result.current.status).toBe('ready');
    expect(room.hook.result.current.error).toBe('');
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

  it('данных нет — поток заново новым разбором у площадки', async () => {
    const room = setup({ buffered: false });
    await pass(0);
    act(() => room.hook.result.current.setStatus('ready'));
    room.stall(30_000);
    await pass(8000);
    expect(room.resolve).toHaveBeenCalledTimes(2);
    expect(room.resolve.mock.calls[1]![3]).toMatchObject({ refresh: true, adaptive: false });
    expect(room.hook.result.current.source?.url).toBe('/fetch?n=2');
  });

  it('скрытая вкладка и пропавшая сеть — не повод лечить: ни толчков, ни переоткрытий, ни отказа', async () => {
    const room = setup();
    await pass(0);
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    // «Открываем…» в скрытой вкладке: срок первого кадра не идёт.
    await pass(60_000);
    expect(room.resolve).toHaveBeenCalledTimes(1);
    act(() => room.hook.result.current.setStatus('ready'));
    room.stall(30_000);
    await pass(10_000);
    expect(room.position()).toBe(12);
    hidden.mockReturnValue(false);
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await pass(10_000);
    expect(room.position()).toBe(12);
    expect(room.resolve).toHaveBeenCalledTimes(1);
    expect(room.hook.result.current.status).toBe('ready');
    // Сеть вернулась — лестница продолжает.
    online.mockReturnValue(true);
    await pass(500);
    expect(room.position()).toBeCloseTo(12.05, 6);
  });

  it('отказ, а потом сеть вернулась — пробуем сами; «Повторить» сразу показывает «Открываем…»', async () => {
    const room = setup();
    await pass(0);
    // Отказ при сети (поток сломан) — возвращение сети его не трогает: лишний разбор у площадки ни к чему.
    act(() => room.hook.result.current.setStatus('failed'));
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(room.resolve).toHaveBeenCalledTimes(1);
    act(() => room.hook.result.current.setStatus('ready'));
    // Отказ без сети — сеть вернулась, пробуем сами.
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    act(() => {
      room.hook.result.current.setStatus('failed');
      room.hook.result.current.setError('Видео не грузится');
    });
    online.mockReturnValue(true);
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(room.resolve).toHaveBeenCalledTimes(2);
    expect(room.resolve.mock.calls[1]![3]).toMatchObject({ refresh: true });

    act(() => room.hook.result.current.setStatus('failed'));
    act(() => room.hook.result.current.retry());
    expect(room.hook.result.current.status).toBe('loading');
    await pass(0);
    expect(room.resolve).toHaveBeenCalledTimes(3);
  });
});
