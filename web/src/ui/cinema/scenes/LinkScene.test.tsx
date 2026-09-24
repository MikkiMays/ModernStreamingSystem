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
  общего пути (задача 15b) — страница с сайтом, качеством, звуком и субтитрами, а плейлист — страница
  сериала с сериями плитками (`series` службы).
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
  qualities: ['1080p', '720p', '360p'],
  audio: [
    { lang: 'ru', label: 'Русский дубляж' },
    { lang: 'en', label: '' },
  ],
  captions: [{ lang: 'ru', label: '', auto: true }],
};
/** Плейлист по ссылке: карточка — сериал, серии — страницей сериала службы. */
const SHOW = {
  provider: 'link',
  kind: 'series',
  id: 'U2hvdy1ieS1saW5rLTAwMDE',
  title: 'Сериал с archive.org',
  author: '',
  channelId: null,
  duration: null,
  live: false,
  viewers: null,
  views: null,
  count: 3,
  poster: null,
  site: 'archive.org',
};
const episode = (number: number) => ({
  provider: 'link',
  kind: 'video',
  id: `RXBpc29kZS1ieS1saW5rLTA${number}`,
  title: `Серия ${number}`,
  author: '',
  channelId: null,
  duration: 2400,
  live: false,
  viewers: null,
  views: null,
  badge: `${number} серия`,
  series: SHOW.id,
  poster: null,
});
const SERIES_PAGE = {
  series: { id: SHOW.id, title: SHOW.title, poster: null, description: 'Три серии', year: null, seasons: [] },
  season: null,
  items: [
    episode(1),
    episode(2),
    // Серия своей площадки — карточкой той площадки: включает её YouTube, а не общий путь.
    { ...episode(3), provider: 'youtube', id: 'dQw4w9WgXcQ', title: 'Серия с YouTube', badge: undefined },
  ],
  next: null,
};
const ANSWERS: Record<string, unknown> = {
  [RUTUBE]: {
    route: { provider: 'rutube', kind: 'video', id: 'd8061eab5d7ed2bad058162bc5762842', page: 'item' },
  },
  'https://youtu.be/dQw4w9WgXcQ': {
    route: { provider: 'youtube', kind: 'video', id: 'dQw4w9WgXcQ', page: 'item' },
  },
  'https://ok.ru/video/1': { item: FILM },
  'https://archive.org/details/show': { item: SHOW },
  'https://ivi.ru/watch/1': { route: { provider: 'ivi', kind: 'video', id: '1', page: 'item' } },
};

/** Какие ссылки спросили у службы. */
const asked: string[] = [];
/** Сигналы этих вопросов: оборванный вопрос — `aborted`. */
const signals: (AbortSignal | null | undefined)[] = [];
/** Какие ещё страницы каталога спросили: `series`, `details`. */
const pages: string[] = [];
let gate: Promise<void> = Promise.resolve();
/** Обрыв сети: `fetch` отказывает сам, как браузер без связи. */
let offline = false;

beforeEach(() => {
  asked.length = 0;
  signals.length = 0;
  pages.length = 0;
  gate = Promise.resolve();
  offline = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const address = new URL(input, 'http://test');
      if (offline) throw new TypeError('Failed to fetch');
      if (address.pathname === '/api/v1/services/rooms/room/cinema/series') {
        pages.push(`series:${address.searchParams.get('provider')}:${address.searchParams.get('id')}`);
        return json(SERIES_PAGE);
      }
      if (address.pathname === '/api/v1/services/rooms/room/cinema/details') {
        pages.push(`details:${address.searchParams.get('provider')}:${address.searchParams.get('id')}`);
        return json({ ...episode(1), description: 'Первая серия' });
      }
      expect(address.pathname).toBe('/api/v1/services/rooms/room/cinema/link');
      const url = (JSON.parse(String(init?.body)) as { url: string }).url;
      asked.push(url);
      signals.push(init?.signal);
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

function field() {
  return screen.getByPlaceholderText('Вставьте ссылку на видео');
}

/** Вставить в поле из буфера: `paste`, и поле изменилось целиком. */
function paste(text: string) {
  fireEvent.paste(field());
  fireEvent.change(field(), { target: { value: text } });
}

/** Набрать руками — по букве, как с клавиатуры. */
function typeByHand(text: string) {
  for (let length = 1; length <= text.length; length += 1)
    fireEvent.change(field(), { target: { value: text.slice(0, length) } });
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
  paste(UNKNOWN);
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
  paste('youtu.be/dQw4w9WgXcQ');
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
  typeByHand('маша и медведь');
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

it('что нашлось по ссылке: страница с сайтом, ступенями качества, звуком и субтитрами — и «Смотреть вместе»', async () => {
  const { client, meeting } = mount();
  paste('https://ok.ru/video/1');
  expect(await screen.findByRole('heading', { name: 'Фильм с ok.ru' })).toBeInTheDocument();
  expect(screen.getByText('ok.ru')).toBeInTheDocument();
  // Ступени — метками, лучшая первой.
  expect(
    Array.from(document.querySelectorAll('.cinema-link-qualities .cinema-chip')).map(
      (chip) => chip.textContent,
    ),
  ).toEqual(['1080p', '720p', '360p']);
  // Дорожка без имени называется языком по-русски, распознанные субтитры — с пометкой.
  expect(screen.getByText('Русский дубляж, Английский')).toBeInTheDocument();
  expect(screen.getByText('Русский (распознаны)')).toBeInTheDocument();
  // Нашлось — значит, куда-то привело: ссылка встаёт в недавние.
  expect(meeting.media.saveSettings).toHaveBeenCalledWith({ cinemaLinks: ['https://ok.ru/video/1'] });

  fireEvent.click(screen.getByRole('button', { name: /Смотреть вместе/ }));
  await waitFor(() =>
    expect(meeting.command).toHaveBeenCalledWith('watch.open', 'Фильм с ok.ru', undefined, {
      provider: 'link',
      kind: 'video',
      contentId: FILM.id,
    }),
  );
  client.clear();
});

it('плейлист по ссылке — страница сериала с сериями плитками: серию включают прямо с плитки или с её страницы', async () => {
  const { client, meeting } = mount();
  paste('https://archive.org/details/show');
  expect(await screen.findByRole('heading', { name: SHOW.title })).toBeInTheDocument();
  expect(await screen.findAllByRole('article')).toHaveLength(3);
  expect(pages).toEqual([`series:link:${SHOW.id}`]);
  expect(screen.getByText('archive.org')).toBeInTheDocument();

  // Страница серии — из того, что служба помнит о ней; «Назад» и «Все серии» — снова к сериям.
  fireEvent.click(screen.getByRole('button', { name: 'Подробнее: Серия 1' }));
  expect(await screen.findByText('Первая серия')).toBeInTheDocument();
  expect(pages).toContain(`details:link:${episode(1).id}`);
  fireEvent.click(screen.getByRole('button', { name: 'Все серии' }));
  expect(await screen.findAllByRole('article')).toHaveLength(3);
  fireEvent.click(screen.getByRole('button', { name: 'Подробнее: Серия 1' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Назад' }));
  expect(await screen.findAllByRole('article')).toHaveLength(3);
  // Серии спрошены один раз: вернувшись со страницы серии, лента уже в памяти.
  expect(pages.filter((entry) => entry.startsWith('series:'))).toHaveLength(1);

  // Серия своей площадки открывается в её сцене — там, где у неё канал и соседи.
  fireEvent.click(screen.getByRole('button', { name: 'Подробнее: Серия с YouTube' }));
  expect(meeting.openCinema).toHaveBeenCalledWith('youtube', {
    page: 'item',
    kind: 'video',
    id: 'dQw4w9WgXcQ',
  });

  // Серию по ссылке включают прямо с плитки — её номером, а не адресом.
  cleanup();
  const again = mount({ client });
  paste('https://archive.org/details/show');
  fireEvent.click(await screen.findByRole('button', { name: 'Смотреть вместе: Серия 2' }));
  await waitFor(() =>
    expect(again.meeting.command).toHaveBeenCalledWith('watch.open', 'Серия 2', undefined, {
      provider: 'link',
      kind: 'video',
      contentId: episode(2).id,
    }),
  );
  client.clear();
});

it('обрыв сети — словами по-русски, а не «Failed to fetch» браузера', async () => {
  offline = true;
  const { client } = mount();
  paste('https://ok.ru/video/1');
  expect(await screen.findByRole('alert')).toHaveTextContent('Нет связи с сервером — попробуйте ещё раз');
  expect(screen.queryByText(/Failed to fetch/)).not.toBeInTheDocument();
  client.clear();
});

it('площадку, которой этот клиент не знает, не открывает — просит обновить страницу', async () => {
  const { client, meeting } = mount();
  paste('https://ivi.ru/watch/1');
  expect(await screen.findByText(/обновите страницу/)).toBeInTheDocument();
  expect(meeting.openCinema).not.toHaveBeenCalled();
  client.clear();
});

it('ссылка своей площадки, набранная здесь ещё раз, снова ведёт в её сцену — ответ уже в памяти', async () => {
  const client = fresh();
  client.setQueryData(['cinema', 'link', RUTUBE], ANSWERS[RUTUBE]);
  const { meeting } = mount({ client });
  paste(RUTUBE);
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

it('набранную по букве ссылку не спрашивают на паузах — только по Enter или кнопкой «Открыть ссылку»', async () => {
  const { client } = mount();
  typeByHand('https://ok.ru/video/1');
  await new Promise((done) => setTimeout(done, 600));
  expect(asked).toEqual([]);
  expect(screen.getByText('Открыть эту ссылку?')).toBeInTheDocument();
  fireEvent.keyDown(field(), { key: 'Enter' });
  expect(await screen.findByRole('heading', { name: 'Фильм с ok.ru' })).toBeInTheDocument();
  expect(asked).toEqual(['https://ok.ru/video/1']);

  // Дописали другую руками — снова ни одного вопроса, пока не нажали кнопку.
  fireEvent.change(field(), { target: { value: '' } });
  typeByHand('https://archive.org/details/show');
  await new Promise((done) => setTimeout(done, 600));
  expect(asked).toEqual(['https://ok.ru/video/1']);
  fireEvent.click(screen.getByRole('button', { name: /Открыть ссылку/ }));
  expect(await screen.findByRole('heading', { name: SHOW.title })).toBeInTheDocument();
  expect(asked).toEqual(['https://ok.ru/video/1', 'https://archive.org/details/show']);
  client.clear();
});

it('новая ссылка обрывает вопрос о прежней: ответ на неё уже никому не нужен', async () => {
  let release = () => {};
  gate = new Promise((done) => (release = done));
  const { client } = mount();
  paste(UNKNOWN);
  await waitFor(() => expect(asked).toEqual([UNKNOWN]));
  paste('https://ok.ru/video/1');
  await waitFor(() => expect(asked).toEqual([UNKNOWN, 'https://ok.ru/video/1']));
  expect(signals[0]?.aborted).toBe(true);
  expect(signals[1]?.aborted).toBe(false);
  act(() => release());
  expect(await screen.findByRole('heading', { name: 'Фильм с ok.ru' })).toBeInTheDocument();
  expect(screen.queryByText(REASON)).toBeNull();

  // Стёрли набранное — вопрос в пути тоже обрывается.
  gate = new Promise((done) => (release = done));
  paste('https://archive.org/details/show');
  await waitFor(() => expect(asked).toHaveLength(3));
  fireEvent.click(screen.getByRole('button', { name: 'Очистить поиск' }));
  expect(signals[2]?.aborted).toBe(true);
  act(() => release());
  expect(screen.getByText('Вставьте ссылку на видео')).toBeInTheDocument();
  client.clear();
});
