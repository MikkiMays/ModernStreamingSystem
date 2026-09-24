import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Watch } from '../../../api/types';
import type { CinemaApi, CinemaSource } from '../../../core/cinema';
import { useSource } from './useSource';

const NOW = 1_790_000_000_000;

const watch = (patch: Partial<Watch> = {}): Watch => ({
  provider: 'youtube',
  kind: 'video',
  contentId: 'dQw4w9WgXcQ',
  title: null,
  openedBy: 'someone',
  paused: true,
  positionMs: 0,
  anchorAt: NOW,
  revision: 1,
  ...patch,
});

const source = (patch: Partial<CinemaSource> = {}): CinemaSource => ({
  provider: 'youtube',
  contentId: 'dQw4w9WgXcQ',
  title: 'Ролик',
  author: 'Автор',
  duration: 12,
  live: false,
  kind: 'hls',
  url: '/cinema/playlist?sig=1',
  expiresAt: NOW + 5 * 3600 * 1000,
  notice: null,
  language: 'en',
  captions: [],
  poster: null,
  ...patch,
});

/** Ответ службы, который приходит, когда его отпустят. */
function pending<T>() {
  let settle!: (value: T) => void;
  let fail!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  return { promise, settle, fail };
}

function setup(first: CinemaSource | Error = source(), initial = watch()) {
  const resolve = vi.fn((): Promise<CinemaSource> => Promise.reject(new Error('лишний запрос')));
  resolve.mockImplementationOnce(() =>
    first instanceof Error ? Promise.reject(first) : Promise.resolve(first),
  );
  const api = { resolve } as unknown as CinemaApi;
  const echo = { suppress: vi.fn(), quiet: vi.fn(() => false) };
  const renewed = vi.fn();
  const hook = renderHook(({ current }) => useSource(api, current, echo, renewed), {
    initialProps: { current: initial },
  });
  return { hook, resolve, echo, renewed };
}

/** Дождаться ответа службы внутри `act`, чтобы состояние успело обновиться. */
const flush = () => act(async () => {});

afterEach(() => {
  vi.useRealTimers();
});

describe('useSource: адрес потока', () => {
  it('спрашивает службу об открытом видео и отдаёт адрес, не объявляя плеер готовым', async () => {
    const { hook, resolve } = setup();
    expect(hook.result.current.status).toBe('loading');
    await flush();
    expect(resolve).toHaveBeenCalledWith('youtube', 'dQw4w9WgXcQ', 'video');
    expect(hook.result.current.source?.url).toBe('/cinema/playlist?sig=1');
    // «Готов» — это метаданные в `<video>`, а не ответ службы.
    expect(hook.result.current.status).toBe('loading');
  });

  it('отказ службы — её же словами, а без слов — общим текстом', async () => {
    const said = setup(new Error('Площадка не отдала поток для этого видео. Попробуйте другое'));
    await flush();
    expect(said.hook.result.current.status).toBe('failed');
    expect(said.hook.result.current.error).toBe(
      'Площадка не отдала поток для этого видео. Попробуйте другое',
    );
    const silent = setup(new Error(''));
    await flush();
    expect(silent.hook.result.current.error).toBe('Не удалось открыть видео');
  });

  it('за минуту до конца подписи обновляет адрес тем же видом, и вместе с ним — всё, что от него зависело', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { hook, resolve, echo, renewed } = setup(source({ expiresAt: NOW + 10 * 60 * 1000 }));
    await flush();
    const next = source({ url: '/cinema/playlist?sig=2' });
    resolve.mockResolvedValueOnce(next);
    await act(async () => {
      vi.advanceTimersByTime(9 * 60 * 1000 - 1);
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(resolve).toHaveBeenLastCalledWith('youtube', 'dQw4w9WgXcQ', 'video', {
      adaptive: false,
      refresh: true,
    });
    expect(echo.suppress).toHaveBeenCalledOnce();
    expect(renewed).toHaveBeenCalledOnce();
    expect(hook.result.current.source).toBe(next);
    expect(hook.result.current.status).toBe('loading');
  });

  it('у DASH плановое обновление просит DASH же, а просроченная подпись обновляется через секунду', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { resolve } = setup(source({ kind: 'dash', expiresAt: NOW - 1 }));
    await flush();
    resolve.mockResolvedValueOnce(source({ kind: 'dash' }));
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(resolve).toHaveBeenLastCalledWith('youtube', 'dQw4w9WgXcQ', 'video', {
      adaptive: true,
      refresh: true,
    });
  });

  it('HLS: 403/410 обновляет подпись дважды, третий раз — уже дело движка', async () => {
    const { hook, resolve } = setup();
    await flush();
    resolve.mockResolvedValue(source());
    for (let attempt = 0; attempt < 2; attempt++) {
      let taken = false;
      await act(async () => {
        taken = hook.result.current.expired();
      });
      expect(taken).toBe(true);
    }
    expect(resolve).toHaveBeenCalledTimes(3);
    expect(resolve).toHaveBeenLastCalledWith('youtube', 'dQw4w9WgXcQ', 'video', {
      adaptive: true,
      refresh: true,
    });
    expect(hook.result.current.expired()).toBe(false);
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  it('DASH: первый сбой — снова DASH, дальше — совместимый файл; пока обновление идёт, второго нет', async () => {
    const { hook, resolve } = setup(source({ kind: 'dash' }));
    await flush();
    const first = pending<CinemaSource>();
    resolve.mockReturnValueOnce(first.promise);
    act(() => hook.result.current.dashFailed());
    expect(resolve).toHaveBeenLastCalledWith('youtube', 'dQw4w9WgXcQ', 'video', {
      adaptive: true,
      refresh: true,
    });
    act(() => hook.result.current.dashFailed());
    expect(resolve).toHaveBeenCalledTimes(2);
    await act(async () => first.settle(source({ kind: 'dash' })));
    resolve.mockResolvedValueOnce(source({ kind: 'file' }));
    await act(async () => hook.result.current.dashFailed());
    expect(resolve).toHaveBeenLastCalledWith('youtube', 'dQw4w9WgXcQ', 'video', {
      adaptive: false,
      refresh: true,
    });
    expect(hook.result.current.source?.kind).toBe('file');
  });

  it('DASH: сбой во время планового обновления не тратит попытку — следующая снова просит DASH', async () => {
    const { hook, resolve } = setup(source({ kind: 'dash' }));
    await flush();
    const planned = pending<CinemaSource>();
    resolve.mockReturnValueOnce(planned.promise);
    act(() => void hook.result.current.renew(true));
    act(() => hook.result.current.dashFailed());
    expect(resolve).toHaveBeenCalledTimes(2);
    await act(async () => planned.settle(source({ kind: 'dash' })));
    resolve.mockResolvedValueOnce(source({ kind: 'dash' }));
    await act(async () => hook.result.current.dashFailed());
    expect(resolve).toHaveBeenLastCalledWith('youtube', 'dQw4w9WgXcQ', 'video', {
      adaptive: true,
      refresh: true,
    });
  });

  /*
    Решение задачи 8: подпись адреса поменялась вместе со службой, и уже открытый файл отвечал
    403 — плеер стоял на «Поток не открылся» до перезагрузки. Теперь файл получает одну попытку.
  */
  it('файл: первая ошибка — одна попытка с новой подписью того же вида, вторая — честный отказ', async () => {
    const { hook, resolve, renewed } = setup(source({ kind: 'file', url: '/cinema/fetch?sig=old' }));
    await flush();
    const fresh = source({ kind: 'file', url: '/cinema/fetch?sig=new' });
    resolve.mockResolvedValueOnce(fresh);
    let taken = false;
    await act(async () => {
      taken = hook.result.current.fileFailed();
    });
    expect(taken).toBe(true);
    expect(resolve).toHaveBeenLastCalledWith('youtube', 'dQw4w9WgXcQ', 'video', {
      adaptive: false,
      refresh: true,
    });
    expect(renewed).toHaveBeenCalledOnce();
    expect(hook.result.current.source).toBe(fresh);
    expect(hook.result.current.fileFailed()).toBe(false);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('файл после отказов DASH подписан только что — его ошибка не обновляется ещё раз', async () => {
    const { hook, resolve } = setup(source({ kind: 'dash' }));
    await flush();
    resolve.mockResolvedValueOnce(source({ kind: 'file' }));
    await act(async () => hook.result.current.dashFailed());
    expect(hook.result.current.fileFailed()).toBe(false);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('новое видео начинает счёт попыток заново, а опоздавший ответ о прежнем пропадает', async () => {
    const { hook, resolve, renewed } = setup(source({ kind: 'file' }));
    await flush();
    const late = pending<CinemaSource>();
    resolve.mockReturnValueOnce(late.promise);
    act(() => void hook.result.current.fileFailed());
    const other = source({ contentId: 'aqz-KE-bpKQ', kind: 'file', url: '/cinema/fetch?other' });
    resolve.mockResolvedValueOnce(other);
    hook.rerender({ current: watch({ contentId: 'aqz-KE-bpKQ' }) });
    expect(hook.result.current.source).toBeNull();
    await flush();
    expect(hook.result.current.source).toBe(other);
    await act(async () => late.settle(source({ url: '/cinema/fetch?late' })));
    expect(hook.result.current.source).toBe(other);
    expect(renewed).not.toHaveBeenCalled();
    resolve.mockResolvedValueOnce(source({ contentId: 'aqz-KE-bpKQ', kind: 'file' }));
    let taken = false;
    await act(async () => {
      taken = hook.result.current.fileFailed();
    });
    expect(taken).toBe(true);
  });

  it('обновление не удалось — отказ его словами или общим текстом', async () => {
    const { hook, resolve } = setup();
    await flush();
    resolve.mockRejectedValueOnce(new Error(''));
    await act(async () => void hook.result.current.renew());
    expect(hook.result.current.status).toBe('failed');
    expect(hook.result.current.error).toBe('Не удалось обновить поток');
  });

  it('обновление не меняется от отрисовки к отрисовке: иначе таймер конца подписи заводился бы заново', async () => {
    const { hook } = setup();
    await flush();
    const first = hook.result.current.renew;
    hook.rerender({ current: watch({ paused: false, revision: 2 }) });
    expect(hook.result.current.renew).toBe(first);
  });
});
