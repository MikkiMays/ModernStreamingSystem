import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Meeting } from '../core/meeting';
import { readPreferences, type Preferences } from '../core/preferences';
import type { MusicState, MusicTrack } from '../core/services';
import { Store } from '../core/store';
import { Services } from './Services';

/*
  Вход в музыку — выбор площадки, как в кинозале (T59, В-5): YouTube и SoundCloud включены по
  умолчанию, `MUSIC_SOURCES` ограничивает, смена площадки не трогает очередь, а прошлый выбор помнит
  устройство.
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
function serve(sources: string[] = ALL) {
  const writes: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method && init.method !== 'GET') writes.push(`${init.method} ${url}`);
      const body = url.endsWith('/services/catalog')
        ? { services: [], telegram: { username: null, connected: false }, sources, maxFileBytes: 52428800 }
        : url.endsWith('/services/rooms/room/music')
          ? STATE
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
    media: { preferences, saveSettings, volumes: new Store({}), setVolume: vi.fn() },
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
const tiles = () =>
  within(screen.getByRole('group', { name: 'Площадки музыки' }))
    .getAllByRole('button')
    .map((button) => button.querySelector('b')?.textContent);
const tab = (name: string) =>
  within(screen.getByRole('tablist', { name: 'Площадка' })).getByRole('tab', { name });

describe('вход в музыку', () => {
  it('сначала выбор площадки — YouTube и SoundCloud включены по умолчанию', async () => {
    serve();
    mount(meetingWith());
    openMusic();
    await waitFor(() => expect(tiles()).toEqual(['YouTube', 'SoundCloud', 'Яндекс Музыка', 'Свои файлы']));
    expect(screen.getByRole('heading', { name: 'Музыка' })).toBeInTheDocument();
    // Ни плеера, ни поля, пока площадка не выбрана; что играет — видно и здесь.
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(await screen.findByText('Играющий трек')).toBeInTheDocument();
    expect(screen.getByText('Сейчас играет:')).toBeInTheDocument();
  });

  it('`MUSIC_SOURCES` ограничивает выбор', async () => {
    serve(['upload', 'yandex']);
    mount(meetingWith());
    openMusic();
    await waitFor(() => expect(tiles()).toEqual(['Яндекс Музыка', 'Свои файлы']));
  });

  it('выбор открывает площадку: поле — только её, выбор запомнен на устройстве', async () => {
    serve();
    const meeting = meetingWith();
    mount(meeting);
    openMusic();
    fireEvent.click(await screen.findByRole('button', { name: /^SoundCloud/ }));
    expect(tab('SoundCloud')).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByLabelText('Найти в SoundCloud или вставить ссылку')).toBeInTheDocument();
    expect(meeting.media.saveSettings).toHaveBeenLastCalledWith({ lastPlatform: { music: 'soundcloud' } });
  });

  it('смена площадки вкладкой не трогает очередь и ничего не шлёт службе', async () => {
    const writes = serve();
    mount(meetingWith());
    openMusic();
    fireEvent.click(await screen.findByRole('button', { name: /^YouTube/ }));
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
    fireEvent.click(await screen.findByRole('button', { name: /^YouTube/ }));
    const field = await screen.findByRole('searchbox');
    fireEvent.change(field, { target: { value: 'https://soundcloud.com/artist/track' } });
    fireEvent.submit(screen.getByRole('search'));
    fireEvent.click(screen.getByRole('button', { name: 'Перейти: SoundCloud' }));
    expect(tab('SoundCloud')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('searchbox')).toHaveValue('https://soundcloud.com/artist/track');
  });

  it('при следующем входе — снова выбор, прошлый отмечен и в фокусе', async () => {
    serve();
    mount(meetingWith({ music: 'upload' }));
    openMusic();
    const files = await screen.findByRole('button', { name: /^Свои файлы/ });
    expect(within(files).getByText('Последний выбор')).toBeInTheDocument();
    expect(files).toHaveFocus();
    fireEvent.click(files);
    fireEvent.click(screen.getByRole('button', { name: 'Интеграции' }));
    openMusic();
    expect(await screen.findByRole('group', { name: 'Площадки музыки' })).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).toBeNull();
  });
});
