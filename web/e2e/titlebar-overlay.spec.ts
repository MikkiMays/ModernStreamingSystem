import { expect, test, type Page } from '@playwright/test';
import { startMeeting } from './support/cinema';

/*
  Клиент Windows (R34): «— ⧉ ×» Windows рисует поверх страницы — полоса 36 px сверху и 138 px справа
  (`titleBarOverlay`). Браузер этой зоны не знает, поэтому сценарий ставит её сам: мост v2 (как у
  оболочки — `data-desktop`) и те же переменные, что дал бы `env(titlebar-area-*)`. Шапки встречи и
  предвхода должны кончаться левее кнопок окна, а пустое место шапки — тащить окно.
*/

const WCO = { end: 138, height: 36 };

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { cordDesktop: unknown }).cordDesktop = {
      protocol: { major: 2, minor: 0 },
      features: [],
      app: { version: '1.0.4', arch: 'x64' },
      bootstrap: {
        profile: '',
        theme: 'system',
        language: null,
        showPing: false,
        notificationSounds: true,
        autoConnect: true,
      },
      send() {},
      invoke: async () => null,
      on: () => () => {},
    };
  });
});

/** Зона кнопок окна — как её дал бы Chromium оболочки. */
async function overlay(page: Page) {
  await page.evaluate(({ end, height }) => {
    document.documentElement.style.setProperty('--titlebar-end', `${end}px`);
    document.documentElement.style.setProperty('--titlebar-h', `${height}px`);
  }, WCO);
}

async function rightEdge(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox();
  return box!.x + box!.width;
}

async function headerClear(page: Page) {
  const width = page.viewportSize()!.width;
  const header = page.locator('.meeting-header');
  expect(await rightEdge(page, '.meeting-header__actions')).toBeLessThanOrEqual(width - WCO.end - 8 + 1);
  expect((await header.boundingBox())!.height).toBeGreaterThanOrEqual(WCO.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
}

test('шапки предвхода и встречи не уходят под кнопки окна и тащат окно', async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-desktop', 'true');
  // Предвход: «На главную» и «Поддержка» справа в шапке.
  await page.getByRole('button', { name: /Новая встреча/ }).click();
  await page.getByLabel('Ваше имя').waitFor();
  await overlay(page);
  expect(await rightEdge(page, '.app-header__end')).toBeLessThanOrEqual(1280 - WCO.end - 8 + 1);
  expect(
    await page
      .locator('.app-header')
      .evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region')),
  ).toBe('drag');
  await startMeeting(page, 'Окно');
  await overlay(page);
  await headerClear(page);
  const header = page.locator('.meeting-header');
  expect(await header.evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region'))).toBe(
    'drag',
  );
  // Кнопки шапки нажимаются: у них своя «нетаскающая» зона.
  for (const name of ['Пригласить участников', 'Поддержка'])
    expect(
      await header
        .getByRole('button', { name, exact: true })
        .evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region')),
    ).toBe('no-drag');
  // Узкое окно — то же самое.
  await page.setViewportSize({ width: 820, height: 700 });
  await headerClear(page);
});
