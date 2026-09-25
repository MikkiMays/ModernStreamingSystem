import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Meeting } from '../../../core/meeting';
import { json, sceneMeeting } from '../../../test/cinemaMeeting';
import { useStore } from '../../primitives';
import IviScene from './IviScene';

/*
  Сцена ivi на ответах службы в её форме: что сцена спрашивает, когда и что из этого рисует.

  Здесь поведение, а не вид: три вкладки — постерами 2:3, а не широким кадром (этим ivi и
  отличается от Rutube и VK Видео, где так выглядит только полка сериалов); рейтинг и жанр с
  годом — двумя чипами на постере; сериал — своя страница с сезонами, серия внутри неё —
  по-прежнему широкий кадр со своим «Смотреть вместе». Чья ссылка, решает служба (`POST …/link`).
  Вид держат e2e и эталон.
*/

const MOVIE = {
  provider: 'ivi',
  kind: 'video',
  id: '53141',
  title: 'Иван Васильевич меняет профессию',
  author: '',
  channelId: null,
  duration: 5514,
  live: false,
  viewers: null,
  views: null,
  badge: '★ 8.8',
  category: 'Комедии · 1973',
  shape: 'tall',
  poster: null,
};
const SHOW = {
  provider: 'ivi',
  kind: 'series',
  id: '18701',
  title: 'Стеклянный дом',
  author: '',
  channelId: null,
  duration: null,
  live: false,
  viewers: null,
  views: null,
  badge: '★ 7.5',
  category: 'Детективы · 2025',
  shape: 'tall',
  poster: null,
};
const EPISODE = {
  provider: 'ivi',
  kind: 'video',
  id: '567680',
  title: 'Серия 1',
  author: '',
  channelId: null,
  duration: 2663,
  live: false,
  viewers: null,
  views: null,
  badge: '1 серия',
  series: SHOW.id,
  poster: null,
};

/** Что ответила бы служба на ссылку: её грамматику здесь играет таблица. */
const ROUTES: Record<string, unknown> = {
  'https://www.ivi.ru/watch/53141': {
    route: { provider: 'ivi', kind: 'video', id: '53141', page: 'item' },
  },
  'https://youtu.be/dQw4w9WgXcQ': {
    route: { provider: 'youtube', kind: 'video', id: 'dQw4w9WgXcQ', page: 'item' },
  },
};

function answer(url: URL, body: string | undefined): [number, unknown] {
  const endpoint = url.pathname.split('/cinema/')[1];
  const params = url.searchParams;
  if (endpoint === 'link') {
    const link = (JSON.parse(body ?? '{}') as { url: string }).url;
    return [200, ROUTES[link] ?? { item: null, reason: 'Эту ссылку пока не открыть' }];
  }
  if (endpoint === 'categories')
    return [
      200,
      {
        items: [
          { provider: 'ivi', kind: 'category', id: '14', title: 'Фильмы', viewers: null, poster: null },
          { provider: 'ivi', kind: 'category', id: '15', title: 'Сериалы', viewers: null, poster: null },
          { provider: 'ivi', kind: 'category', id: '17', title: 'Мультфильмы', viewers: null, poster: null },
        ],
        next: null,
      },
    ];
  if (endpoint === 'category') {
    const head = {
      provider: 'ivi',
      kind: 'category',
      id: params.get('id'),
      title: params.get('id') === '15' ? 'Сериалы' : 'Фильмы',
      viewers: null,
      poster: null,
    };
    if (params.get('id') === '15') return [200, { category: head, items: [SHOW], next: null }];
    return [200, { category: head, items: [MOVIE], next: null }];
  }
  if (endpoint === 'search') return [200, { items: [MOVIE], channels: [], categories: [], next: null }];
  if (endpoint === 'series')
    return [
      200,
      {
        series: {
          id: SHOW.id,
          title: SHOW.title,
          poster: null,
          description: 'Детектив с умным домом.',
          year: 2025,
          seasons: [{ id: '1', title: 'Сезон 1' }],
        },
        season: '1',
        items: [EPISODE],
        next: null,
      },
    ];
  if (endpoint === 'details')
    return [200, { ...MOVIE, description: 'Комедия Гайдая.', channelAvatar: null, category: MOVIE.category }];
  return [404, { detail: 'Not Found' }];
}

/** Что спросили у службы: `endpoint запрос/id[ сезон]`. */
const asked: string[] = [];

beforeEach(() => {
  asked.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://test');
      const params = url.searchParams;
      const endpoint = url.pathname.split('/cinema/')[1];
      const body = typeof init?.body === 'string' ? init.body : undefined;
      if (endpoint === 'link') asked.push(`link ${(JSON.parse(body ?? '{}') as { url: string }).url}`);
      else {
        expect(params.get('provider')).toBe('ivi');
        const season = params.get('season');
        asked.push(
          `${endpoint} ${params.get('query') ?? params.get('id') ?? ''}${season ? ` ${season}` : ''}`,
        );
      }
      const [status, resBody] = answer(url, body);
      return json(resBody, status);
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

/** Сцена, как её держит сцена встречи: страница — из `Meeting.cinemaAt`, чужая площадка — не здесь. */
function Host({ meeting }: { meeting: Meeting }) {
  const cinema = useStore(meeting.cinema);
  const at = useStore(meeting.cinemaAt);
  return cinema === 'ivi' ? (
    <IviScene meeting={meeting} provider="ivi" at={at} onProvider={() => {}} onClose={() => {}} />
  ) : null;
}

function mount() {
  const meeting = sceneMeeting('ivi');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Host meeting={meeting} />
    </QueryClientProvider>,
  );
  return { client, meeting };
}

it('открывается вкладкой «Фильмы» — постерами 2:3, рейтингом и жанром с годом на плитке', async () => {
  const { client } = mount();
  expect(await screen.findByRole('tab', { name: 'Фильмы' })).toHaveAttribute('aria-selected', 'true');
  await waitFor(() => expect(asked).toEqual(['categories ', 'category 14']));
  const tile = (await screen.findByText(MOVIE.title)).closest('article')!;
  expect(tile).toHaveClass('cinema-tile-tall');
  expect(within(tile).getByText('★ 8.8')).toBeInTheDocument();
  expect(within(tile).getByText('Комедии · 1973')).toBeInTheDocument();
  expect(screen.getByPlaceholderText('Фильм, сериал или мультфильм')).toBeInTheDocument();
  expect(screen.getByText('ivi')).toBeInTheDocument();
  client.clear();
});

it('раздел выбирают нажатием — одна остановка Tab, стрелки площадку не спрашивают', async () => {
  const { client } = mount();
  const movies = await screen.findByRole('tab', { name: 'Фильмы' });
  const shows = screen.getByRole('tab', { name: 'Сериалы' });
  expect([movies.tabIndex, shows.tabIndex]).toEqual([0, -1]);
  movies.focus();
  fireEvent.keyDown(movies, { key: 'ArrowRight' });
  expect(document.activeElement).toBe(shows);
  expect(asked.filter((line) => line.startsWith('category 15'))).toEqual([]);
  fireEvent.click(shows);
  expect(await screen.findByText(SHOW.title)).toBeInTheDocument();
  expect(asked).toContain('category 15');
  expect(shows).toHaveAttribute('aria-selected', 'true');
  client.clear();
});

it('фильм открывается страницей ролика, и «Смотреть вместе» включает его комнате', async () => {
  const { client, meeting } = mount();
  fireEvent.click(await screen.findByRole('button', { name: `Открыть: ${MOVIE.title}` }));
  await waitFor(() => expect(asked).toContain('details 53141'));
  expect(await screen.findByRole('heading', { name: MOVIE.title })).toBeInTheDocument();
  expect(screen.getByText('Комедия Гайдая.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Смотреть вместе/ }));
  await waitFor(() =>
    expect(meeting.command).toHaveBeenCalledWith('watch.open', MOVIE.title, undefined, {
      provider: 'ivi',
      kind: 'video',
      contentId: MOVIE.id,
    }),
  );
  client.clear();
});

it('сериал — своя страница с сезоном, серия внутри неё — прежним широким кадром, а «Назад» возвращает на вкладки', async () => {
  const { client } = mount();
  fireEvent.click(await screen.findByRole('tab', { name: 'Сериалы' }));
  fireEvent.click(await screen.findByRole('button', { name: `Открыть: ${SHOW.title}` }));
  await waitFor(() => expect(asked).toContain('series 18701'));
  expect(await screen.findByRole('heading', { name: SHOW.title })).toBeInTheDocument();
  expect(screen.getByText('Детектив с умным домом.')).toBeInTheDocument();
  // Один сезон — без ряда вкладок вовсе (нечего выбирать), но серии его видны сразу.
  expect(screen.queryByRole('tab', { name: 'Сезон 1' })).toBeNull();
  // Серия внутри сериала — прежний широкий кадр (`Tile`) с длительностью, не постер 2:3.
  const episode = (await screen.findByText(EPISODE.title)).closest('article')!;
  expect(episode).not.toHaveClass('cinema-tile-tall');
  expect(within(episode).getByText('1 серия')).toBeInTheDocument();
  expect(within(episode).getByText('44:23')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Назад' }));
  expect(await screen.findByRole('tab', { name: 'Сериалы' })).toHaveAttribute('aria-selected', 'true');
  client.clear();
});

it('серия внутри сериала включается с плитки — «Смотреть вместе» уходит комнате её же номером', async () => {
  const { client, meeting } = mount();
  fireEvent.click(await screen.findByRole('tab', { name: 'Сериалы' }));
  fireEvent.click(await screen.findByRole('button', { name: `Открыть: ${SHOW.title}` }));
  const episode = (await screen.findByText(EPISODE.title)).closest('article')!;
  fireEvent.click(within(episode).getByRole('button', { name: `Смотреть вместе: ${EPISODE.title}` }));
  await waitFor(() =>
    expect(meeting.command).toHaveBeenCalledWith('watch.open', EPISODE.title, undefined, {
      provider: 'ivi',
      kind: 'video',
      contentId: EPISODE.id,
    }),
  );
  client.clear();
});

it('поиск — постерами 2:3 без раздела над ними; пусто — сказано словами', async () => {
  const { client } = mount();
  fireEvent.change(screen.getByPlaceholderText('Фильм, сериал или мультфильм'), {
    target: { value: 'Иван' },
  });
  await waitFor(() => expect(asked).toContain('search Иван'));
  expect(await screen.findByText(MOVIE.title)).toBeInTheDocument();
  expect(screen.queryByRole('tablist', { name: 'Разделы ivi' })).toBeNull();
  client.clear();
});

it('вставленная ссылка открывает страницу ролика без поиска и встаёт в недавние', async () => {
  const { client, meeting } = mount();
  await screen.findByRole('tab', { name: 'Фильмы' });
  paste(screen.getByPlaceholderText('Фильм, сериал или мультфильм'), 'https://www.ivi.ru/watch/53141');
  expect(await screen.findByRole('heading', { name: MOVIE.title })).toBeInTheDocument();
  expect(meeting.openCinema).toHaveBeenCalledWith('ivi', { page: 'item', kind: 'video', id: '53141' });
  expect(asked).toContain('link https://www.ivi.ru/watch/53141');
  expect(meeting.media.saveSettings).toHaveBeenCalledWith({
    cinemaLinks: ['https://www.ivi.ru/watch/53141'],
  });
  expect(screen.getByPlaceholderText('Фильм, сериал или мультфильм')).toHaveValue('');
  client.clear();
});

it('«Назад» со страницы по ссылке возвращает на вкладки, поле пустое, площадку заново не спрашивали', async () => {
  const { client } = mount();
  await screen.findByRole('tab', { name: 'Фильмы' });
  paste(screen.getByPlaceholderText('Фильм, сериал или мультфильм'), 'https://www.ivi.ru/watch/53141');
  await screen.findByRole('heading', { name: MOVIE.title });
  fireEvent.click(screen.getByRole('button', { name: 'Назад' }));
  expect(await screen.findByRole('tab', { name: 'Фильмы' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByPlaceholderText('Фильм, сериал или мультфильм')).toHaveValue('');
  expect(asked.filter((line) => line.startsWith('search'))).toEqual([]);
  client.clear();
});

it('ссылка на другую площадку уходит в её сцену', async () => {
  const { client, meeting } = mount();
  paste(await screen.findByPlaceholderText('Фильм, сериал или мультфильм'), 'https://youtu.be/dQw4w9WgXcQ');
  await waitFor(() =>
    expect(meeting.openCinema).toHaveBeenCalledWith('youtube', {
      page: 'item',
      kind: 'video',
      id: 'dQw4w9WgXcQ',
    }),
  );
  client.clear();
});

it('открытая по ссылке на ролик сцена начинается сразу со страницы ролика', async () => {
  const meeting = sceneMeeting('ivi');
  act(() => meeting.openCinema('ivi', { page: 'item', kind: 'video', id: '53141' }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Host meeting={meeting} />
    </QueryClientProvider>,
  );
  expect(await screen.findByRole('heading', { name: MOVIE.title })).toBeInTheDocument();
  expect(screen.queryByRole('tablist', { name: 'Разделы ivi' })).toBeNull();
  client.clear();
});
