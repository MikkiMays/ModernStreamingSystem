import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { fixture, inviteLink, joinMeeting, openCinema, routeCinema, startMeeting } from './support/cinema';

/*
  Панель встречи и кинозал на планшетной ширине (900 px): панель там лежит полосой поверх сцены.

  Панель интеграций уступает кинозалу место, когда человек сам открыл каталог или сам включил
  фильм, — и только она. Чат не закрывается ни от чего, что сделал кто-то другой: вместе с ним
  пропало бы недописанное сообщение. Поведение правила по частям проверяет
  `ui/cinema/useYieldToCinema.test.ts`; здесь — что это правда в собранной встрече.
*/

interface Feed {
  items: { title: string }[];
}
const RICK = fixture<Feed>('youtube-search-never-gonna-give-you-up').items[0]!;
const BUNNY = fixture<Feed>('youtube-search-big-buck-bunny').items[0]!;

const context = (browser: Browser, width: number) =>
  browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width, height: 900 } });

/** «Смотреть вместе» на обложке найденного ролика: обложка слева, полоса панели её не накрывает. */
async function watch(browse: Locator, query: string, title: string) {
  await browse.locator('.cinema-search input').fill(query);
  // Внутренний локатор `has` ищется внутри плитки, поэтому строится от страницы, а не от каталога.
  const tile = browse
    .locator('.cinema-tile')
    .filter({ has: browse.page().getByRole('button', { name: `Подробнее: ${title}`, exact: true }) });
  await tile.hover();
  await tile.locator('.cinema-start').click();
}

async function integrations(page: Page) {
  await page.getByRole('button', { name: 'Интеграции', exact: true }).click();
  await expect(page.locator('.services-panel')).toBeVisible();
}

test('a film someone else starts leaves my chat open, draft and all', async ({ browser }) => {
  // Два браузера и два входа во встречу: обычного срока тут мало.
  test.slow();
  const first = await context(browser, 900);
  const second = await context(browser, 1280);
  const host = await first.newPage();
  const guest = await second.newPage();
  await routeCinema(host);
  await routeCinema(guest);
  try {
    await startMeeting(host, 'Майс');
    await joinMeeting(guest, await inviteLink(host), 'Алекс');

    await host.getByRole('button', { name: 'Чат', exact: true }).click();
    const draft = host.getByRole('textbox', { name: 'Сообщение' });
    await draft.fill('Через минуту начнём, я за чаем');

    await watch(await openCinema(guest, 'YouTube'), 'never gonna give you up', RICK.title);
    await expect(host.locator('.watch-theater')).toBeVisible();
    await expect(host.locator('.watch-title b')).toHaveText(RICK.title);
    // Фильм включил не я — чат открыт, сообщение не пропало.
    await expect(draft).toBeVisible();
    await expect(draft).toHaveValue('Через минуту начнём, я за чаем');
  } finally {
    await first.close();
    await second.close();
  }
});

test('my own catalogue and each of my films move the integrations panel aside', async ({ browser }) => {
  const room = await context(browser, 900);
  const page = await room.newPage();
  await routeCinema(page);
  const panel = page.locator('.side-panel');
  try {
    await startMeeting(page);
    // Каталог открыт из панели — панель уступает ему сцену.
    const browse = await openCinema(page, 'YouTube');
    await expect(panel).toHaveCount(0);

    // Панель открыли снова, поверх каталога, и включили фильм — она уступает и ему.
    await integrations(page);
    await watch(browse, 'never gonna give you up', RICK.title);
    await expect(page.locator('.watch-title b')).toHaveText(RICK.title);
    await expect(panel).toHaveCount(0);

    // Следующий фильм — снова своё действие: каталог из панели, панель поверх него, фильм.
    await openCinema(page, 'YouTube');
    await expect(panel).toHaveCount(0);
    await integrations(page);
    await watch(browse, 'big buck bunny', BUNNY.title);
    await expect(page.locator('.watch-title b')).toHaveText(BUNNY.title);
    await expect(panel).toHaveCount(0);
  } finally {
    await room.close();
  }
});
