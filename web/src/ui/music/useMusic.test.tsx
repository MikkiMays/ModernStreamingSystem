import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { Meeting } from '../../core/meeting';
import { readPreferences, type Preferences } from '../../core/preferences';
import type { MusicState } from '../../core/services';
import { Store } from '../../core/store';
import { MUSIC_POLL_MS, useMusic } from './useMusic';

/*
  Музыка встречи — один хук на панель, мини-плеер и чип (R31, R44): один опрос службы на встречу,
  нажатие видно сразу у всех, статус издателя (голод, переподключение) — как прислала служба.
*/

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const STATE: MusicState = {
  roomId: 'room',
  enabled: true,
  paused: false,
  position: 12,
  revision: 4,
  status: 'playing',
  error: null,
  participantId: 'bot',
  repeat: false,
  queue: [
    {
      id: 'a',
      title: 'Играющий',
      artist: '',
      duration: 200,
      addedBy: 'Гость',
      source: 'youtube',
      cover: null,
    },
  ],
};

function serve(state: () => MusicState = () => STATE, catalog: Record<string, unknown> = {}) {
  const calls: string[] = [];
  let release: (() => void) | null = null;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.endsWith('/music/commands')) await new Promise<void>((resolve) => (release = resolve));
    const body = url.endsWith('/services/catalog')
      ? {
          services: [],
          telegram: { username: null, connected: false },
          sources: ['youtube'],
          maxFileBytes: 1,
          ...catalog,
        }
      : url.includes('/music')
        ? state()
        : null;
    return new Response(JSON.stringify(body), {
      status: body ? 200 : 404,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetch);
  return { calls, release: () => release?.() };
}

function meeting(): Meeting {
  const preferences = new Store<Preferences>(readPreferences());
  return {
    admission: { roomId: 'room', participantId: 'self', credential: 'token' },
    snapshot: new Store({
      participants: [
        { id: 'self', owner: true, status: 'CONNECTED' },
        { id: 'bot', service: 'music', status: 'CONNECTED' },
      ],
      integrationsAllowed: true,
    }),
    ended: new Store<string | null>(null),
    media: {
      preferences,
      saveSettings: (patch: Partial<Preferences>) => preferences.set({ ...preferences.get(), ...patch }),
    },
    refresh: vi.fn(async () => {}),
  } as unknown as Meeting;
}

function both(room: Meeting) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const panel = renderHook(() => useMusic(room), { wrapper });
  const mini = () => renderHook(() => useMusic(room), { wrapper });
  /** Сколько наблюдателей запроса музыки опрашивают службу по часам. */
  const pollers = () =>
    client
      .getQueryCache()
      .find({ queryKey: ['music', 'room', 'self'] })!
      .observers.filter((observer) => observer.options.refetchInterval).length;
  return { panel, mini, pollers };
}

const polls = (calls: string[]) =>
  calls.filter((call) => call === 'GET /api/v1/services/rooms/room/music').length;

describe('useMusic', () => {
  it('два потребителя — один запрос к службе на тик', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { calls } = serve();
    const { panel, mini, pollers } = both(meeting());
    await waitFor(() => expect(panel.result.current.state).toBeDefined());
    // Второй потребитель открылся позже первого: его часы сдвинуты, и свой опрос был бы вторым.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    mini();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    const before = polls(calls);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MUSIC_POLL_MS * 3);
    });
    expect(polls(calls) - before).toBe(3);
    // Опрашивает один из двух; ушёл он — опрашивает оставшийся.
    expect(pollers()).toBe(1);
    panel.unmount();
    await waitFor(() => expect(pollers()).toBe(1));
  });

  it('нажатие видно сразу у обоих, пока служба не ответила', async () => {
    const { release } = serve();
    const { panel, mini } = both(meeting());
    const widget = mini();
    await waitFor(() => expect(widget.result.current.state).toBeDefined());
    act(() => widget.result.current.command('pause', undefined, { paused: true, status: 'paused' }));
    expect(widget.result.current.state?.paused).toBe(true);
    expect(panel.result.current.state?.paused).toBe(true);
    await act(async () => release());
  });

  it('статус издателя — как прислала служба: голод и переподключение', async () => {
    let status: MusicState['status'] = 'starved';
    serve(() => ({ ...STATE, revision: STATE.revision + (status === 'starved' ? 0 : 1), status }));
    const { panel } = both(meeting());
    await waitFor(() => expect(panel.result.current.state?.status).toBe('starved'));
    status = 'reconnecting';
    await act(async () => {
      await panel.result.current.retry();
    });
    await waitFor(() => expect(panel.result.current.state?.status).toBe('reconnecting'));
  });

  it('площадка, до которой сервер не достаёт, — по каталогу и по отказу; «Повторить» снимает отказ', async () => {
    serve(undefined, { sources: ['youtube', 'soundcloud'], unreachable: ['youtube'] });
    const { panel } = both(meeting());
    await waitFor(() => expect(panel.result.current.unreachable('youtube')).toBe(true));
    expect(panel.result.current.unreachable('soundcloud')).toBe(false);
    act(() => panel.result.current.refuse('soundcloud'));
    expect(panel.result.current.unreachable('soundcloud')).toBe(true);
    act(() => panel.result.current.retry());
    expect(panel.result.current.unreachable('soundcloud')).toBe(false);
  });
});
