import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import {
  fixture,
  inviteLink,
  joinMeeting,
  openCinema,
  providersAnswer,
  routeCinema,
  startMeeting,
} from './support/cinema';

/*
  Панель встречи и кинозал там, где панель лежит поверх сцены: листом на телефоне (390, 760 px)
  и полосой на планшете (900 px).

  Когда человек сам открыл каталог или сам включил фильм, панель уступает сцену — любая, и чат
  тоже: под листом кино не найти («Совместный просмотр недоступен», 19.09). Недописанное
  сообщение при этом не пропадает — его хранит встреча, а не панель. А от того, что сделал
  кто-то другой, не закрывается ничего. Правило по частям проверяет
  `ui/cinema/useYieldToCinema.test.ts`; здесь — что это правда в собранной встрече.
*/

interface Feed {
  items: { title: string }[];
}
const RICK = fixture<Feed>('youtube-search-never-gonna-give-you-up').items[0]!;
const BUNNY = fixture<Feed>('youtube-search-big-buck-bunny').items[0]!;
const DRAFT = 'Через минуту начнём, я за чаем';

const context = (browser: Browser, width: number) =>
  browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: { width, height: width < 700 ? 844 : 900 },
  });

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

/** Чат — кнопкой на пульте, а на телефоне, где её нет, — из меню «Настройки и действия». */
async function openChat(page: Page) {
  const chat = page.getByRole('button', { name: 'Чат', exact: true });
  if (await chat.isVisible()) await chat.click();
  else {
    await page.getByRole('button', { name: 'Настройки и действия' }).click();
    await page.getByRole('menuitem', { name: /Чат и файлы/ }).click();
  }
  const box = page.getByRole('textbox', { name: 'Сообщение' });
  await expect(box).toBeVisible();
  return box;
}

for (const width of [390, 760, 900]) {
  test(`at ${width}px a film someone else starts closes nothing, and my own catalogue takes the stage from the chat without losing the draft`, async ({
    browser,
  }) => {
    // Два браузера и два входа во встречу: обычного срока тут мало.
    test.slow();
    const first = await context(browser, width);
    const second = await context(browser, 1280);
    const host = await first.newPage();
    const guest = await second.newPage();
    await routeCinema(host);
    await routeCinema(guest);
    try {
      await startMeeting(host, 'Майс');
      await joinMeeting(guest, await inviteLink(host), 'Алекс');

      const draft = await openChat(host);
      await draft.fill(DRAFT);

      // Фильм включил не я — чат открыт, сообщение не пропало.
      await watch(await openCinema(guest, 'YouTube'), 'never gonna give you up', RICK.title);
      await expect(host.locator('.watch-title b')).toHaveText(RICK.title);
      await expect(draft).toBeVisible();
      await expect(draft).toHaveValue(DRAFT);

      // «Каталог» на пульте плеера — при открытом чате. На телефоне пульт виден над листом, и его
      // нажимают пальцем; на 760 и 900 px он под листом и полосой — туда доходят с клавиатуры.
      const browse = host.getByRole('button', { name: 'Каталог', exact: true });
      if (width < 700) await browse.click();
      else {
        await browse.focus();
        await host.keyboard.press('Enter');
      }
      // Каталог открыт по-настоящему — его сцена, а не заглушка на время загрузки, — и не накрыт
      // ничем: панели на экране нет, и ни одна точка каталога не под ней.
      const catalog = host.locator('.cinema-browser');
      await expect(catalog.locator('.cinema-empty')).toBeVisible();
      await expect(host.locator('.side-panel')).toHaveCount(0);
      const geometry = await host.evaluate(() => {
        const a = document.querySelector('.cinema-browser')!.getBoundingClientRect();
        const b = document.querySelector('.side-panel')?.getBoundingClientRect();
        const shared = b
          ? Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
            Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
          : 0;
        return { height: a.height, shared };
      });
      expect(geometry.shared).toBe(0);
      expect(geometry.height).toBeGreaterThan(200);

      // Чат открыли снова — недописанное на месте.
      await host.getByRole('button', { name: 'Вернуться к просмотру' }).click();
      await expect(await openChat(host)).toHaveValue(DRAFT);
    } finally {
      await first.close();
      await second.close();
    }
  });
}

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

/*
  Установка, где часть площадок выключена (`CINEMA_PROVIDERS`), и площадка, которая отсюда не работает.

  Выключенная стояла обычной плиткой и вкладкой, и каждая её кнопка отвечала «Эта площадка выключена
  на этом сервере»; причина недоступной жила только во всплывающей подсказке, которую палец не
  показывает. Поэтому ширина — телефонная.
*/
test('a platform switched off on the server has no tile and no tab, and an unavailable one says why on its tile', async ({
  browser,
}) => {
  const room = await context(browser, 390);
  const page = await room.newPage();
  const reason = 'ivi отдаёт бесплатное только в России';
  await routeCinema(page, { providers: () => providersAnswer(['twitch'], { ivi: reason }) });
  try {
    await startMeeting(page);
    await page.getByRole('button', { name: 'Настройки и действия' }).click();
    await page.getByRole('menuitem', { name: 'Интеграции' }).click();
    await page
      .locator('.service-group')
      .filter({ has: page.getByText('Кинозал', { exact: true }) })
      .click();
    const tiles = page.locator('.cinema-group .service-tile');
    await expect(tiles.locator('b')).toHaveText(['YouTube', 'Rutube', 'VK Видео', 'ivi', 'По ссылке']);
    const ivi = tiles.filter({ has: page.getByText('ivi', { exact: true }) });
    await expect(ivi).toBeDisabled();
    await expect(ivi.locator('small')).toHaveText(reason);
    await expect(ivi.locator('small')).toBeVisible();
    await expect(ivi).not.toHaveAttribute('title');

    // В каталоге YouTube вкладки Twitch нет: там её кнопка тоже отвечала бы только отказом.
    const browse = await openCinema(page, 'YouTube');
    await expect(browse.getByRole('tablist', { name: 'Площадка' }).getByRole('tab')).toHaveText(['YouTube']);
  } finally {
    await room.close();
  }
});
