import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CinemaApi } from '../../../core/cinema';
import { json, sceneMeeting } from '../../../test/cinemaMeeting';
import { useLink } from './useLink';

/*
  Вопрос о ссылке, которую сменили, обрывается: новая ссылка, новый набор или «стереть» — и запрос
  прежней не висит до ответа. Сцена «По ссылке» обрывает его и так (её память ответов теряет
  наблюдателя), а поиск YouTube, Rutube и VK — только здесь.
*/

const FIRST = 'https://example.com/films/1';
const SECOND = 'https://example.com/films/2';
let release = () => {};
const signals: Record<string, AbortSignal | null | undefined> = {};

beforeEach(() => {
  const gate = new Promise<void>((done) => (release = done));
  for (const key of Object.keys(signals)) Reflect.deleteProperty(signals, key);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_: string, init?: RequestInit) => {
      const url = (JSON.parse(String(init?.body)) as { url: string }).url;
      signals[url] = init?.signal;
      await gate;
      return json({ item: null, reason: 'Нечего показать' });
    }),
  );
});
afterEach(() => {
  release();
  vi.unstubAllGlobals();
});

function mount() {
  const meeting = sceneMeeting('youtube');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const view = renderHook(() => useLink(meeting, new CinemaApi(meeting.admission)), { wrapper });
  return { ...view, meeting, client };
}

it('новая ссылка обрывает вопрос о прежней, а новый набор — вопрос о последней', async () => {
  const { result, meeting, client } = mount();
  let first: Promise<boolean> = Promise.resolve(false);
  act(() => {
    first = result.current.follow(FIRST);
  });
  await waitFor(() => expect(signals[FIRST]).toBeDefined());
  expect(result.current.asked).toBe(FIRST);

  act(() => {
    void result.current.follow(SECOND);
  });
  await waitFor(() => expect(signals[SECOND]).toBeDefined());
  expect(signals[FIRST]?.aborted).toBe(true);
  expect(signals[SECOND]?.aborted).toBe(false);
  expect(result.current.asked).toBe(SECOND);
  // Ответа на прежнюю ссылку не будет: никуда она уже не ведёт.
  await expect(first).resolves.toBe(false);

  act(() => result.current.cancel());
  expect(signals[SECOND]?.aborted).toBe(true);
  expect(result.current.asked).toBe('');
  expect(result.current.checking).toBe('');
  release();
  await new Promise((done) => setTimeout(done, 20));
  expect(meeting.openCinema).not.toHaveBeenCalled();
  client.clear();
});

it('та же ссылка ещё раз (Enter после вставки) — тот же вопрос, а не второй', async () => {
  const { result, client } = mount();
  act(() => {
    void result.current.follow(FIRST);
  });
  await waitFor(() => expect(signals[FIRST]).toBeDefined());
  const asked = signals[FIRST];
  act(() => {
    void result.current.follow(FIRST);
  });
  expect(asked?.aborted).toBe(false);
  expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
  client.clear();
});
