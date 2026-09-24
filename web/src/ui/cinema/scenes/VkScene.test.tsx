import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Meeting } from '../../../core/meeting';
import { sceneMeeting } from '../../../test/cinemaMeeting';
import { useStore } from '../../primitives';
import VkScene from './VkScene';

/*
  Сцена VK Видео на ответах службы в её форме: что сцена спрашивает, когда и что из этого рисует.

  Здесь поведение, а не вид: разделы площадки — ряд вкладок с одной остановкой Tab, первый раздел
  открыт сразу; поиск ставит сообщества полкой над роликами; сообщество — две вкладки и плейлисты;
  вставленная ссылка открывает страницу ролика без поиска — и тогда, когда каталог VK молчит. Чья
  ссылка, говорит служба (`POST …/link`): здесь она отвечает записанной таблицей, как ответила бы
  грамматика VK. Вид держат e2e и эталон.
*/

const ALL = 'PUldVA8AR0RzSVNUWFUCCBkKBRoXGElfZFFYCw';
const MUSIC = 'PUldVA8AR0RzSVNUWFUCCBkGHAVcV0lKZFJLTARJ';
const VIDEO = {
  provider: 'vk',
  kind: 'video',
  id: '-59135674_456241759',
  title: 'Ну-ка, все вместе! 8 сезон. 1 выпуск',
  author: 'НУ-КА, ВСЕ ВМЕСТЕ !',
  channelId: '-59135674',
  duration: 8438,
  live: false,
  viewers: null,
  views: 340326,
  poster: null,
};
const SONG = { ...VIDEO, id: '-86586923_456240639', title: 'Клип раздела «Музыка»', views: 1200 };
const LIVE = {
  ...VIDEO,
  kind: 'channel',
  id: '-88298195_456260712',
  title: 'Прямой эфир ТРК «Ариг Ус»',
  duration: null,
  live: true,
  viewers: 10,
  views: null,
};
const EPISODE = {
  ...VIDEO,
  id: '-22277933_456242578',
  title: 'Маша и Медведь. Серия 14',
  author: 'Маша и Медведь',
};
const COMMUNITY = {
  provider: 'vk',
  kind: 'channel',
  id: '-22277933',
  title: 'Маша и Медведь',
  author: '',
  channelId: '-22277933',
  duration: null,
  live: false,
  viewers: null,
  views: null,
  followers: 817250,
  description: 'Мультфильм',
  poster: null,
};
const ALBUM = {
  provider: 'vk',
  kind: 'playlist',
  id: '-22277933_56093284',
  title: 'Маша и Медведь. Сезон 8',
  author: 'Маша и Медведь',
  channelId: '-22277933',
  duration: null,
  live: false,
  viewers: null,
  views: null,
  count: 23,
  poster: null,
};
const HEAD = {
  provider: 'vk',
  id: '-22277933',
  title: 'Маша и Медведь',
  handle: '',
  description: 'Единственная официальная группа',
  followers: 817250,
  viewers: null,
  live: false,
  category: 'Мультфильм',
  avatar: null,
  banner: null,
};

let catalogDown = false;

/** Что ответила бы служба на ссылку: её грамматику здесь играет таблица. */
const ROUTES: Record<string, unknown> = {
  'https://vkvideo.ru/video-22277933_456242578': {
    route: { provider: 'vk', kind: 'video', id: '-22277933_456242578', page: 'item' },
  },
  'https://vk.com/video-22277933_456242578': {
    route: { provider: 'vk', kind: 'video', id: '-22277933_456242578', page: 'item' },
  },
  'https://live.vkvideo.ru/near_you': {
    route: { provider: 'vk', kind: 'channel', id: 'near_you', page: 'item' },
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
    return catalogDown
      ? [502, { detail: 'VK Видео не пустил каталог: анонимный вход не принят' }]
      : [
          200,
          {
            items: [
              { provider: 'vk', kind: 'category', id: ALL, title: 'Все', viewers: null, poster: null },
              { provider: 'vk', kind: 'category', id: MUSIC, title: 'Музыка', viewers: null, poster: null },
            ],
            next: null,
          },
        ];
  if (endpoint === 'category') {
    const head = {
      provider: 'vk',
      kind: 'category',
      id: params.get('id'),
      title: '',
      viewers: null,
      poster: null,
    };
    if (params.get('id') === MUSIC) return [200, { category: head, items: [SONG], next: null }];
    // Лента «Все» сдвинулась между порциями: первый ролик приезжает второй раз.
    return [
      200,
      params.get('cursor')
        ? { category: head, items: [VIDEO, EPISODE], next: null }
        : { category: head, items: [VIDEO, LIVE], next: '1' },
    ];
  }
  if (endpoint === 'search')
    return [200, { items: [EPISODE], channels: [COMMUNITY], categories: [], next: null }];
  if (endpoint === 'channel')
    return [
      200,
      { channel: HEAD, items: params.get('tab') === 'playlists' ? [ALBUM] : [EPISODE], next: null },
    ];
  if (endpoint === 'playlist')
    return [
      200,
      {
        playlist: {
          provider: 'vk',
          kind: 'playlist',
          id: ALBUM.id,
          title: ALBUM.title,
          author: 'Маша и Медведь',
          channelId: '-22277933',
          description: '',
          count: 23,
          views: null,
          published: '2026-09-10',
          poster: null,
        },
        items: [EPISODE],
        next: null,
      },
    ];
  if (endpoint === 'details')
    return catalogDown
      ? [502, { detail: 'VK Видео не пустил каталог: анонимный вход не принят' }]
      : [
          200,
          {
            ...EPISODE,
            id: params.get('id'),
            title: 'Серия по ссылке',
            description: 'Описание',
            channelAvatar: null,
          },
        ];
  return [404, { detail: 'Not Found' }];
}

/** Что спросили у службы: `endpoint запрос/id[ вкладка][ курсор]`. */
const asked: string[] = [];

beforeEach(() => {
  asked.length = 0;
  catalogDown = false;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://test');
      const params = url.searchParams;
      const endpoint = url.pathname.split('/cinema/')[1];
      const sent = typeof init?.body === 'string' ? init.body : undefined;
      if (endpoint === 'link') asked.push(`link ${(JSON.parse(sent ?? '{}') as { url: string }).url}`);
      else {
        expect(params.get('provider')).toBe('vk');
        const extra = [params.get('tab'), params.get('cursor')].filter(Boolean).join(' ');
        asked.push(`${endpoint} ${params.get('query') ?? params.get('id') ?? ''}${extra ? ` ${extra}` : ''}`);
      }
      const [status, body] = answer(url, sent);
      return Promise.resolve(
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
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

/** Сцена, как её держит сцена встречи: страница — из `Meeting.cinemaAt`, чужая площадка — не здесь. */
function Host({ meeting }: { meeting: Meeting }) {
  const cinema = useStore(meeting.cinema);
  const at = useStore(meeting.cinemaAt);
  return cinema === 'vk' ? (
    <VkScene meeting={meeting} provider="vk" at={at} onProvider={() => {}} onClose={() => {}} />
  ) : null;
}

function mount() {
  const meeting = sceneMeeting('vk');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Host meeting={meeting} />
    </QueryClientProvider>,
  );
  return { client, meeting };
}

it('разделы площадки — ряд вкладок, и первый («Все») открыт сразу сеткой роликов', async () => {
  const { client } = mount();
  expect(await screen.findByRole('tab', { name: 'Все' })).toHaveAttribute('aria-selected', 'true');
  await waitFor(() => expect(asked).toEqual(['categories ', `category ${ALL}`]));
  const tile = (await screen.findByText(VIDEO.title)).closest('article')!;
  // Плитка ролика: длительность, автор и просмотры.
  expect(within(tile).getByText('2:20:38')).toBeInTheDocument();
  expect(within(tile).getByRole('button', { name: VIDEO.author })).toBeInTheDocument();
  expect(within(tile).getByText('340.3 тыс.')).toBeInTheDocument();
  expect(screen.getByPlaceholderText('Видео и сообщества')).toBeInTheDocument();
  expect(screen.getByText('VK Видео')).toBeInTheDocument();
  client.clear();
});

it('раздел выбирают нажатием: одна остановка Tab на ряд, стрелки площадку не спрашивают', async () => {
  const { client } = mount();
  const all = await screen.findByRole('tab', { name: 'Все' });
  const music = screen.getByRole('tab', { name: 'Музыка' });
  expect([all.tabIndex, music.tabIndex]).toEqual([0, -1]);
  all.focus();
  fireEvent.keyDown(all, { key: 'ArrowRight' });
  expect(document.activeElement).toBe(music);
  expect(asked.filter((line) => line.startsWith(`category ${MUSIC}`))).toEqual([]);
  fireEvent.click(music);
  expect(await screen.findByText(SONG.title)).toBeInTheDocument();
  expect(asked).toContain(`category ${MUSIC}`);
  expect(music).toHaveAttribute('aria-selected', 'true');
  expect(music.tabIndex).toBe(0);
  client.clear();
});

it('лента раздела листается, и повторившийся ролик стоит в ней один раз', async () => {
  const { client } = mount();
  await screen.findByText(VIDEO.title);
  fireEvent.click(screen.getByRole('button', { name: 'Показать ещё' }));
  await screen.findByText(EPISODE.title);
  expect(asked).toContain(`category ${ALL} 1`);
  expect(screen.getAllByText(VIDEO.title)).toHaveLength(1);
  client.clear();
});

it('идущий эфир включают прямо с плитки — комнате уходит канал с номером ролика', async () => {
  const { client, meeting } = mount();
  fireEvent.click(await screen.findByRole('button', { name: `Смотреть вместе: ${LIVE.title}` }));
  await waitFor(() =>
    expect(meeting.command).toHaveBeenCalledWith('watch.open', LIVE.title, undefined, {
      provider: 'vk',
      kind: 'channel',
      contentId: LIVE.id,
    }),
  );
  client.clear();
});

it('поиск — сообщества полкой над роликами; сообщество — «Видео» и «Плейлисты», плейлист — своей страницей', async () => {
  const { client } = mount();
  fireEvent.change(screen.getByPlaceholderText('Видео и сообщества'), { target: { value: 'маша' } });
  await waitFor(() => expect(asked).toContain('search маша'));
  const shelf = await screen.findByRole('region', { name: 'Сообщества' });
  expect(within(shelf).getByText('817.3 тыс. подписчиков')).toBeInTheDocument();
  expect(screen.getByText(EPISODE.title)).toBeInTheDocument();
  expect(screen.queryByRole('tablist', { name: 'Разделы VK Видео' })).toBeNull();

  await act(async () =>
    fireEvent.click(within(shelf).getByRole('button', { name: 'Открыть канал: Маша и Медведь' })),
  );
  await waitFor(() => expect(asked).toContain('channel -22277933 videos'));
  expect(await screen.findByRole('heading', { name: 'Маша и Медведь' })).toBeInTheDocument();
  expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Видео', 'Плейлисты']);

  fireEvent.click(screen.getByRole('tab', { name: 'Плейлисты' }));
  const album = await screen.findByRole('button', { name: `Открыть плейлист: ${ALBUM.title}` });
  fireEvent.click(album);
  await waitFor(() => expect(asked).toContain(`playlist ${ALBUM.id}`));
  expect(await screen.findByText('23 видео')).toBeInTheDocument();
  client.clear();
});

it('вставленная ссылка открывает страницу ролика без поиска — куда скажет служба — и включается с его именем', async () => {
  const { client, meeting } = mount();
  paste(screen.getByPlaceholderText('Видео и сообщества'), 'https://vkvideo.ru/video-22277933_456242578');
  expect(await screen.findByRole('heading', { name: 'Серия по ссылке' })).toBeInTheDocument();
  expect(meeting.openCinema).toHaveBeenCalledWith('vk', {
    page: 'item',
    kind: 'video',
    id: '-22277933_456242578',
  });
  expect(asked).toContain('link https://vkvideo.ru/video-22277933_456242578');
  expect(asked).toContain('details -22277933_456242578');
  // Ссылка, которая куда-то привела, — первой в недавних профиля; поле поиска снова пустое.
  expect(meeting.media.saveSettings).toHaveBeenCalledWith({
    cinemaLinks: ['https://vkvideo.ru/video-22277933_456242578'],
  });
  expect(screen.getByPlaceholderText('Видео и сообщества')).toHaveValue('');
  fireEvent.click(screen.getByRole('button', { name: /Смотреть вместе/ }));
  await waitFor(() =>
    expect(meeting.command).toHaveBeenCalledWith('watch.open', 'Серия по ссылке', undefined, {
      provider: 'vk',
      kind: 'video',
      contentId: '-22277933_456242578',
    }),
  );
  // Ссылка — не слова для поиска: искать её у площадки незачем.
  await new Promise((done) => setTimeout(done, 500));
  expect(asked.filter((line) => line.startsWith('search'))).toEqual([]);
  client.clear();
});

it('каталог VK молчит — сцена так и говорит, а ролик по ссылке всё равно открывается', async () => {
  catalogDown = true;
  const { client, meeting } = mount();
  expect(await screen.findByText('Каталог VK Видео сейчас не открывается')).toBeInTheDocument();
  expect(
    screen.getByText(/анонимный вход не принят\. Ролик или эфир VK всё равно откроется по ссылке/),
  ).toBeInTheDocument();

  paste(screen.getByPlaceholderText('Видео и сообщества'), 'https://live.vkvideo.ru/near_you');
  expect(await screen.findByRole('heading', { name: 'Эфир VK Видео Live: near_you' })).toBeInTheDocument();
  // Страница эфира тоже не ответила — отказ виден, а включить эфир комнате можно всё равно.
  expect(await screen.findByText('VK Видео не пустил каталог: анонимный вход не принят')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Смотреть вместе/ }));
  await waitFor(() =>
    expect(meeting.command).toHaveBeenCalledWith('watch.open', 'Эфир VK Видео Live: near_you', undefined, {
      provider: 'vk',
      kind: 'channel',
      contentId: 'near_you',
    }),
  );
  client.clear();
});

it('«Назад» со страницы ролика по ссылке возвращает туда, где ссылку вставили: разделы и пустое поле', async () => {
  const { client } = mount();
  await screen.findByRole('tab', { name: 'Все' });
  paste(screen.getByPlaceholderText('Видео и сообщества'), 'https://vk.com/video-22277933_456242578');
  await screen.findByRole('heading', { name: 'Серия по ссылке' });
  fireEvent.click(screen.getByRole('button', { name: 'Назад' }));
  expect(await screen.findByRole('tab', { name: 'Все' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByPlaceholderText('Видео и сообщества')).toHaveValue('');
  expect(asked.filter((line) => line.startsWith('search'))).toEqual([]);
  client.clear();
});

it('ссылка на другую площадку уходит в её сцену, а незнакомая — в «По ссылке»', async () => {
  const { client, meeting } = mount();
  paste(screen.getByPlaceholderText('Видео и сообщества'), 'https://youtu.be/dQw4w9WgXcQ');
  await waitFor(() =>
    expect(meeting.openCinema).toHaveBeenCalledWith('youtube', {
      page: 'item',
      kind: 'video',
      id: 'dQw4w9WgXcQ',
    }),
  );
  act(() => meeting.openCinema('vk'));
  paste(await screen.findByPlaceholderText('Видео и сообщества'), 'https://example.com/film.mp4');
  await waitFor(() =>
    expect(meeting.openCinema).toHaveBeenCalledWith('link', {
      page: 'link',
      url: 'https://example.com/film.mp4',
    }),
  );
  // Незнакомая ссылка никуда не привела — в недавние она не встаёт.
  expect(meeting.media.saveSettings).toHaveBeenCalledTimes(1);
  client.clear();
});
