import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Meeting } from '../../../core/meeting';
import { Store } from '../../../core/store';
import RutubeScene from './RutubeScene';

/*
  Сцена Rutube на ответах службы в её форме: что сцена спрашивает, когда и что из этого рисует.

  Здесь не вид, а поведение: витрина и разделы спрашиваются разом, а не одно за другим; раздел
  меняет ленту, не уводя с витрины; сериал открывается своей страницей и листается сезонами;
  «Смотреть вместе» у эфира ТВ — это `channel` с номером ролика. Вид держат e2e и эталон.
*/

const LIVE = {
  provider: 'rutube',
  kind: 'channel',
  id: 'c58f502c7bb34a8fcdd976b221fca292',
  title: 'Прямой эфир Первый канал',
  author: 'Первый канал',
  channelId: '23460655',
  duration: null,
  live: true,
  viewers: null,
  views: null,
  poster: null,
};
const SHOW = {
  provider: 'rutube',
  kind: 'series',
  id: '891161',
  title: 'Универ | PREMIER',
  author: '',
  channelId: null,
  duration: null,
  live: false,
  viewers: null,
  views: null,
  badge: 'Сериал',
  shape: 'tall',
  poster: null,
};
const EPISODE = {
  provider: 'rutube',
  kind: 'video',
  id: '488c6ae4bf4f7a5e6f0a1d6b1c1b2d3e',
  title: 'Универ, 1 сезон, 1 серия',
  author: 'PREMIER',
  channelId: '41030503',
  duration: 1330,
  live: false,
  viewers: null,
  views: 1000,
  badge: '1 серия',
  series: '891161',
  poster: null,
};
const FILM = { ...EPISODE, id: '2fe4663300000000000000000000abcd', title: 'Фильм раздела', badge: undefined };
const NEWER = { ...EPISODE, id: '79c0b79f00000000000000000000abcd', title: 'Свежее видео', badge: undefined };
const FACE = {
  provider: 'rutube',
  kind: 'channel',
  id: '23463954',
  title: 'Телеканал ТНТ',
  author: '',
  channelId: '23463954',
  duration: null,
  live: false,
  viewers: null,
  views: null,
  followers: 1483976,
  description: '',
  poster: null,
};

function answer(url: URL) {
  const endpoint = url.pathname.split('/cinema/')[1];
  const params = url.searchParams;
  if (endpoint === 'search' && params.get('query') === 'сдвиг')
    // Лента «сначала новое» сдвинулась между порциями: фильм раздела приезжает второй раз.
    return params.get('cursor')
      ? { items: [FILM, NEWER], channels: [], categories: [], series: [], next: null }
      : { items: [EPISODE, FILM], channels: [], categories: [], series: [], next: '30' };
  if (endpoint === 'search')
    return params.get('query')
      ? { items: [EPISODE], channels: [FACE], categories: [], series: [SHOW], next: null }
      : { items: [LIVE], channels: [], categories: [], series: [SHOW], next: '30' };
  if (endpoint === 'categories')
    return {
      items: [
        { provider: 'rutube', kind: 'category', id: '4', title: 'Фильмы', viewers: null, poster: null },
        { provider: 'rutube', kind: 'category', id: '7', title: 'Мультфильмы', viewers: null, poster: null },
      ],
      next: null,
    };
  if (endpoint === 'category')
    return {
      category: {
        provider: 'rutube',
        kind: 'category',
        id: '4',
        title: 'Фильмы',
        viewers: null,
        poster: null,
      },
      items: [FILM],
      next: null,
    };
  if (endpoint === 'series' && params.get('season') === '2')
    return {
      series: {
        id: '891161',
        title: 'Универ | PREMIER',
        poster: null,
        description: '',
        year: null,
        seasons: [],
      },
      season: '2',
      // Вторая порция сезона начинается с того, чем кончилась первая: сдвиг ленты между порциями.
      items: params.get('cursor') ? [NEWER, FILM] : [EPISODE, NEWER],
      next: params.get('cursor') ? null : '20',
    };
  if (endpoint === 'series')
    return {
      series: {
        id: '891161',
        title: 'Универ | PREMIER',
        poster: null,
        description: 'Их пятеро.',
        year: 2008,
        seasons: [
          { id: '1', title: 'Сезон 1' },
          { id: '2', title: 'Сезон 2' },
        ],
      },
      season: params.get('season') || '1',
      items: [EPISODE],
      next: null,
    };
  if (endpoint === 'channel') return { channel: null, items: [], next: null };
  return { items: [], next: null };
}

/** Что спросили у службы: `endpoint запрос/id[ сезон]`. */
const asked: string[] = [];

beforeEach(() => {
  asked.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      const url = new URL(input, 'http://test');
      const params = url.searchParams;
      const endpoint = url.pathname.split('/cinema/')[1];
      expect(params.get('provider')).toBe('rutube');
      const season = params.get('season');
      asked.push(`${endpoint} ${params.get('query') ?? params.get('id') ?? ''}${season ? ` ${season}` : ''}`);
      return Promise.resolve(
        new Response(JSON.stringify(answer(url)), {
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

function mount() {
  const meeting = {
    admission: { roomId: 'room', participantId: 'self', credential: 'token' },
    snapshot: new Store({
      participants: [{ id: 'self', owner: true }],
      integrationsAllowed: true,
      watch: null,
    }),
    command: vi.fn(() => Promise.resolve()),
    openCinema: vi.fn(),
  } as unknown as Meeting & { command: ReturnType<typeof vi.fn> };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RutubeScene meeting={meeting} provider="rutube" onProvider={() => {}} onClose={() => {}} />
    </QueryClientProvider>,
  );
  return { client, meeting };
}

it('витрина и разделы спрашиваются разом: эфир первой полкой, сериалы второй', async () => {
  const { client } = mount();
  // Оба вопроса ушли в одном кадре, не дожидаясь друг друга.
  expect(asked).toEqual(['search ', 'categories ']);
  const live = await screen.findByRole('region', { name: 'Прямой эфир' });
  expect(within(live).getByText('Прямой эфир Первый канал')).toBeInTheDocument();
  expect(within(live).getByText('В эфире')).toBeInTheDocument();
  const shows = screen.getByRole('region', { name: 'Сериалы и шоу' });
  expect(within(shows).getByRole('button', { name: 'Открыть: Универ | PREMIER' })).toBeInTheDocument();
  expect(await screen.findByRole('tab', { name: 'Главная' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByPlaceholderText('Видео, каналы и ТВ')).toBeInTheDocument();
  client.clear();
});

it('раздел меняет ленту на месте, а «Главная» возвращает полки без нового вопроса', async () => {
  const { client } = mount();
  fireEvent.click(await screen.findByRole('tab', { name: 'Фильмы' }));
  await waitFor(() => expect(asked).toContain('category 4'));
  expect(await screen.findByText('Фильм раздела')).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Прямой эфир' })).toBeNull();
  expect(screen.getByRole('tab', { name: 'Фильмы' })).toHaveAttribute('aria-selected', 'true');
  fireEvent.click(screen.getByRole('tab', { name: 'Главная' }));
  expect(await screen.findByRole('region', { name: 'Прямой эфир' })).toBeInTheDocument();
  expect(asked.filter((line) => line === 'search ')).toHaveLength(1);
  client.clear();
});

it('сериал — своя страница: шапка, сезоны вкладками, серии; сезон спрашивается своим номером', async () => {
  const { client } = mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Открыть: Универ | PREMIER' }));
  await waitFor(() => expect(asked).toContain('series 891161'));
  expect(await screen.findByText('Их пятеро.')).toBeInTheDocument();
  expect(screen.getByText('2 сезона')).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'Сезон 1' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByText('1 серия')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('tab', { name: 'Сезон 2' }));
  await waitFor(() => expect(asked).toContain('series 891161 2'));
  // Шапка и вкладки не пропадают, пока едет новый сезон.
  expect(screen.getByRole('tab', { name: 'Сезон 2' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('heading', { name: 'Универ | PREMIER' })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Назад' }));
  expect(await screen.findByRole('region', { name: 'Прямой эфир' })).toBeInTheDocument();
  client.clear();
});

it('«Смотреть вместе» у эфира ТВ открывает комнате канал с номером ролика', async () => {
  const { client, meeting } = mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Смотреть вместе: Прямой эфир Первый канал' }));
  await waitFor(() =>
    expect(meeting.command).toHaveBeenCalledWith('watch.open', 'Прямой эфир Первый канал', undefined, {
      provider: 'rutube',
      kind: 'channel',
      contentId: 'c58f502c7bb34a8fcdd976b221fca292',
    }),
  );
  client.clear();
});

it('поиск — каналы и сериалы полками над роликами; канал автора открывается своей страницей', async () => {
  const { client } = mount();
  fireEvent.change(screen.getByPlaceholderText('Видео, каналы и ТВ'), { target: { value: 'универ' } });
  await waitFor(() => expect(asked).toContain('search универ'));
  expect(await screen.findByRole('button', { name: 'Открыть канал: Телеканал ТНТ' })).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Сериалы и шоу' })).toBeInTheDocument();
  expect(screen.getByText('Универ, 1 сезон, 1 серия')).toBeInTheDocument();
  // Разделы площадки — у витрины, а не у найденного.
  expect(screen.queryByRole('tablist', { name: 'Разделы Rutube' })).toBeNull();

  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Открыть канал: Телеканал ТНТ' })),
  );
  await waitFor(() => expect(asked).toContain('channel 23463954'));
  expect(screen.getByRole('tab', { name: 'О канале' })).toBeInTheDocument();
  client.clear();
});

it('ряд разделов — одна остановка Tab; стрелки ведут по разделам, не спрашивая площадку', async () => {
  const { client } = mount();
  const home = await screen.findByRole('tab', { name: 'Главная' });
  await screen.findByRole('tab', { name: 'Фильмы' });
  const tabs = within(screen.getByRole('tablist', { name: 'Разделы Rutube' })).getAllByRole('tab');
  expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
  home.focus();
  fireEvent.keyDown(home, { key: 'ArrowRight' });
  expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Фильмы' }));
  expect(asked.filter((line) => line.startsWith('category'))).toEqual([]);
  // Выбирает нажатие — и остановка Tab переезжает на выбранный раздел.
  fireEvent.click(document.activeElement as HTMLElement);
  await waitFor(() => expect(asked).toContain('category 4'));
  expect(screen.getByRole('tab', { name: 'Фильмы' }).tabIndex).toBe(0);
  expect(screen.getByRole('tab', { name: 'Главная' }).tabIndex).toBe(-1);
  client.clear();
});

it('карточка, приехавшая во второй порции снова, стоит в ленте один раз', async () => {
  const { client } = mount();
  fireEvent.change(screen.getByPlaceholderText('Видео, каналы и ТВ'), { target: { value: 'сдвиг' } });
  await screen.findByText('Фильм раздела');
  fireEvent.click(screen.getByRole('button', { name: 'Показать ещё' }));
  await screen.findByText('Свежее видео');
  expect(screen.getAllByText('Фильм раздела')).toHaveLength(1);
  expect(
    screen.getAllByRole('button', { name: /^Подробнее: / }).map((node) => node.textContent),
  ).toHaveLength(3);
  client.clear();
});

it('страница сериала тоже ставит повторившуюся серию один раз (общая лента страниц)', async () => {
  const { client } = mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Открыть: Универ | PREMIER' }));
  fireEvent.click(await screen.findByRole('tab', { name: 'Сезон 2' }));
  await screen.findByText('Свежее видео');
  fireEvent.click(screen.getByRole('button', { name: 'Показать ещё' }));
  await screen.findByText('Фильм раздела');
  expect(screen.getAllByText('Свежее видео')).toHaveLength(1);
  expect(screen.getAllByRole('button', { name: /^Подробнее: / })).toHaveLength(3);
  client.clear();
});
