import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Meeting } from '../../../core/meeting';
import type { ProviderId } from '../../../core/cinema';
import { Store } from '../../../core/store';
import { sceneMeeting } from '../../../test/cinemaMeeting';
import { useStore } from '../../primitives';
import SwitcherScene from './SwitcherScene';

/*
  Смена площадки — это смена всего, что было открыто: стопки, запроса и витрины.

  Раньше сброс делал эффект, то есть на кадр позже: первый кадр новой площадки ещё видел поиск
  и канал старой — и успевал спросить у службы «big buck bunny» на Twitch и канал YouTube под
  именем Twitch. Здесь это ловится по самим запросам: служба не должна услышать ни одного
  вопроса, в котором площадка одна, а содержимое — от другой.
*/

const VIDEO = {
  provider: 'youtube',
  kind: 'video',
  id: 'aqz-KE-bpKQ',
  title: 'Big Buck Bunny 60fps 4K',
  author: 'Blender',
  channelId: 'UCSMOQeBJ2RAnuFungnQOxLg',
  duration: 635,
  live: false,
  poster: null,
};

/** Что ответила бы служба на ссылку: её грамматику здесь играет таблица. */
const ROUTES: Record<string, unknown> = {
  'https://youtu.be/aqz-KE-bpKQ': {
    route: { provider: 'youtube', kind: 'video', id: 'aqz-KE-bpKQ', page: 'item' },
  },
  'https://www.twitch.tv/pesh': { route: { provider: 'twitch', kind: 'channel', id: 'pesh', page: 'item' } },
};

function answer(url: URL, body?: string) {
  const endpoint = url.pathname.split('/cinema/')[1];
  if (endpoint === 'link') return ROUTES[(JSON.parse(body ?? '{}') as { url: string }).url];
  if (endpoint === 'details')
    return url.searchParams.get('provider') === 'twitch'
      ? { ...VIDEO, provider: 'twitch', kind: 'channel', id: 'pesh', title: 'Эфир pesh', live: true }
      : { ...VIDEO, title: 'Big Buck Bunny — страница ролика', description: '' };
  if (endpoint === 'search')
    return url.searchParams.get('provider') === 'youtube' && url.searchParams.get('query')
      ? { items: [VIDEO], channels: [], categories: [], next: null }
      : { items: [], channels: [], categories: [], next: null };
  if (endpoint === 'channel') return { channel: null, items: [], next: null };
  return { items: [], next: null };
}

/** Что спросили у службы: `площадка endpoint запрос/id`. */
const asked: string[] = [];

beforeEach(() => {
  asked.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://test');
      const params = url.searchParams;
      const body = typeof init?.body === 'string' ? init.body : undefined;
      asked.push(
        `${params.get('provider')} ${url.pathname.split('/cinema/')[1]} ${params.get('query') ?? params.get('id')}`,
      );
      return Promise.resolve(
        new Response(JSON.stringify(answer(url, body)), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Вставить в поле из буфера: `paste`, и поле изменилось целиком. */
function paste(field: HTMLElement, text: string) {
  fireEvent.paste(field);
  fireEvent.change(field, { target: { value: text } });
}

function Harness({ meeting }: { meeting: Meeting }) {
  const [provider, setProvider] = useState<ProviderId>('youtube');
  return <SwitcherScene meeting={meeting} provider={provider} onProvider={setProvider} onClose={() => {}} />;
}

function mount() {
  const meeting = {
    admission: { roomId: 'room', participantId: 'self', credential: 'token' },
    snapshot: new Store({
      participants: [{ id: 'self', owner: true }],
      integrationsAllowed: true,
      watch: null,
    }),
    command: vi.fn(),
    openCinema: vi.fn(),
  } as unknown as Meeting;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Harness meeting={meeting} />
    </QueryClientProvider>,
  );
  return client;
}

async function search(text: string) {
  fireEvent.change(screen.getByPlaceholderText('Ролик, канал или плейлист'), { target: { value: text } });
  await waitFor(() => expect(asked).toContain(`youtube search ${text}`));
}

/** Нажать вкладку Twitch так, как это делает мышь: фокус на кнопку, потом нажатие. */
async function toTwitch() {
  const twitch = screen.getByRole('tab', { name: 'Twitch' });
  twitch.focus();
  await act(async () => fireEvent.click(twitch));
  await waitFor(() => expect(asked).toContain('twitch search '));
  return twitch;
}

it('новая площадка не наследует поиск: Twitch не спрашивают о запросе, набранном на YouTube', async () => {
  const client = mount();
  await search('big buck bunny');
  await screen.findByRole('button', { name: 'Blender' });

  const twitch = await toTwitch();
  expect(asked.filter((line) => line.startsWith('twitch '))).toEqual(['twitch search ']);
  expect(screen.getByPlaceholderText('Канал или игра на Twitch')).toHaveValue('');
  // Вкладки и поле — те же элементы, что и были: фокус остался на нажатой вкладке, а не уехал
  // в поле поиска с `autoFocus`, как было бы при пересоздании шапки.
  expect(document.activeElement).toBe(twitch);
  client.clear();
});

it('новая площадка не наследует стопку: канал YouTube не запрашивают у Twitch', async () => {
  const client = mount();
  await search('big buck bunny');
  fireEvent.click(await screen.findByRole('button', { name: 'Blender' }));
  await waitFor(() => expect(asked).toContain(`youtube channel ${VIDEO.channelId}`));
  expect(screen.getByRole('button', { name: 'Назад' })).toBeInTheDocument();

  const twitch = await toTwitch();
  expect(asked.filter((line) => line.startsWith('twitch '))).toEqual(['twitch search ']);
  expect(screen.queryByRole('button', { name: 'Назад' })).toBeNull();
  expect(document.activeElement).toBe(twitch);
  client.clear();
});

/** Сцена, как её держит сцена встречи: площадка и страница — из хранилищ встречи. */
function Host({ meeting }: { meeting: Meeting }) {
  const cinema = useStore(meeting.cinema);
  const at = useStore(meeting.cinemaAt);
  return cinema === 'youtube' || cinema === 'twitch' ? (
    <SwitcherScene
      meeting={meeting}
      provider={cinema}
      at={at}
      onProvider={(next) => meeting.openCinema(next)}
      onClose={() => {}}
    />
  ) : null;
}

function host(prepare?: (meeting: ReturnType<typeof sceneMeeting>) => void) {
  const meeting = sceneMeeting('youtube');
  prepare?.(meeting);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Host meeting={meeting} />
    </QueryClientProvider>,
  );
  return { client, meeting };
}

it('сцена, открытая по ссылке на ролик, начинается с его страницы и включает его под именем со страницы', async () => {
  const { client, meeting } = host((meeting) =>
    meeting.openCinema('youtube', { page: 'item', kind: 'video', id: 'aqz-KE-bpKQ' }),
  );
  expect(
    await screen.findByRole('heading', { name: 'Big Buck Bunny — страница ролика' }),
  ).toBeInTheDocument();
  // Витрины YouTube не спрашивали: страница ролика — с первого же кадра.
  expect(asked).toEqual(['youtube details aqz-KE-bpKQ']);
  fireEvent.click(screen.getByRole('button', { name: /Смотреть вместе/ }));
  await waitFor(() =>
    expect(meeting.command).toHaveBeenCalledWith(
      'watch.open',
      'Big Buck Bunny — страница ролика',
      undefined,
      {
        provider: 'youtube',
        kind: 'video',
        contentId: 'aqz-KE-bpKQ',
      },
    ),
  );
  // Включили — каталог уходит, как и из витрины.
  await waitFor(() => expect(meeting.openCinema).toHaveBeenLastCalledWith(null));
  client.clear();
});

it('«Назад» со страницы по ссылке ведёт на витрину площадки', async () => {
  const { client } = host((meeting) =>
    meeting.openCinema('youtube', { page: 'item', kind: 'video', id: 'aqz-KE-bpKQ' }),
  );
  await screen.findByRole('heading', { name: 'Big Buck Bunny — страница ролика' });
  fireEvent.click(screen.getByRole('button', { name: 'Назад' }));
  expect(await screen.findByText('Что включим комнате?')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Назад' })).toBeNull();
  client.clear();
});

it('ссылка на Twitch, вставленная в поиск YouTube, открывает эфир на вкладке Twitch — без поиска', async () => {
  const { client, meeting } = host();
  paste(screen.getByPlaceholderText('Ролик, канал или плейлист'), 'https://www.twitch.tv/pesh');
  expect(await screen.findByRole('heading', { name: 'Эфир pesh' })).toBeInTheDocument();
  expect(meeting.openCinema).toHaveBeenCalledWith('twitch', { page: 'item', kind: 'channel', id: 'pesh' });
  expect(screen.getByRole('tab', { name: 'Twitch' })).toHaveAttribute('aria-selected', 'true');
  expect(asked.filter((line) => line.includes(' search '))).toEqual([]);
  expect(asked).toContain('twitch details pesh');
  client.clear();
});

it('пока служба отвечает о ссылке — «Открываем ссылку…»: витрины нет, поиск по адресу не уходит', async () => {
  let release = () => {};
  const gate = new Promise<void>((done) => (release = done));
  const plain = vi.mocked(globalThis.fetch).getMockImplementation()!;
  vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
    if (String(input).includes('/cinema/link')) await gate;
    return plain(input, init);
  });
  const { client } = host();
  await screen.findByText('Что включим комнате?');
  paste(screen.getByPlaceholderText('Ролик, канал или плейлист'), 'https://youtu.be/aqz-KE-bpKQ');
  expect(await screen.findByText('Открываем ссылку…')).toBeInTheDocument();
  expect(screen.queryByText('Что включим комнате?')).toBeNull();
  release();
  expect(
    await screen.findByRole('heading', { name: 'Big Buck Bunny — страница ролика' }),
  ).toBeInTheDocument();
  expect(asked.filter((line) => line.includes(' search '))).toEqual([]);
  // Ссылка сделала своё: поле снова пустое, и «назад» вернёт витрину, а не поиск по адресу.
  expect(screen.getByPlaceholderText('Ролик, канал или плейлист')).toHaveValue('');
  client.clear();
});

it('ответ о ссылке, которую уже стёрли, никуда не ведёт: набрали другое — ищут другое', async () => {
  let release = () => {};
  const gate = new Promise<void>((done) => (release = done));
  const plain = vi.mocked(globalThis.fetch).getMockImplementation()!;
  vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
    if (String(input).includes('/cinema/link')) await gate;
    return plain(input, init);
  });
  const { client, meeting } = host();
  const field = screen.getByPlaceholderText('Ролик, канал или плейлист');
  paste(field, 'https://www.twitch.tv/pesh');
  await screen.findByText('Открываем ссылку…');
  fireEvent.change(field, { target: { value: 'big buck bunny' } });
  await waitFor(() => expect(asked).toContain('youtube search big buck bunny'));
  release();
  await screen.findByRole('button', { name: 'Blender' });
  await new Promise((done) => setTimeout(done, 100));
  expect(meeting.openCinema).not.toHaveBeenCalled();
  expect(screen.getByRole('tab', { name: 'YouTube' })).toHaveAttribute('aria-selected', 'true');
  client.clear();
});

it('ссылку, набранную по букве, не спрашивают на паузах: подсказка Enter, и только Enter её открывает', async () => {
  const { client, meeting } = host();
  await screen.findByText('Что включим комнате?');
  const field = screen.getByPlaceholderText('Ролик, канал или плейлист');
  const text = 'https://www.twitch.tv/pesh';
  for (let length = 1; length <= text.length; length += 1)
    fireEvent.change(field, { target: { value: text.slice(0, length) } });
  expect(await screen.findByText('Нажмите Enter — и кинозал откроет эту ссылку.')).toBeInTheDocument();
  await new Promise((done) => setTimeout(done, 100));
  expect(asked.filter((line) => line.includes(' link '))).toEqual([]);
  expect(meeting.openCinema).not.toHaveBeenCalled();
  fireEvent.keyDown(field, { key: 'Enter' });
  expect(await screen.findByRole('heading', { name: 'Эфир pesh' })).toBeInTheDocument();
  expect(meeting.openCinema).toHaveBeenCalledWith('twitch', { page: 'item', kind: 'channel', id: 'pesh' });
  expect(asked.filter((line) => line.includes(' link '))).toHaveLength(1);
  client.clear();
});

it('ссылка, вставленная целиком без события вставки (подсказка клавиатуры телефона), — тоже вставка', async () => {
  const { client, meeting } = host();
  fireEvent.change(screen.getByPlaceholderText('Ролик, канал или плейлист'), {
    target: { value: 'https://youtu.be/aqz-KE-bpKQ' },
  });
  await waitFor(() =>
    expect(meeting.openCinema).toHaveBeenCalledWith('youtube', {
      page: 'item',
      kind: 'video',
      id: 'aqz-KE-bpKQ',
    }),
  );
  client.clear();
});
