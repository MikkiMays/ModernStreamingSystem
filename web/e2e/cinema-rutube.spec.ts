import { expect, test, type Browser } from '@playwright/test';
import {
  fixture,
  inviteLink,
  joinMeeting,
  openCinema,
  routeCinema,
  startMeeting,
  type CinemaOverrides,
} from './support/cinema';

/*
  Кинозал Rutube на записанных ответах службы: витрина, раздел, сериал с сезонами, поиск и канал,
  а «Смотреть вместе» открывает плеер у двух браузеров — и серию, и эфир ТВ.

  Ответы сняты настоящей службой с настоящего Rutube 24.09.2026 (`fixtures/cinema/rutube-*.json`,
  собраны `.local/rutube/build-fixtures.mjs`), картинки — одна серая заглушка, поток — свой HLS на
  двенадцать секунд. Ни службы, ни площадки сценарию не нужно — он идёт и в CI. Числа карточек
  берутся из тех же записей, что отдаёт перехват: обрезка фикстур не разойдётся с ожиданиями молча.
*/

interface Card {
  id: string;
  kind: string;
  title: string;
  author: string;
  live: boolean;
  badge?: string;
}
interface Feed {
  items: Card[];
  channels?: Card[];
  series?: Card[];
  next: string | null;
}

/** Столько живёт подпись у настоящей службы; от «сейчас», иначе плеер пошёл бы её обновлять. */
const SIGNATURE_MS = 5 * 3600 * 1000;
const END = { items: [], channels: [], categories: [], series: [], next: null };

/** Все карточки записанных ответов — по id: страница и поток показывают то, что нажато. */
function face(id: string): Card | undefined {
  for (const name of [
    'rutube-search-empty',
    'rutube-search',
    'rutube-category',
    'rutube-series',
    'rutube-series-season-2',
    'rutube-channel-videos',
  ]) {
    const page = fixture<Feed>(name);
    // У страницы сериала `series` — его шапка, а не полка: карточки берутся только из списков.
    const shelves = [page.series, page.channels].filter((shelf): shelf is Card[] => Array.isArray(shelf));
    const found = [...page.items, ...shelves.flat()].find((card) => card.id === id);
    if (found) return found;
  }
  return undefined;
}

const rutube = (params: URLSearchParams) => params.get('provider') === 'rutube';

/** Rutube отвечает записями; остальные площадки — как всегда, записями `support/cinema.ts`. */
const RUTUBE: CinemaOverrides = {
  search: ({ params }) => {
    if (!rutube(params)) return undefined;
    if (params.get('cursor')) return END;
    return fixture(params.get('query') ? 'rutube-search' : 'rutube-search-empty');
  },
  categories: ({ params }) => (rutube(params) ? fixture('rutube-categories') : undefined),
  category: ({ params }) => {
    if (!rutube(params)) return undefined;
    const page = fixture<{ category: unknown }>('rutube-category');
    return params.get('cursor') ? { category: page.category, items: [], next: null } : page;
  },
  series: ({ params }) => {
    const season = params.get('season');
    if (season === '2') return fixture('rutube-series-season-2');
    const page = fixture<{ season: string }>('rutube-series');
    // Третий сезон не снимали: служба ответила бы его сериями, здесь — пустой сезон.
    return season && season !== page.season ? { ...page, season, items: [] } : page;
  },
  channel: ({ params }) =>
    rutube(params)
      ? fixture(params.get('tab') === 'about' ? 'rutube-channel-about' : 'rutube-channel-videos')
      : undefined,
  details: ({ params }) => {
    if (!rutube(params)) return undefined;
    const id = params.get('id') ?? '';
    const recorded = fixture(params.get('kind') === 'channel' ? 'rutube-details-live' : 'rutube-details');
    const card = face(id);
    return { ...recorded, id, ...(card ? { title: card.title, author: card.author, live: card.live } : {}) };
  },
  resolve: ({ body }) => {
    if (body?.provider !== 'rutube') return undefined;
    const contentId = String(body.contentId ?? '');
    const live = body.kind === 'channel';
    const recorded = fixture<Card>('rutube-resolve');
    const card = face(contentId);
    return {
      ...recorded,
      contentId,
      title: card?.title ?? recorded.title,
      author: card?.author ?? recorded.author,
      live,
      duration: live ? null : 12,
      expiresAt: Date.now() + SIGNATURE_MS,
    };
  },
};

const context = (browser: Browser, width: number, height: number) =>
  browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width, height } });

test('the Rutube catalogue is walked on recorded answers: shelves, a section, a series, search, a channel', async ({
  browser,
}) => {
  const room = await context(browser, 1440, 960);
  const page = await room.newPage();
  const cinema = await routeCinema(page, RUTUBE);
  try {
    await startMeeting(page);
    const browse = await openCinema(page, 'Rutube');
    await expect(browse.locator('.cinema-platform')).toHaveText('Rutube');
    await expect(browse.locator('.cinema-search input')).toHaveAttribute('placeholder', 'Видео, каналы и ТВ');

    // Витрина: эфир ТВ первой полкой, сериалы и шоу — постерами второй.
    const showcase = fixture<Feed>('rutube-search-empty');
    const live = browse.getByRole('region', { name: 'Прямой эфир' });
    await expect(live.locator('.cinema-tile')).toHaveCount(showcase.items.length);
    await expect(live.locator('.cinema-tile-title').first()).toHaveText(showcase.items[0]!.title);
    await expect(live.locator('.cinema-live').first()).toHaveText('В эфире');
    const shows = browse.getByRole('region', { name: 'Сериалы и шоу' });
    await expect(shows.locator('.cinema-tile-tall')).toHaveCount(showcase.series!.length);
    // Витрину и разделы спросили разом, а не одно за другим.
    expect(
      cinema.calls.filter((call) => call.params.get('provider') === 'rutube').map((c) => c.endpoint),
    ).toEqual(expect.arrayContaining(['search', 'categories']));

    // Раздел — вкладкой над витриной: лента раздела на месте полок, «Главная» возвращает их.
    const sections = browse.getByRole('tablist', { name: 'Разделы Rutube' });
    await expect(sections.getByRole('tab', { name: 'Главная' })).toHaveAttribute('aria-selected', 'true');
    await sections.getByRole('tab', { name: 'Мультфильмы' }).click();
    const section = fixture<Feed>('rutube-category');
    await expect(browse.locator('.cinema-tile')).toHaveCount(section.items.length);
    await expect(live).toHaveCount(0);
    expect(cinema.calls.some((call) => call.endpoint === 'category' && call.params.get('id') === '7')).toBe(
      true,
    );
    await sections.getByRole('tab', { name: 'Главная' }).click();
    await expect(live).toBeVisible();

    // Сериал: своя страница, сезоны вкладками, выпуски с номерами.
    const series = fixture<Feed & { series: { title: string; seasons: unknown[] } }>('rutube-series');
    await shows.getByRole('button', { name: `Открыть: ${series.series.title}` }).click();
    await expect(browse.locator('.cinema-detail-tall h3')).toHaveText(series.series.title);
    const seasons = browse.getByRole('tablist', { name: 'Сезоны' });
    await expect(seasons.getByRole('tab')).toHaveCount(series.series.seasons.length);
    await expect(seasons.getByRole('tab', { name: 'Сезон 1' })).toHaveAttribute('aria-selected', 'true');
    await expect(browse.locator('.cinema-tile')).toHaveCount(series.items.length);
    await expect(browse.locator('.cinema-tile .cinema-chip').first()).toHaveText(series.items[0]!.badge!);
    const second = fixture<Feed>('rutube-series-season-2');
    await seasons.getByRole('tab', { name: 'Сезон 2' }).click();
    await expect(browse.locator('.cinema-tile-title').first()).toHaveText(second.items[0]!.title);
    expect(cinema.calls.some((call) => call.endpoint === 'series' && call.params.get('season') === '2')).toBe(
      true,
    );

    // Страница выпуска ведёт обратно ко всем выпускам — и «Назад» проходит стопку до витрины.
    await browse.getByRole('button', { name: `Подробнее: ${second.items[0]!.title}`, exact: true }).click();
    await expect(browse.locator('.cinema-detail h3')).toHaveText(second.items[0]!.title);
    await browse.getByRole('button', { name: 'Все серии' }).click();
    await expect(browse.locator('.cinema-detail-tall h3')).toHaveText(series.series.title);
    for (let step = 0; step < 3; step++) await browse.getByRole('button', { name: 'Назад' }).click();
    await expect(live).toBeVisible();

    // Поиск: каналы и сериалы полками над роликами; канал автора — своей страницей.
    const found = fixture<Feed>('rutube-search');
    await browse.locator('.cinema-search input').fill('универ');
    await expect(browse.locator('.cinema-tile-face')).toHaveCount(found.channels!.length);
    await expect(
      browse.getByRole('region', { name: 'Сериалы и шоу' }).locator('.cinema-tile-tall'),
    ).toHaveCount(found.series!.length);
    await expect(browse.locator('.cinema-grid:not(.cinema-grid-faces) > .cinema-tile')).toHaveCount(
      found.items.length,
    );
    await expect(sections).toHaveCount(0);
    const channel = fixture<{ channel: { title: string; description: string } }>('rutube-channel-videos');
    await browse.locator('.cinema-tile-face .cinema-open').first().click();
    await expect(browse.locator('.cinema-channel-head h3')).toHaveText(channel.channel.title);
    await browse.getByRole('tab', { name: 'О канале' }).click();
    await expect(browse.locator('.cinema-story')).toContainText(channel.channel.description.slice(0, 20));
  } finally {
    await room.close();
  }
});

test('watching a Rutube episode together opens the player for both browsers', async ({ browser }) => {
  // Два браузера и два входа во встречу: обычного срока тут мало.
  test.slow();
  const first = await context(browser, 1440, 960);
  const second = await context(browser, 1280, 900);
  const host = await first.newPage();
  const guest = await second.newPage();
  await routeCinema(host, RUTUBE);
  await routeCinema(guest, RUTUBE);
  try {
    await startMeeting(host, 'Майс');
    await joinMeeting(guest, await inviteLink(host), 'Алекс');

    const browse = await openCinema(host, 'Rutube');
    const series = fixture<Feed & { series: { title: string } }>('rutube-series');
    const episode = series.items[0]!;
    await browse.getByRole('button', { name: `Открыть: ${series.series.title}` }).click();
    await browse.getByRole('button', { name: `Подробнее: ${episode.title}`, exact: true }).click();
    await expect(browse.locator('.cinema-detail h3')).toHaveText(episode.title);
    await browse.getByRole('button', { name: /Смотреть вместе/ }).click();

    for (const page of [host, guest]) {
      await expect(page.locator('.watch-theater')).toBeVisible();
      await expect(page.locator('.people-strip .person-tile')).toHaveCount(2);
      await expect(page.locator('.watch-title b')).toHaveText(episode.title);
    }
    await expect(host.locator('.cinema-browser')).toHaveCount(0);
    await expect
      .poll(() => host.locator('.watch-video').evaluate((element: HTMLVideoElement) => element.duration))
      .toBeCloseTo(12, 0);

    // Пауза общая: гость ставит на паузу — у ведущего тоже пауза.
    for (const page of [host, guest])
      await expect(page.locator('.watch-play')).toHaveAttribute('aria-label', 'Пауза для всех');
    await guest.locator('.watch-theater').hover();
    await guest.locator('.watch-play').click();
    await expect(host.locator('.watch-play')).toHaveAttribute('aria-label', 'Включить для всех');

    // «Каталог» с плеера открывает сцену той площадки, что играет, — поверх плеера.
    await host.locator('.watch-theater').hover();
    await host.getByRole('button', { name: 'Каталог', exact: true }).click();
    await expect(host.locator('.cinema-browser .cinema-platform')).toHaveText('Rutube');
    await expect(host.locator('.watch-theater')).toHaveCount(1);
    await host.getByRole('button', { name: 'Вернуться к просмотру' }).click();
    await expect(host.locator('.cinema-browser')).toHaveCount(0);

    await host.locator('.watch-theater').hover();
    await host.getByRole('button', { name: 'Закрыть просмотр для всех' }).click();
    for (const page of [host, guest]) await expect(page.locator('.watch-theater')).toHaveCount(0);
  } finally {
    await first.close();
    await second.close();
  }
});

test('a live TV channel is opened to the room as a live stream, by the number of its video', async ({
  browser,
}) => {
  const room = await context(browser, 1440, 960);
  const page = await room.newPage();
  const cinema = await routeCinema(page, RUTUBE);
  try {
    await startMeeting(page);
    const browse = await openCinema(page, 'Rutube');
    const channel = fixture<Feed>('rutube-search-empty').items[0]!;
    const tile = browse.getByRole('region', { name: 'Прямой эфир' }).locator('.cinema-tile').first();
    await tile.hover();
    await tile.getByRole('button', { name: `Смотреть вместе: ${channel.title}` }).click();

    await expect(page.locator('.watch-theater')).toBeVisible();
    await expect(page.locator('.watch-title b')).toHaveText(channel.title);
    await expect(page.locator('.watch-title small')).toContainText('Эфир');
    const resolved = cinema.calls.find((call) => call.endpoint === 'resolve');
    expect(resolved?.body).toMatchObject({ provider: 'rutube', contentId: channel.id, kind: 'channel' });
  } finally {
    await room.close();
  }
});
