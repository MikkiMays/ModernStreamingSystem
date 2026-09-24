import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Admission } from '../../api/types';
import { CinemaApi } from './api';

const admission = { roomId: 'room-1', credential: 'token-1' } as Admission;

const answer = (body: unknown = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

function calls() {
  return (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls as [string, RequestInit][];
}
const lastUrl = () => new URL(calls().at(-1)![0], 'http://test');

beforeEach(() => {
  // Свежий `Response` на каждый вызов: тело читается один раз, а один и тот же объект на все
  // вызовы `mockResolvedValue` подсовывал бы второму `request()` уже прочитанный поток.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(answer())),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CinemaApi: курсор в адресе', () => {
  // Настоящий курсор бывает похож на кусок base64 или содержит служебные символы: без
  // кодирования `&`/`=` внутри него превращались бы в чужие параметры запроса.
  const cursor = 'a b+c/d=e&f=1';

  it('search кодирует курсор', async () => {
    const api = new CinemaApi(admission);
    await api.search('youtube', 'query', cursor);
    expect(lastUrl().searchParams.get('cursor')).toBe(cursor);
    expect(calls().at(-1)![0]).toContain(encodeURIComponent(cursor));
    expect(calls().at(-1)![0]).not.toContain(`cursor=${cursor}`);
  });

  it('channel, playlist, categories и category кодируют курсор тем же способом', async () => {
    const api = new CinemaApi(admission);
    await api.channel('youtube', 'UCabc', 'videos', cursor);
    expect(lastUrl().searchParams.get('cursor')).toBe(cursor);

    await api.playlist('youtube', 'PLabc', cursor);
    expect(lastUrl().searchParams.get('cursor')).toBe(cursor);

    await api.categories('twitch', '', cursor);
    expect(lastUrl().searchParams.get('cursor')).toBe(cursor);

    await api.category('twitch', '509658', cursor);
    expect(lastUrl().searchParams.get('cursor')).toBe(cursor);
  });

  it('series кодирует и курсор, и сезон', async () => {
    const api = new CinemaApi(admission);
    await api.series('youtube', 'series-1', 's1&x', cursor);
    const url = lastUrl();
    expect(url.searchParams.get('season')).toBe('s1&x');
    expect(url.searchParams.get('cursor')).toBe(cursor);
  });
});

describe('CinemaApi: таймаут resolve', () => {
  it('resolve просит у запроса 20-секундный сигнал, а не восьмисекундный по умолчанию', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const api = new CinemaApi(admission);
    await api.resolve('youtube', 'dQw4w9WgXcQ', 'video');
    expect(timeout).toHaveBeenCalledWith(20000);
    expect(timeout).not.toHaveBeenCalledWith(8000);
    const [, init] = calls().at(-1)!;
    // Сигнал, ушедший в fetch, — это ровно тот, что вернул наш собственный вызов таймаута:
    // `request()` не подменяет и не оборачивает уже заданный сигнал.
    expect(init.signal).toBe(timeout.mock.results.at(-1)!.value);
  });

  it('вызов без своего сигнала получает восьмисекундный сигнал запроса — как было раньше', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const api = new CinemaApi(admission);
    await api.details('youtube', 'dQw4w9WgXcQ', 'video');
    expect(timeout).toHaveBeenCalledWith(8000);
    expect(timeout).not.toHaveBeenCalledWith(20000);
  });

  it('свой сигнал вызывающего (react-query) доходит до fetch как есть', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const api = new CinemaApi(admission);
    const controller = new AbortController();
    await api.search('youtube', '', '', controller.signal);
    const [, init] = calls().at(-1)!;
    expect(init.signal).toBe(controller.signal);
    expect(timeout).not.toHaveBeenCalled();
  });
});
