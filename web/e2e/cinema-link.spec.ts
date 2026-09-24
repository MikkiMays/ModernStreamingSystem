import { expect, test, type Browser } from '@playwright/test';
import {
  UNKNOWN_LINK,
  combine,
  fixture,
  inviteLink,
  joinMeeting,
  openCinema,
  routeCinema,
  startMeeting,
  type CinemaOverrides,
} from './support/cinema';
import { RUTUBE } from './support/rutube';
import { vkAnswers } from './support/vk';

/*
  Ссылки в кинозале на записанных ответах службы: ссылка площадки из каталога открывает сцену этой
  площадки сразу на своей странице — откуда бы её ни вставили, — незнакомая ссылка остаётся в сцене
  «По ссылке» с причиной словами, а недавние ссылки профиль помнит между открытиями.

  Чья ссылка, отвечает служба (`POST …/cinema/link`); здесь её грамматику для ссылок сценария
  играет перехват (`support/cinema.ts`), а страницы — записи Rutube, VK и YouTube. Ни службы, ни
  площадок сценарию не нужно — он идёт и в CI.
*/

const context = (browser: Browser) =>
  browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1440, height: 960 } });

/*
  Общий путь (задача 15b): ссылка без своей площадки. Ответы службы — настоящие, сняты со стенда
  25.09.2026 (Дзен и коллекция роликов archive.org; обложки — серая запись), поток — свой HLS.
*/
interface LinkCard {
  id: string;
  title: string;
  author: string;
}
const FILM_URL = 'https://dzen.ru/video/watch/6002240ff8b1af50bb2da5e3';
const SHOW_URL = 'https://archive.org/details/Election_Ads';
const FILM = fixture<{ item: LinkCard }>('link-video').item;
const SHOW = fixture<{ item: LinkCard }>('link-series').item;
const EPISODES = fixture<{ items: LinkCard[] }>('link-series-page').items;

/** Служба для ссылок без своей площадки: карточка, серии плейлиста и поток — по номеру ссылки. */
const general = (): CinemaOverrides => ({
  link: ({ body }) => {
    const url = String(body?.url ?? '').trim();
    if (url === FILM_URL) return fixture('link-video');
    if (url === SHOW_URL) return fixture('link-series');
    return undefined;
  },
  series: ({ params }) => (params.get('provider') === 'link' ? fixture('link-series-page') : undefined),
  resolve: ({ body }) => {
    if (body?.provider !== 'link') return undefined;
    const known = [FILM, ...EPISODES].find((card) => card.id === body.contentId);
    return {
      ...fixture('youtube-resolve'),
      provider: 'link',
      contentId: body.contentId,
      title: known?.title ?? String(body.contentId),
      author: known?.author ?? '',
      language: '',
      captions: [],
      expiresAt: Date.now() + 5 * 3600 * 1000,
    };
  },
});

const EPISODE = fixture<{ id: string; title: string }>('rutube-details');
const SERIES = `https://rutube.ru/video/${EPISODE.id}/`;
const MASHA = fixture<{ items: { id: string; title: string }[] }>('vk-search').items[0]!;
const ROLL = fixture<{ id: string; title: string }>('youtube-details');

test('a pasted link opens the scene of its own platform on its page, wherever it was pasted', async ({
  browser,
}) => {
  const room = await context(browser);
  const page = await room.newPage();
  const cinema = await routeCinema(page, combine(RUTUBE, vkAnswers()));
  try {
    await startMeeting(page);
    const browse = await openCinema(page, 'По ссылке');
    await expect(browse.locator('.cinema-platform')).toHaveText('По ссылке');
    const field = browse.locator('.cinema-search input');
    await expect(field).toHaveAttribute('placeholder', 'Вставьте ссылку на видео');

    // Rutube — из «По ссылке»: сцена Rutube, сразу страница выпуска.
    await field.fill(SERIES);
    await expect(browse.locator('.cinema-platform')).toHaveText('Rutube');
    await expect(browse.locator('.cinema-detail h3')).toHaveText(EPISODE.title);
    await expect(browse.getByRole('button', { name: 'Все серии' })).toBeVisible();

    // VK — из поиска Rutube: сцена VK Видео, страница серии «Маши и Медведя».
    await browse.locator('.cinema-search input').fill(`https://vkvideo.ru/video${MASHA.id}`);
    await expect(browse.locator('.cinema-platform')).toHaveText('VK Видео');
    await expect(browse.locator('.cinema-detail h3')).toHaveText(MASHA.title);

    // YouTube — из поиска VK: переключатель на вкладке YouTube, страница ролика.
    await browse.locator('.cinema-search input').fill(`https://youtu.be/${ROLL.id}`);
    await expect(browse.getByRole('tab', { name: 'YouTube' })).toHaveAttribute('aria-selected', 'true');
    await expect(browse.locator('.cinema-detail h3')).toHaveText(ROLL.title);
    // Поле поиска снова пустое, а «Назад» ведёт на витрину площадки, а не к поиску по адресу.
    await expect(browse.locator('.cinema-search input')).toHaveValue('');
    await browse.getByRole('button', { name: 'Назад' }).click();
    await expect(browse.locator('.cinema-empty')).toContainText('Что включим комнате?');

    // Каждую ссылку служба узнала одним вопросом, и ни одну не искали как слова.
    expect(cinema.calls.filter((call) => call.endpoint === 'link').map((call) => call.body?.url)).toEqual([
      SERIES,
      `https://vkvideo.ru/video${MASHA.id}`,
      `https://youtu.be/${ROLL.id}`,
    ]);
    expect(
      cinema.calls.filter(
        (call) => call.endpoint === 'search' && /^https?:/.test(call.params.get('query') ?? ''),
      ),
    ).toEqual([]);
    expect(cinema.calls.map((call) => `${call.params.get('provider')}:${call.endpoint}`)).toEqual(
      expect.arrayContaining(['rutube:details', 'vk:details', 'youtube:details']),
    );
  } finally {
    await room.close();
  }
});

test('an unknown link lands in «По ссылке» with the reason', async ({ browser }) => {
  const room = await context(browser);
  const page = await room.newPage();
  await routeCinema(page);
  try {
    await startMeeting(page);
    const browse = await openCinema(page, 'YouTube');
    await browse.locator('.cinema-search input').fill('https://example.com/films/1/video.mp4');
    await expect(browse.locator('.cinema-platform')).toHaveText('По ссылке');
    await expect(browse.locator('.cinema-search input')).toHaveValue('https://example.com/films/1/video.mp4');
    await expect(browse.getByText(UNKNOWN_LINK)).toBeVisible();
    // Никуда не привела — в недавние не встала.
    await browse.locator('.cinema-search input').fill('');
    await expect(browse.getByText('Вставьте ссылку на видео')).toBeVisible();
    await expect(browse.getByRole('region', { name: 'Недавние ссылки' })).toHaveCount(0);
  } finally {
    await room.close();
  }
});

test('recent links are remembered by the profile and open again from «По ссылке»', async ({ browser }) => {
  const room = await context(browser);
  const page = await room.newPage();
  const cinema = await routeCinema(page, RUTUBE);
  try {
    await startMeeting(page);
    let browse = await openCinema(page, 'По ссылке');
    await expect(browse.getByRole('region', { name: 'Недавние ссылки' })).toHaveCount(0);
    await browse.locator('.cinema-search input').fill(SERIES);
    await expect(browse.locator('.cinema-detail h3')).toHaveText(EPISODE.title);
    await browse.getByRole('button', { name: 'Закрыть кинотеатр' }).click();
    await expect(browse).toHaveCount(0);

    // Каталог открыт заново — ссылка первой в недавних; её помнит профиль, а не открытая сцена.
    browse = await openCinema(page, 'По ссылке');
    const recent = browse.getByRole('region', { name: 'Недавние ссылки' });
    await expect(recent.getByRole('button')).toHaveText([`rutube.ru/video/${EPISODE.id}/`]);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('cord:preferences:v1') ?? '{}'));
    expect(saved.cinemaLinks).toEqual([SERIES]);

    await recent.getByRole('button').click();
    await expect(browse.locator('.cinema-platform')).toHaveText('Rutube');
    await expect(browse.locator('.cinema-detail h3')).toHaveText(EPISODE.title);
    // Ответ о ссылке служба дала один раз: второе открытие — из памяти ответов.
    expect(cinema.calls.filter((call) => call.endpoint === 'link')).toHaveLength(1);
  } finally {
    await room.close();
  }
});

test('a link without its own platform shows what the page has and plays for both browsers', async ({
  browser,
}) => {
  // Два браузера и два входа во встречу: обычного срока тут мало.
  test.slow();
  const first = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: { width: 1440, height: 960 },
  });
  const second = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: { width: 1280, height: 900 },
  });
  const host = await first.newPage();
  const guest = await second.newPage();
  const cinema = await routeCinema(host, general());
  await routeCinema(guest, general());
  try {
    await startMeeting(host, 'Майс');
    await joinMeeting(guest, await inviteLink(host), 'Алекс');

    const browse = await openCinema(host, 'По ссылке');
    await browse.locator('.cinema-search input').fill(FILM_URL);
    await expect(browse.locator('.cinema-detail h3')).toHaveText(FILM.title);
    const facts = browse.locator('.cinema-link-facts');
    await expect(facts).toContainText('dzen.ru');
    await expect(facts.locator('.cinema-link-qualities .cinema-chip')).toHaveText([
      '720p',
      '480p',
      '360p',
      '240p',
      '144p',
    ]);
    await expect(facts).toContainText('Русский');
    await browse
      .locator('.cinema-detail-actions')
      .getByRole('button', { name: /Смотреть вместе/ })
      .click();

    for (const page of [host, guest]) {
      await expect(page.locator('.watch-theater')).toBeVisible();
      await expect(page.locator('.people-strip .person-tile')).toHaveCount(2);
      await expect(page.locator('.watch-title b')).toHaveText(FILM.title);
      await expect(page.locator('.watch-play')).toHaveAttribute('aria-label', 'Пауза для всех');
      await expect
        .poll(() => page.locator('.watch-video').evaluate((element: HTMLVideoElement) => element.currentTime))
        .toBeGreaterThan(1);
    }
    await expect
      .poll(() => guest.locator('.watch-video').evaluate((element: HTMLVideoElement) => element.duration))
      .toBeCloseTo(12, 0);
    // Пауза общая: гость ставит на паузу — у ведущего тоже пауза.
    await guest.locator('.watch-theater').hover();
    await guest.locator('.watch-play').click();
    await expect(host.locator('.watch-play')).toHaveAttribute('aria-label', 'Включить для всех');

    // Поток спрошен номером ссылки, а не адресом: адрес страницы служба помнит сама.
    const resolved = cinema.calls.filter((call) => call.endpoint === 'resolve');
    expect(resolved[0]?.body).toMatchObject({ provider: 'link', contentId: FILM.id, kind: 'video' });
    expect(JSON.stringify(resolved.map((call) => call.body))).not.toContain('dzen.ru');
    // В недавние встала ссылка, которая привела к видео.
    const saved = await host.evaluate(() => JSON.parse(localStorage.getItem('cord:preferences:v1') ?? '{}'));
    expect(saved.cinemaLinks).toEqual([FILM_URL]);
  } finally {
    await first.close();
    await second.close();
  }
});

test('a playlist link lists its episodes and the one picked plays for the room', async ({ browser }) => {
  const room = await context(browser);
  const page = await room.newPage();
  const cinema = await routeCinema(page, general());
  try {
    await startMeeting(page);
    const browse = await openCinema(page, 'По ссылке');
    await browse.locator('.cinema-search input').fill(SHOW_URL);
    await expect(browse.locator('.cinema-detail h3')).toHaveText(SHOW.title);
    const tiles = browse.locator('.cinema-grid > .cinema-tile');
    await expect(tiles).toHaveCount(EPISODES.length);
    await expect(tiles.locator('.cinema-tile-title')).toHaveText(EPISODES.map((episode) => episode.title));
    await expect(browse.locator('.cinema-link-facts')).toContainText('archive.org');

    // Серию включают прямо с плитки — вторую, а не первую попавшуюся.
    const picked = EPISODES[1]!;
    const tile = tiles.nth(1);
    await tile.hover();
    await tile.getByRole('button', { name: `Смотреть вместе: ${picked.title}` }).click();
    await expect(page.locator('.watch-theater')).toBeVisible();
    await expect(page.locator('.watch-title b')).toHaveText(picked.title);
    await expect
      .poll(() => page.locator('.watch-video').evaluate((element: HTMLVideoElement) => element.currentTime))
      .toBeGreaterThan(1);

    const resolved = cinema.calls.find((call) => call.endpoint === 'resolve');
    expect(resolved?.body).toMatchObject({ provider: 'link', contentId: picked.id, kind: 'video' });
    // Серии — страницей сериала службы, одним вопросом.
    expect(
      cinema.calls.filter((call) => call.endpoint === 'series').map((call) => call.params.get('id')),
    ).toEqual([SHOW.id]);
  } finally {
    await room.close();
  }
});

test('a link typed by hand is asked only on Enter — pauses in typing ask the service nothing', async ({
  browser,
}) => {
  const room = await context(browser);
  const page = await room.newPage();
  const cinema = await routeCinema(page, general());
  try {
    await startMeeting(page);
    const browse = await openCinema(page, 'По ссылке');
    const field = browse.locator('.cinema-search input');
    // Набор с паузами длиннее прежней паузы поиска (420 мс): каждая была бы разбором чужой страницы.
    await field.pressSequentially(FILM_URL.slice(0, 20), { delay: 20 });
    await page.waitForTimeout(700);
    await field.pressSequentially(FILM_URL.slice(20), { delay: 20 });
    await page.waitForTimeout(700);
    await expect(browse.getByRole('button', { name: 'Открыть ссылку' })).toBeVisible();
    expect(cinema.calls.filter((call) => call.endpoint === 'link')).toEqual([]);

    await field.press('Enter');
    await expect(browse.locator('.cinema-detail h3')).toHaveText(FILM.title);
    expect(cinema.calls.filter((call) => call.endpoint === 'link').map((call) => call.body?.url)).toEqual([
      FILM_URL,
    ]);
  } finally {
    await room.close();
  }
});
