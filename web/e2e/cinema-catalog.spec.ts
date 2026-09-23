import { expect, test, type Browser } from '@playwright/test';
import { fixture, inviteLink, joinMeeting, openCinema, routeCinema, startMeeting } from './support/cinema';

/*
  Кинозал на записанных ответах службы: каталог ходится, а «Смотреть вместе» открывает плеер.

  Здесь проверяется то же, что в `watch.spec.ts`, но без площадок и без службы: ответы — с
  прода, поток — свой HLS на двенадцать секунд (см. `support/cinema.ts`). Поэтому сценарий
  идёт всегда, в том числе в CI, и падает только от поломки у нас, а не от настроения YouTube.
  Числа карточек берутся из тех же записей, что отдаёт перехват, — чтобы обрезка фикстур не
  расходилась с ожиданиями молча.
*/

/** Лента, как её отдаёт служба: карточки, полка каналов и продолжение. */
interface Feed {
  items: { id: string; title: string; author: string }[];
  channels?: { id: string }[];
  next: string | null;
}

const context = (browser: Browser, width: number, height: number) =>
  browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width, height } });

test('the catalogue is walked on recorded answers: search, channel, more, playlists, Twitch', async ({
  browser,
}) => {
  const room = await context(browser, 1440, 960);
  const page = await room.newPage();
  const cinema = await routeCinema(page);
  try {
    await startMeeting(page);
    const browse = await openCinema(page, 'YouTube');
    // Пока ничего не набрано, YouTube показывает подсказки, а не ленту: спрашивать ещё не о чем.
    await expect(browse.locator('.cinema-empty')).toContainText('Что включим комнате?');

    const found = fixture<Feed>('youtube-search-big-buck-bunny');
    await browse.locator('.cinema-search input').fill('big buck bunny');
    // Каналы — полкой над лентой, ролики — лентой под ней.
    await expect(browse.locator('.cinema-tile-face')).toHaveCount(found.channels!.length);
    const results = browse.locator('.cinema-tile:not(.cinema-tile-face)');
    await expect(results).toHaveCount(found.items.length);
    await expect(results.first().locator('.cinema-tile-title')).toHaveText(found.items[0]!.title);

    // Имя автора под роликом — дверь на его канал.
    const channel = fixture<Feed & { channel: { title: string } }>('youtube-channel-videos');
    await results.first().getByRole('button', { name: found.items[0]!.author, exact: true }).click();
    await expect(browse.locator('.cinema-channel-head h3')).toHaveText(channel.channel.title);
    const videos = browse.locator('.cinema-tile');
    await expect(videos).toHaveCount(channel.items.length);

    // Лента канала продолжается: «Показать ещё» приносит вторую страницу и исчезает на конце.
    // Нажатие — без прокрутки: докрученную до неё кнопку наблюдатель жмёт за человека сам, и
    // `click()` Playwright, который прокручивает к цели, гонялся бы с ним за исчезающую кнопку.
    const more = browse.getByRole('button', { name: 'Показать ещё' });
    const rest = fixture<Feed>('youtube-channel-videos-30');
    const continued = () =>
      cinema.calls.some((call) => call.endpoint === 'channel' && call.params.get('cursor') === '30');
    // Кнопка ниже края ленты: сама лента продолжения ещё не просила.
    expect(continued()).toBe(false);
    await more.dispatchEvent('click');
    await expect(videos).toHaveCount(channel.items.length + rest.items.length);
    await expect(more).toHaveCount(0);
    expect(continued()).toBe(true);

    // Вкладка «Плейлисты», плейлист и обратная дорога — на канал, а не из каталога.
    const lists = fixture<Feed>('youtube-channel-playlists');
    await browse.getByRole('tab', { name: 'Плейлисты' }).click();
    await expect(browse.locator('.cinema-tile-list')).toHaveCount(lists.items.length);
    const playlist = fixture<Feed & { playlist: { title: string } }>('youtube-playlist');
    await browse.locator('.cinema-tile-list .cinema-open').first().click();
    await expect(browse.locator('.cinema-detail-list h3')).toHaveText(playlist.playlist.title);
    await expect(browse.locator('.cinema-tile')).toHaveCount(playlist.items.length);
    await browse.getByRole('button', { name: 'Назад' }).click();
    await expect(browse.locator('.cinema-channel-head')).toBeVisible();
    await browse.getByRole('tab', { name: 'О канале' }).click();
    await expect(browse.locator('.cinema-story')).toContainText('Official YouTube channel for Blender');

    // Twitch начинается с витрины эфиров, а разделы стоят рядом с ней.
    const live = fixture<Feed>('twitch-search');
    await browse.getByRole('tab', { name: 'Twitch' }).click();
    await expect(browse.locator('.cinema-tile')).toHaveCount(live.items.length);
    await expect(browse.locator('.cinema-live').first()).toHaveText('В эфире');
    const shelves = fixture<Feed>('twitch-categories');
    await browse.getByRole('tab', { name: 'Категории' }).click();
    const boxes = browse.locator('.cinema-tile-box');
    await expect(boxes).toHaveCount(shelves.items.length);
    const category = fixture<Feed & { category: { title: string } }>('twitch-category');
    await boxes.first().locator('.cinema-open').click();
    await expect(browse.locator('.cinema-category-head h3')).toHaveText(category.category.title);
    await expect(browse.locator('.cinema-tile')).toHaveCount(category.items.length);
  } finally {
    await room.close();
  }
});

test('watching together opens the player for both browsers, and the catalogue opens over it', async ({
  browser,
}) => {
  // Два браузера и два входа во встречу: обычного срока тут мало.
  test.slow();
  const first = await context(browser, 1440, 960);
  const second = await context(browser, 1280, 900);
  const host = await first.newPage();
  const guest = await second.newPage();
  await routeCinema(host);
  await routeCinema(guest);
  try {
    await startMeeting(host, 'Майс');
    await joinMeeting(guest, await inviteLink(host), 'Алекс');

    const browse = await openCinema(host, 'YouTube');
    // Каталог личный: у гостя на сцене по-прежнему разговор.
    await expect(guest.locator('.cinema-browser')).toHaveCount(0);
    const found = fixture<Feed>('youtube-search-never-gonna-give-you-up');
    const video = found.items[0]!;
    await browse.locator('.cinema-search input').fill('never gonna give you up');
    await browse.getByRole('button', { name: `Подробнее: ${video.title}`, exact: true }).click();
    await expect(browse.locator('.cinema-detail h3')).toHaveText(video.title);
    await browse.getByRole('button', { name: /Смотреть вместе/ }).click();

    // Плеер открывается у обоих, люди переезжают в ленту под ним, каталог уходит.
    for (const page of [host, guest]) {
      await expect(page.locator('.watch-theater')).toBeVisible();
      await expect(page.locator('.people-strip .person-tile')).toHaveCount(2);
      await expect(page.locator('.watch-title b')).toHaveText(video.title);
    }
    await expect(host.locator('.cinema-browser')).toHaveCount(0);
    // Поток свой: двенадцать секунд из фикстур, и плеер его действительно разобрал.
    await expect
      .poll(() => host.locator('.watch-video').evaluate((element: HTMLVideoElement) => element.duration))
      .toBeCloseTo(12, 0);

    // Ролик открывается на паузе и включается, когда плеер принёсшего готов; пауза общая.
    // Кнопка — переключатель по состоянию комнаты, поэтому гость жмёт её, только когда и у
    // него комната уже играет: иначе его нажатие было бы «включить», а не «пауза».
    for (const page of [host, guest])
      await expect(page.locator('.watch-play')).toHaveAttribute('aria-label', 'Пауза для всех');
    await guest.locator('.watch-theater').hover();
    await guest.locator('.watch-play').click();
    await expect(host.locator('.watch-play')).toHaveAttribute('aria-label', 'Включить для всех');

    // Качество — из лестницы потока: две ступени и «Автоматически» (с той, что выбрал сам плеер).
    await host.locator('.watch-theater').hover();
    await host.getByRole('button', { name: 'Качество картинки и язык звука' }).click();
    const menu = host.locator('.watch-quality-menu');
    await menu.getByRole('menuitem', { name: /Качество/ }).click();
    await expect(menu.getByRole('menuitem')).toHaveText([/^Автоматически/, '180p', '144p']);
    await host.keyboard.press('Escape');

    // Каталог открывается поверх плеера, не разбирая его.
    await host.locator('.watch-theater').hover();
    await host.getByRole('button', { name: 'Каталог', exact: true }).click();
    await expect(host.locator('.cinema-browser')).toBeVisible();
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
