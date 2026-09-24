import { expect, test, type Browser } from '@playwright/test';
import { fixture, inviteLink, joinMeeting, openCinema, routeCinema, startMeeting } from './support/cinema';
import { DOWN, vkAnswers, type Card, type Feed } from './support/vk';

/*
  Кинозал VK Видео на записанных ответах службы: разделы площадки вкладками, лента раздела с
  продолжением, поиск с полкой сообществ, сообщество с вкладками «Видео» и «Плейлисты», плейлист, а
  «Смотреть вместе» открывает плеер у двух браузеров. И отдельно — ссылка, вставленная в поиск:
  она открывает ролик и тогда, когда каталог VK лежит.

  Ответы сняты настоящей службой с настоящего VK Видео 24.09.2026 (`fixtures/cinema/vk-*.json`,
  собраны `.local/vk/build-fixtures.mjs`), картинки — одна серая заглушка, поток — свой HLS на
  двенадцать секунд. Ни службы, ни площадки сценарию не нужно — он идёт и в CI. Числа карточек
  берутся из тех же записей, что отдаёт перехват: обрезка фикстур не разойдётся с ожиданиями молча.
*/

const context = (browser: Browser, width: number, height: number) =>
  browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width, height } });

interface Sections {
  items: { id: string; title: string }[];
}

test('the VK catalogue is walked on recorded answers: sections, search, a community and its playlist', async ({
  browser,
}) => {
  const room = await context(browser, 1440, 960);
  const page = await room.newPage();
  const cinema = await routeCinema(page, vkAnswers());
  try {
    await startMeeting(page);
    const browse = await openCinema(page, 'VK Видео');
    await expect(browse.locator('.cinema-platform')).toHaveText('VK Видео');
    await expect(browse.locator('.cinema-search input')).toHaveAttribute('placeholder', 'Видео и сообщества');

    // Разделы — те, что отдала площадка, в её порядке; первый («Все») открыт сразу.
    const sections = fixture<Sections>('vk-categories').items;
    const chips = browse.getByRole('tablist', { name: 'Разделы VK Видео' });
    await expect(chips.getByRole('tab')).toHaveText(sections.map((entry) => entry.title));
    await expect(chips.getByRole('tab', { name: 'Все' })).toHaveAttribute('aria-selected', 'true');
    // Ряд разделов виден целиком, а не полоской (тот же ряд, что у Rutube, в той же полосе).
    const tab = await chips.getByRole('tab', { name: 'Все' }).boundingBox();
    const row = await chips.boundingBox();
    expect(row!.height).toBeGreaterThanOrEqual(tab!.height);

    // Лента раздела — сеткой 16:9 с продолжением: вторая порция приезжает под первой.
    const first = fixture<Feed>('vk-category');
    const second = fixture<Feed>('vk-category-2');
    await expect(browse.locator('.cinema-tile-title').first()).toHaveText(first.items[0]!.title);
    // «Показать ещё» нажимает и сама лента, когда доезжает до конца (наблюдатель): кнопка может
    // пропасть прямо из-под нажатия — поэтому нажатие повторяется, пока не приедет вся лента.
    const more = browse.getByRole('button', { name: 'Показать ещё' });
    const tiles = browse.locator('.cinema-grid > .cinema-tile');
    await expect(async () => {
      if (await more.isVisible()) await more.dispatchEvent('click', undefined, { timeout: 1000 });
      await expect(tiles).toHaveCount(first.items.length + second.items.length, { timeout: 1000 });
    }).toPass({ timeout: 15000 });
    expect(
      cinema.calls.some((call) => call.endpoint === 'category' && call.params.get('cursor') === '1'),
    ).toBe(true);
    const tile = browse.locator('.cinema-grid > .cinema-tile').first();
    await expect(tile.locator('.cinema-duration')).toBeVisible();
    await expect(tile.locator('.cinema-author')).toHaveText(first.items[0]!.author);

    // Другой раздел — нажатием; лента меняется на месте.
    const music = sections.find((entry) => entry.title === 'Музыка')!;
    await chips.getByRole('tab', { name: 'Музыка' }).click();
    const songs = fixture<Feed>('vk-category-music');
    await expect(browse.locator('.cinema-tile-title').first()).toHaveText(songs.items[0]!.title);
    await expect(browse.locator('.cinema-grid > .cinema-tile')).toHaveCount(songs.items.length);
    expect(
      cinema.calls.some((call) => call.endpoint === 'category' && call.params.get('id') === music.id),
    ).toBe(true);

    // Поиск: сообщества полкой над роликами.
    const found = fixture<Feed>('vk-search');
    await browse.locator('.cinema-search input').fill('маша и медведь');
    const shelf = browse.getByRole('region', { name: 'Сообщества' });
    await expect(shelf.locator('.cinema-tile-face')).toHaveCount(found.channels!.length);
    await expect(browse.locator('.cinema-grid > .cinema-tile')).toHaveCount(found.items.length);
    await expect(chips).toHaveCount(0);

    // Сообщество: шапка и две вкладки; плейлисты — дверями, плейлист — своей страницей.
    const channel = fixture<Feed & { channel: { title: string } }>('vk-channel-videos');
    await shelf.locator('.cinema-tile-face .cinema-open').first().click();
    await expect(browse.locator('.cinema-channel-head h3')).toHaveText(channel.channel.title);
    const tabs = browse.getByRole('tablist', { name: 'Разделы канала' });
    await expect(tabs.getByRole('tab')).toHaveText(['Видео', 'Плейлисты']);
    await expect(browse.locator('.cinema-grid > .cinema-tile')).toHaveCount(channel.items.length);
    await tabs.getByRole('tab', { name: 'Плейлисты' }).click();
    const albums = fixture<Feed>('vk-channel-playlists');
    await expect(browse.locator('.cinema-tile-list')).toHaveCount(albums.items.length);
    const album = fixture<Feed & { playlist: { title: string } }>('vk-playlist');
    await browse.getByRole('button', { name: `Открыть плейлист: ${albums.items[0]!.title}` }).click();
    await expect(browse.locator('.cinema-detail-list h3')).toHaveText(album.playlist.title);
    await expect(browse.locator('.cinema-grid > .cinema-tile')).toHaveCount(album.items.length);

    // «Назад» проходит стопку: плейлист → сообщество → поиск.
    await browse.getByRole('button', { name: 'Назад' }).click();
    await expect(browse.locator('.cinema-channel-head h3')).toHaveText(channel.channel.title);
    await browse.getByRole('button', { name: 'Назад' }).click();
    await expect(shelf).toBeVisible();
  } finally {
    await room.close();
  }
});

test('watching a VK video together opens the player for both browsers', async ({ browser }) => {
  // Два браузера и два входа во встречу: обычного срока тут мало.
  test.slow();
  const first = await context(browser, 1440, 960);
  const second = await context(browser, 1280, 900);
  const host = await first.newPage();
  const guest = await second.newPage();
  await routeCinema(host, vkAnswers());
  await routeCinema(guest, vkAnswers());
  try {
    await startMeeting(host, 'Майс');
    await joinMeeting(guest, await inviteLink(host), 'Алекс');

    const browse = await openCinema(host, 'VK Видео');
    const video = fixture<Feed>('vk-category').items[0]!;
    await browse.getByRole('button', { name: `Подробнее: ${video.title}`, exact: true }).click();
    await expect(browse.locator('.cinema-detail h3')).toHaveText(video.title);
    await browse.getByRole('button', { name: /Смотреть вместе/ }).click();

    for (const page of [host, guest]) {
      await expect(page.locator('.watch-theater')).toBeVisible();
      await expect(page.locator('.people-strip .person-tile')).toHaveCount(2);
      await expect(page.locator('.watch-title b')).toHaveText(video.title);
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
    await expect(host.locator('.cinema-browser .cinema-platform')).toHaveText('VK Видео');
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

test('a pasted VK link opens its video even when the VK catalogue is down', async ({ browser }) => {
  const room = await context(browser, 1440, 960);
  const page = await room.newPage();
  const cinema = await routeCinema(page, vkAnswers({ down: true }));
  try {
    await startMeeting(page);
    const browse = await openCinema(page, 'VK Видео');
    // Каталог молчит — сцена так и говорит, и подсказывает, что ссылка всё равно откроется.
    await expect(browse.getByText('Каталог VK Видео сейчас не открывается')).toBeVisible();
    await expect(
      browse.getByText(`${DOWN}. Ролик или эфир VK всё равно откроется по ссылке`, { exact: false }),
    ).toBeVisible();

    await browse.locator('.cinema-search input').fill('https://vkvideo.ru/video-22277933_456242381');
    await expect(browse.locator('.cinema-detail h3')).toHaveText('Видео VK по ссылке');
    await expect(browse.locator('.cinema-detail').getByText(DOWN)).toBeVisible();
    await browse.getByRole('button', { name: /Смотреть вместе/ }).click();

    // Имя в плеере — от разбора потока: служба знает его и без каталога площадки.
    await expect(page.locator('.watch-theater')).toBeVisible();
    await expect(page.locator('.watch-title b')).toHaveText(fixture<Feed>('vk-search').items[0]!.title);
    const resolved = cinema.calls.find((call) => call.endpoint === 'resolve');
    expect(resolved?.body).toMatchObject({ provider: 'vk', contentId: '-22277933_456242381', kind: 'video' });
    // Ссылку служба не искала: это адрес, а не слова.
    expect(cinema.calls.filter((call) => call.endpoint === 'search')).toEqual([]);
  } finally {
    await room.close();
  }
});

test('a pasted VK Video Live link opens the stream to the room as a live channel', async ({ browser }) => {
  const room = await context(browser, 1440, 960);
  const page = await room.newPage();
  const cinema = await routeCinema(page, vkAnswers());
  try {
    await startMeeting(page);
    const browse = await openCinema(page, 'VK Видео');
    const stream = fixture<Card & { category: string }>('vk-details-live');
    await browse.locator('.cinema-search input').fill('https://live.vkvideo.ru/near_you');
    await expect(browse.locator('.cinema-detail h3')).toHaveText(stream.title);
    await expect(browse.locator('.cinema-detail .cinema-live')).toHaveText('В эфире');
    // У канала Live нет страницы сообщества — и двери на неё нет.
    await expect(browse.getByRole('button', { name: 'Открыть канал' })).toHaveCount(0);
    await browse.getByRole('button', { name: /Смотреть вместе/ }).click();

    await expect(page.locator('.watch-theater')).toBeVisible();
    await expect(page.locator('.watch-title b')).toHaveText(stream.title);
    await expect(page.locator('.watch-title small')).toContainText('Эфир');
    const resolved = cinema.calls.find((call) => call.endpoint === 'resolve');
    expect(resolved?.body).toMatchObject({ provider: 'vk', contentId: 'near_you', kind: 'channel' });

    // «Каталог» с плеера открывает сцену VK — ту же, из которой эфир включили.
    await page.locator('.watch-theater').hover();
    await page.getByRole('button', { name: 'Каталог', exact: true }).click();
    await expect(page.locator('.cinema-browser .cinema-platform')).toHaveText('VK Видео');
  } finally {
    await room.close();
  }
});
