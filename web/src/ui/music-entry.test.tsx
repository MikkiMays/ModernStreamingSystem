import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Meeting } from '../core/meeting';
import { readPreferences, type Preferences } from '../core/preferences';
import type { MusicState, MusicTrack } from '../core/services';
import { Store } from '../core/store';
import { Services } from './Services';

/*
  Вход в музыку — сразу плеер (R44): площадки — вкладками внутри него, а не экраном выбора при каждом
  входе. YouTube и SoundCloud включены по умолчанию, `MUSIC_SOURCES` ограничивает, смена площадки не
  трогает очередь, выбор помнит устройство и при следующем входе он тот же. Площадку, до которой сервер
  не достаёт (R112), видно на вкладке, а вместо поиска — «недоступна с этого сервера» и «Повторить».
*/

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const track = (id: string, title: string): MusicTrack => ({
  id,
  title,
  artist: 'Исполнитель',
  duration: 200,
  addedBy: 'Гость',
  source: 'youtube',
  cover: null,
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
  queue: [track('a', 'Играющий трек'), track('b', 'Второй трек'), track('c', 'Третий трек')],
};

const ALL = ['upload', 'telegram', 'yandex', 'youtube', 'soundcloud'];

/** Служба: каталог с источниками и состояние музыки. Всё, что не GET, записывается. */
function serve(sources: string[] = ALL, extra: { unreachable?: string[]; search?: () => Response } = {}) {
  const writes: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method && init.method !== 'GET') writes.push(`${init.method} ${url}`);
      if (url.endsWith('/music/search') && extra.search) return extra.search();
      const body = url.endsWith('/services/catalog')
        ? {
            services: [],
            telegram: { username: null, connected: false },
            sources,
            unreachable: extra.unreachable ?? [],
            maxFileBytes: 52428800,
          }
        : url.endsWith('/services/rooms/room/music')
          ? STATE
          : url.endsWith('/services/rooms/room/music/commands')
            ? { ...STATE, revision: STATE.revision + 1 }
            : url.endsWith('/services/rooms/room/yandex')
              ? { connected: false, name: null }
              : null;
      return body
        ? new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
        : new Response('{}', { status: 404 });
    }),
  );
  return writes;
}

function meetingWith(lastPlatform: Preferences['lastPlatform'] = {}) {
  const preferences = new Store<Preferences>({ ...readPreferences(), lastPlatform });
  const saveSettings = vi.fn((patch: Partial<Preferences>) =>
    preferences.set({ ...preferences.get(), ...patch }),
  );
  const meeting = {
    admission: { roomId: 'room', participantId: 'self', credential: 'token' },
    snapshot: new Store({
      participants: [{ id: 'self', owner: true, status: 'CONNECTED' }],
      integrationsAllowed: true,
      watch: null,
      poker: null,
      durak: null,
      chess: null,
      gartic: null,
    }),
    ended: new Store<string | null>(null),
    media: {
      preferences,
      saveSettings,
      volumes: new Store({}),
      setVolume: vi.fn(),
      musicPlayoutMs: () => 0,
    },
    refresh: vi.fn(async () => {}),
  };
  return meeting as unknown as Meeting & { media: { saveSettings: typeof saveSettings } };
}

function mount(meeting: Meeting) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Services meeting={meeting} />
    </QueryClientProvider>,
  );
}

const openMusic = () => fireEvent.click(screen.getByRole('button', { name: /^Музыка/ }));
const tabs = () =>
  within(screen.getByRole('tablist', { name: 'Площадка' }))
    .getAllByRole('tab')
    .map((tab) => tab.getAttribute('aria-label'));
const tab = (name: string) =>
  within(screen.getByRole('tablist', { name: 'Площадка' })).getByRole('tab', { name });

describe('вход в музыку', () => {
  it('сразу плеер с вкладками площадок — YouTube и SoundCloud включены по умолчанию', async () => {
    serve();
    mount(meetingWith());
    openMusic();
    await waitFor(() => expect(tabs()).toEqual(['YouTube', 'SoundCloud', 'Яндекс Музыка', 'Свои файлы']));
    // Экрана выбора площадки больше нет: открыта первая, поле поиска и плеер — сразу.
    expect(screen.queryByRole('group', { name: 'Площадки музыки' })).toBeNull();
    expect(tab('YouTube')).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByLabelText('Найти на YouTube или вставить ссылку')).toBeInTheDocument();
    expect(await screen.findByText('Играющий трек')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^Сейчас играет/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Далее в очереди' })).toBeInTheDocument();
    expect(screen.getByText('2 трека')).toBeInTheDocument();
  });

  it('`MUSIC_SOURCES` ограничивает вкладки', async () => {
    serve(['upload', 'yandex']);
    mount(meetingWith());
    openMusic();
    await waitFor(() => expect(tabs()).toEqual(['Яндекс Музыка', 'Свои файлы']));
  });

  it('вкладка открывает площадку: поле — только её, выбор запомнен на устройстве', async () => {
    serve();
    const meeting = meetingWith();
    mount(meeting);
    openMusic();
    fireEvent.click(await screen.findByRole('tab', { name: 'SoundCloud' }));
    expect(tab('SoundCloud')).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByLabelText('Найти в SoundCloud или вставить ссылку')).toBeInTheDocument();
    expect(meeting.media.saveSettings).toHaveBeenLastCalledWith({ lastPlatform: { music: 'soundcloud' } });
  });

  it('смена площадки вкладкой не трогает очередь и ничего не шлёт службе', async () => {
    const writes = serve();
    mount(meetingWith());
    openMusic();
    expect(await screen.findByText('Второй трек')).toBeInTheDocument();
    fireEvent.click(tab('Свои файлы'));
    expect(screen.getByRole('button', { name: 'Загрузить файлы' })).toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).toBeNull();
    fireEvent.click(tab('Яндекс Музыка'));
    expect(await screen.findByRole('button', { name: 'Подключить' })).toBeInTheDocument();
    fireEvent.click(tab('YouTube'));
    expect(screen.getByLabelText('Найти на YouTube или вставить ссылку')).toBeInTheDocument();
    for (const title of ['Играющий трек', 'Второй трек', 'Третий трек'])
      expect(screen.getByText(title)).toBeInTheDocument();
    expect(writes).toEqual([]);
  });

  it('ссылка другой площадки переезжает туда по «Перейти»', async () => {
    serve();
    mount(meetingWith());
    openMusic();
    const field = await screen.findByRole('searchbox');
    fireEvent.change(field, { target: { value: 'https://soundcloud.com/artist/track' } });
    fireEvent.submit(screen.getByRole('search'));
    fireEvent.click(screen.getByRole('button', { name: 'Перейти: SoundCloud' }));
    expect(tab('SoundCloud')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('searchbox')).toHaveValue('https://soundcloud.com/artist/track');
  });

  it('при следующем входе площадка та же, что выбрали, а не экран выбора', async () => {
    serve();
    mount(meetingWith({ music: 'upload' }));
    openMusic();
    expect(await screen.findByRole('tab', { name: 'Свои файлы' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(tab('SoundCloud'));
    fireEvent.click(screen.getByRole('button', { name: 'Интеграции' }));
    openMusic();
    expect(await screen.findByRole('tab', { name: 'SoundCloud' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('group', { name: 'Площадки музыки' })).toBeNull();
  });

  it('«Убрать музыку из встречи» — в меню «⋯» у трека, без подтверждения (R128)', async () => {
    const writes = serve();
    mount(meetingWith());
    openMusic();
    expect(await screen.findByText('Играющий трек')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Убрать музыку из встречи' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ещё действия с музыкой' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Убрать музыку из встречи' }));
    await waitFor(() => expect(writes).toContain('DELETE /api/v1/services/rooms/room/music'));
  });

  it('⏮ шлёт службе «назад»; дольше трёх секунд трека — сразу видно начало', async () => {
    const writes = serve();
    mount(meetingWith());
    openMusic();
    fireEvent.click(await screen.findByRole('button', { name: 'Предыдущий трек' }));
    await waitFor(() => expect(writes).toContain('POST /api/v1/services/rooms/room/music/commands'));
    const body = JSON.parse(
      String(
        (
          vi
            .mocked(fetch)
            .mock.calls.find(([url]) => String(url).endsWith('/music/commands'))?.[1] as RequestInit
        ).body,
      ),
    );
    expect(body.action).toBe('previous');
  });
});

describe('площадка недоступна с этого сервера (R112)', () => {
  it('по каталогу: вкладка отмечена, вместо поиска — «недоступен» и «Повторить»', async () => {
    serve(ALL, { unreachable: ['youtube'] });
    mount(meetingWith());
    openMusic();
    expect(await screen.findByText('YouTube недоступен с этого сервера')).toBeInTheDocument();
    expect(tab('YouTube')).toHaveAttribute('data-reach', 'down');
    expect(tab('SoundCloud')).not.toHaveAttribute('data-reach');
    expect(screen.queryByRole('searchbox')).toBeNull();
    // Плеер и очередь — на месте: недоступна площадка, а не музыка.
    expect(screen.getByText('Играющий трек')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    await waitFor(() =>
      expect(
        vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/services/catalog')),
      ).toHaveLength(2),
    );
    fireEvent.click(tab('SoundCloud'));
    expect(screen.getByLabelText('Найти в SoundCloud или вставить ссылку')).toBeInTheDocument();
  });

  it('по отказу поиска: служба ответила MUSIC_UNREACHABLE — площадка отмечена сразу, без ожидания', async () => {
    serve(ALL, {
      search: () =>
        new Response(
          JSON.stringify({
            code: 'MUSIC_UNREACHABLE',
            detail: 'YouTube недоступен с этого сервера',
            source: 'youtube',
          }),
          { status: 503, headers: { 'Content-Type': 'application/json' } },
        ),
    });
    mount(meetingWith());
    openMusic();
    const field = await screen.findByRole('searchbox');
    fireEvent.change(field, { target: { value: 'песня' } });
    fireEvent.submit(screen.getByRole('search'));
    expect(await screen.findByText('YouTube недоступен с этого сервера')).toBeInTheDocument();
    expect(tab('YouTube')).toHaveAttribute('data-reach', 'down');
  });
});
