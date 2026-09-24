import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import type { CinemaAt } from '../../../core/cinema';
import type { Meeting } from '../../../core/meeting';
import { json, sceneMeeting } from '../../../test/cinemaMeeting';
import { useStore } from '../../primitives';
import LinkScene from './LinkScene';

/*
  Сцена «По ссылке»: поле, буфер обмена, недавние ссылки — и что служба сказала о ссылке.

  Чья ссылка, решает служба (`POST …/link`), здесь её играет таблица: своя площадка — переход в её
  сцену на нужную страницу (`openCinema(площадка, at)`), незнакомая — причина словами, карточка
  общего пути (задачи 15b/15c) — страница с качеством, звуком, субтитрами и сериями.
*/

const RUTUBE = 'https://rutube.ru/video/d8061eab5d7ed2bad058162bc5762842/';
const UNKNOWN = 'https://example.com/films/1';
const REASON = 'Эту ссылку пока не открыть: кинозал узнаёт ссылки YouTube, Twitch, Rutube и VK Видео';
const FILM = {
  provider: 'link',
  kind: 'video',
  id: 'Qm9vay1vZi1saW5rLTAwMQ',
  title: 'Фильм с ok.ru',
  author: 'Киностудия',
  channelId: null,
  duration: 5400,
  live: false,
  viewers: null,
  views: null,
  poster: null,
  site: 'ok.ru',
  quality: '1080p',
  audio: [
    { lang: 'ru', label: 'Русский' },
    { lang: 'en', label: 'English' },
  ],
  captions: [{ lang: 'ru', label: 'Русский', auto: true }],
  episodes: [1, 2].map((number) => ({
    provider: 'link',
    kind: 'video',
    id: `Qm9vay1lcGlzb2RlLTAw${number}`,
    title: `Серия ${number}`,
    author: '',
    channelId: null,
    duration: 2400,
    live: false,
    viewers: null,
    views: null,
    poster: null,
  })),
};
const ANSWERS: Record<string, unknown> = {
  [RUTUBE]: {
    route: { provider: 'rutube', kind: 'video', id: 'd8061eab5d7ed2bad058162bc5762842', page: 'item' },
  },
  'https://youtu.be/dQw4w9WgXcQ': {
    route: { provider: 'youtube', kind: 'video', id: 'dQw4w9WgXcQ', page: 'item' },
  },
  'https://ok.ru/video/1': { item: FILM },
  'https://ivi.ru/watch/1': { route: { provider: 'ivi', kind: 'video', id: '1', page: 'item' } },
};

/** Какие ссылки спросили у службы. */
const asked: string[] = [];
let gate: Promise<void> = Promise.resolve();

beforeEach(() => {
  asked.length = 0;
  gate = Promise.resolve();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      expect(new URL(input, 'http://test').pathname).toBe('/api/v1/services/rooms/room/cinema/link');
      const url = (JSON.parse(String(init?.body)) as { url: string }).url;
      asked.push(url);
      await gate;
      return json(ANSWERS[url] ?? { item: null, reason: REASON });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Host({ meeting }: { meeting: Meeting }) {
  const cinema = useStore(meeting.cinema);
  const at = useStore(meeting.cinemaAt);
  return cinema === 'link' ? (
    <LinkScene meeting={meeting} provider="link" at={at} onProvider={() => {}} onClose={() => {}} />
  ) : null;
}

function mount({ links = [] as string[], at = null as CinemaAt | null, client = fresh() } = {}) {
  const meeting = sceneMeeting('link', links);
  if (at) meeting.openCinema('link', at);
  meeting.openCinema.mockClear();
  render(
    <QueryClientProvider client={client}>
      <Host meeting={meeting} />
    </QueryClientProvider>,
  );
  return { client, meeting };
}

function fresh() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function type(text: string) {
  fireEvent.change(screen.getByPlaceholderText('Вставьте ссылку на видео'), { target: { value: text } });
}

it('пустое поле — подсказка, кнопка буфера и недавние ссылки; недавняя открывается в сцене своей площадки', async () => {
  const { client, meeting } = mount({ links: [RUTUBE, UNKNOWN] });
  expect(screen.getByText('Вставьте ссылку на видео')).toBeInTheDocument();
  expect(screen.getByText(/YouTube, Twitch, Rutube и VK Видео откроется в их каталоге/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Вставить из буфера/ })).toBeInTheDocument();
  const recent = screen.getByRole('region', { name: 'Недавние ссылки' });
  expect(
    within(recent)
      .getAllByRole('button')
      .map((button) => button.textContent),
  ).toEqual(['rutube.ru/video/d8061eab5d7ed2bad058162bc5762842/', 'example.com/films/1']);

  fireEvent.click(within(recent).getAllByRole('button')[0]!);
  await waitFor(() =>
    expect(meeting.openCinema).toHaveBeenCalledWith('rutube', {
      page: 'item',
      kind: 'video',
      id: 'd8061eab5d7ed2bad058162bc5762842',
    }),
  );
  expect(asked).toEqual([RUTUBE]);
  // Открытая ссылка — снова первая, и одна.
  expect(meeting.media.saveSettings).toHaveBeenCalledWith({ cinemaLinks: [RUTUBE, UNKNOWN] });
  client.clear();
});

it('незнакомая ссылка — «Ищем видео…», потом причина словами; в недавние она не встаёт', async () => {
  let release = () => {};
  gate = new Promise((done) => (release = done));
  const { client, meeting } = mount();
  type(UNKNOWN);
  expect(await screen.findByText('Ищем видео…')).toBeInTheDocument();
  act(() => release());
  expect(await screen.findByText(REASON)).toBeInTheDocument();
  expect(screen.getByText(UNKNOWN)).toBeInTheDocument();
  expect(meeting.openCinema).not.toHaveBeenCalled();
  expect(meeting.media.saveSettings).not.toHaveBeenCalled();
  client.clear();
});

it('ссылку без своей площадки из поиска другой сцены показывает сразу — второй раз службу не спрашивает', async () => {
  const client = fresh();
  // Ответ в памяти даже устаревший: переданную ссылку сцена не спрашивает второй раз вовсе.
  client.setQueryData(['cinema', 'link', UNKNOWN], { item: null, reason: REASON }, { updatedAt: 1 });
  mount({ at: { page: 'link', url: UNKNOWN }, client });
  expect(screen.getByPlaceholderText('Вставьте ссылку на видео')).toHaveValue(UNKNOWN);
  expect(screen.getByText(REASON)).toBeInTheDocument();
  await new Promise((done) => setTimeout(done, 600));
  expect(asked).toEqual([]);
  client.clear();
});

it('в поле годится и ссылка без схемы, а не ссылка так и называется', async () => {
  const { client, meeting } = mount();
  type('youtu.be/dQw4w9WgXcQ');
  await waitFor(() =>
    expect(meeting.openCinema).toHaveBeenCalledWith('youtube', {
      page: 'item',
      kind: 'video',
      id: 'dQw4w9WgXcQ',
    }),
  );
  expect(asked).toEqual(['https://youtu.be/dQw4w9WgXcQ']);
  cleanup();
  mount({ client });
  type('маша и медведь');
  expect(await screen.findByText(/Это не похоже на ссылку/)).toBeInTheDocument();
  expect(asked).toEqual(['https://youtu.be/dQw4w9WgXcQ']);
  client.clear();
});

it('кнопка буфера вставляет ссылку сразу — а если в буфере не ссылка или он закрыт, так и говорит', async () => {
  const readText = vi.fn(() => Promise.resolve(RUTUBE));
  // Буфера обмена у jsdom нет: он появляется только на этот тест.
  Object.defineProperty(navigator, 'clipboard', { value: { readText }, configurable: true });
  onTestFinished(() => {
    Reflect.deleteProperty(navigator, 'clipboard');
  });
  const { client, meeting } = mount();
  fireEvent.click(screen.getByRole('button', { name: /Вставить из буфера/ }));
  await waitFor(() => expect(meeting.openCinema).toHaveBeenCalledWith('rutube', expect.anything()));
  expect(asked).toEqual([RUTUBE]);

  cleanup();
  mount({ client });
  readText.mockResolvedValueOnce('просто текст');
  fireEvent.click(screen.getByRole('button', { name: /Вставить из буфера/ }));
  expect(await screen.findByRole('alert')).toHaveTextContent('В буфере обмена нет ссылки.');
  readText.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
  fireEvent.click(screen.getByRole('button', { name: /Вставить из буфера/ }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Браузер не дал прочитать буфер обмена');
  expect(asked).toEqual([RUTUBE]);
  client.clear();
});

it('что нашлось по ссылке: страница с качеством, звуком и субтитрами, серии — каждая своей кнопкой', async () => {
  const { client, meeting } = mount();
  type('https://ok.ru/video/1');
  expect(await screen.findByRole('heading', { name: 'Фильм с ok.ru' })).toBeInTheDocument();
  expect(screen.getByText('ok.ru')).toBeInTheDocument();
  expect(screen.getByText('до 1080p')).toBeInTheDocument();
  expect(screen.getByText('Русский, English')).toBeInTheDocument();
  expect(screen.getByText('Русский (распознаны)')).toBeInTheDocument();
  const episodes = screen.getByRole('region', { name: 'Серии' });
  expect(within(episodes).getAllByRole('listitem')).toHaveLength(2);
  // Нашлось — значит, куда-то привело: ссылка встаёт в недавние.
  expect(meeting.media.saveSettings).toHaveBeenCalledWith({ cinemaLinks: ['https://ok.ru/video/1'] });

  fireEvent.click(within(episodes).getByRole('button', { name: 'Смотреть вместе: Серия 2' }));
  await waitFor(() =>
    expect(meeting.command).toHaveBeenCalledWith('watch.open', 'Серия 2', undefined, {
      provider: 'link',
      kind: 'video',
      contentId: 'Qm9vay1lcGlzb2RlLTAw2',
    }),
  );
  client.clear();
});

it('площадку, которой этот клиент не знает, не открывает — просит обновить страницу', async () => {
  const { client, meeting } = mount();
  type('https://ivi.ru/watch/1');
  expect(await screen.findByText(/обновите страницу/)).toBeInTheDocument();
  expect(meeting.openCinema).not.toHaveBeenCalled();
  client.clear();
});

it('ссылка своей площадки, набранная здесь ещё раз, снова ведёт в её сцену — ответ уже в памяти', async () => {
  const client = fresh();
  client.setQueryData(['cinema', 'link', RUTUBE], ANSWERS[RUTUBE]);
  const { meeting } = mount({ client });
  type(RUTUBE);
  await waitFor(() =>
    expect(meeting.openCinema).toHaveBeenCalledWith('rutube', {
      page: 'item',
      kind: 'video',
      id: 'd8061eab5d7ed2bad058162bc5762842',
    }),
  );
  // Ответ был в памяти — к службе не ходили.
  expect(asked).toEqual([]);
  client.clear();
});
