import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Snapshot } from '../../api/types';
import type { Meeting } from '../../core/meeting';
import { readPreferences, type Preferences } from '../../core/preferences';
import type { MusicState } from '../../core/services';
import { Store } from '../../core/store';
import { IntegrationBarSlot } from '../IntegrationBar';
import { StageOverlay } from '../StageOverlay';

/*
  Музыка поверх звонка (R31): идёт игра, музыки нет — «Включить музыку»; играет — мини-плеер с ⏮ ⏯ ⏭;
  по нажатию — виджет плеера (вкладки площадок, поиск, очередь), панель интеграций не открывается.
*/

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const PLAYING: MusicState = {
  roomId: 'room',
  enabled: true,
  paused: false,
  position: 30,
  revision: 2,
  status: 'playing',
  error: null,
  participantId: 'bot',
  repeat: false,
  queue: [
    {
      id: 'a',
      title: 'Put On',
      artist: 'Young Jeezy',
      duration: 326,
      addedBy: 'Аня',
      source: 'yandex',
      cover: null,
    },
    {
      id: 'b',
      title: 'Nights',
      artist: 'Frank Ocean',
      duration: 307,
      addedBy: 'Аня',
      source: 'youtube',
      cover: null,
    },
  ],
};

function serve(state: MusicState = PLAYING) {
  const writes: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method && init.method !== 'GET')
        writes.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
      const body = url.endsWith('/services/catalog')
        ? {
            services: [],
            telegram: { username: null, connected: false },
            sources: ['youtube', 'upload'],
            maxFileBytes: 1,
          }
        : url.includes('/music')
          ? state
          : null;
      return new Response(JSON.stringify(body), {
        status: body ? 200 : 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return writes;
}

const person = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  status: 'CONNECTED',
  ...extra,
});
const poker = { seats: [{ memberId: 'me' }, { memberId: 'ann' }] };

function meeting(extra: Record<string, unknown> = {}) {
  const preferences = new Store<Preferences>(readPreferences());
  return {
    admission: { roomId: 'room', participantId: 'me', credential: 'token' },
    snapshot: new Store({
      participants: [person('me', { owner: true })],
      integrationsAllowed: true,
      watch: null,
      poker: null,
      durak: null,
      chess: null,
      gartic: null,
      ...extra,
    } as unknown as Snapshot),
    viewing: new Store(null),
    ended: new Store<string | null>(null),
    media: {
      preferences,
      saveSettings: (patch: Partial<Preferences>) => preferences.set({ ...preferences.get(), ...patch }),
      volumes: new Store({}),
      setVolume: vi.fn(),
      musicPlayoutMs: () => 0,
    },
    refresh: vi.fn(async () => {}),
  } as unknown as Meeting;
}

function show(room: Meeting, onOpenServices = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <StageOverlay meeting={room} onOpenServices={onOpenServices} />
    </QueryClientProvider>,
  );
  return onOpenServices;
}

describe('предложение включить музыку', () => {
  it('идёт игра, музыки нет — «Включить музыку»; нажатие добавляет её и открывает виджет, не панель', async () => {
    const writes = serve({ ...PLAYING, enabled: false, queue: [], status: 'disabled' });
    const onOpenServices = show(meeting({ poker }));
    fireEvent.click(screen.getByRole('button', { name: 'Включить музыку' }));
    await waitFor(() =>
      expect(writes.map((write) => write.url)).toContain('/api/v1/services/rooms/room/music/enable'),
    );
    expect(await screen.findByRole('dialog', { name: 'Музыка' })).toBeInTheDocument();
    expect(onOpenServices).not.toHaveBeenCalled();
  });

  it('без игры, в кинозале или без права добавить — не предлагает; крестик скрывает до конца встречи', () => {
    serve();
    show(meeting());
    expect(screen.queryByRole('button', { name: 'Включить музыку' })).toBeNull();
    cleanup();
    show(meeting({ poker, watch: { provider: 'youtube', title: 'Фильм' } }));
    expect(screen.queryByRole('button', { name: 'Включить музыку' })).toBeNull();
    cleanup();
    show(meeting({ poker, you: { can: ['music.control'] } }));
    expect(screen.queryByRole('button', { name: 'Включить музыку' })).toBeNull();
    cleanup();
    const room = meeting({ poker });
    show(room);
    fireEvent.click(screen.getByRole('button', { name: 'Не предлагать до конца встречи' }));
    expect(screen.queryByRole('button', { name: 'Включить музыку' })).toBeNull();
    cleanup();
    // Слой сцены собрали заново (другая раскладка) — предложение не вернулось.
    show(room);
    expect(screen.queryByRole('button', { name: 'Включить музыку' })).toBeNull();
  });
});

describe('мини-плеер', () => {
  const withMusic = () =>
    meeting({ poker, participants: [person('me', { owner: true }), person('bot', { service: 'music' })] });

  it('играет трек — название, эквалайзер и ⏮ ⏯ ⏭ прямо над звонком', async () => {
    const writes = serve();
    show(withMusic());
    const bar = await screen.findByRole('group', { name: 'Мини-плеер' });
    expect(bar).toHaveTextContent('Put On');
    expect(bar).toHaveTextContent('Young Jeezy');
    expect(bar.querySelector('.music-eq')).not.toBeNull();
    // Монохром (R128): цвета площадки у полосы нет, шеврона «раскрыть» — тоже.
    expect(bar.getAttribute('style') ?? '').not.toContain('--brand');
    expect(screen.queryByRole('button', { name: 'Открыть плеер' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Пауза музыки' }));
    expect(screen.getByRole('button', { name: 'Продолжить музыку' })).toBeInTheDocument();
    await waitFor(() => expect(writes.at(-1)?.body).toMatchObject({ action: 'pause' }));
    fireEvent.click(screen.getByRole('button', { name: 'Предыдущий трек' }));
    await waitFor(() => expect(writes.at(-1)?.body).toMatchObject({ action: 'previous' }));
    // Быстрые кнопки виджет не открывают — открывает сам трек.
    expect(screen.queryByRole('dialog', { name: 'Музыка' })).toBeNull();
  });

  it('нажатие на трек открывает виджет плеера: площадки, поиск и очередь — без переключения панели', async () => {
    serve();
    const onOpenServices = show(withMusic());
    // Обложка, название и исполнитель — одна кнопка (R128): имя говорит, что откроется.
    const track = await screen.findByRole('button', { name: 'Put On — Young Jeezy — открыть плеер' });
    expect(track).toHaveAttribute('aria-haspopup', 'dialog');
    expect(track).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(track);
    const widget = await screen.findByRole('dialog', { name: 'Музыка' });
    expect(widget.querySelector('[role="tablist"]')).not.toBeNull();
    expect(await screen.findByText('Nights')).toBeInTheDocument();
    expect(onOpenServices).not.toHaveBeenCalled();
  });

  it('за столом игры — в шапке стола, а не плашкой поверх сцены (R128)', async () => {
    serve();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <StageOverlay meeting={withMusic()} onOpenServices={vi.fn()} />
        <header data-testid="table-bar">
          <IntegrationBarSlot />
        </header>
      </QueryClientProvider>,
    );
    const bar = await screen.findByRole('group', { name: 'Мини-плеер' });
    expect(screen.getByTestId('table-bar')).toContainElement(bar);
    expect(bar).toHaveAttribute('data-placement', 'bar');
    // Слой над сценой пуст — и диктору его не слышно.
    expect(document.querySelector('.stage-overlay')).toHaveAttribute('aria-hidden', 'true');
  });
});
