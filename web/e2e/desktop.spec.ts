import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Exercise the shared React UI in desktop mode. Native SplitView is verified separately.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const listeners = new Set<(event: MessageEvent) => void>();
    window.addEventListener('test:host', (event) => {
      for (const listener of listeners)
        listener(new MessageEvent('message', { data: (event as CustomEvent).detail }));
    });
    window.chrome = {
      ...window.chrome,
      webview: {
        postMessage: () => undefined,
        addEventListener: (_, listener) => void listeners.add(listener),
        removeEventListener: (_, listener) => void listeners.delete(listener),
      },
    };
  });
  await page.route('**/api/v1/favorites', (route) =>
    route.fulfill({
      json: Array.from({ length: 5 }, (_, i) => ({
        roomId: `00000000-0000-4000-8000-00000000000${i}`,
        title: [
          'Вечерний созвон',
          'Рабочая комната',
          'Дизайн и разработка',
          'Друзья',
          'Длинное название любимой комнаты',
        ][i],
        code: `33344455${i}`,
        savedAt: Date.now(),
        closed: i === 4,
        canJoin: i !== 4,
      })),
    }),
  );
});

test('desktop home keeps entry centered and reachable while favorites stay in the native shell', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('.desktop-home')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Избранные комнаты' })).toHaveCount(0);
  for (const size of [
    { width: 1120, height: 740 },
    { width: 760, height: 620 },
    { width: 420, height: 560 },
    { width: 360, height: 430 },
    { width: 480, height: 320 },
  ]) {
    await page.setViewportSize(size);
    const bounds = await page.locator('.desktop-connect').boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    if (size.height >= 430) expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(size.height + 1);
    expect(Math.abs(bounds!.x + bounds!.width / 2 - size.width / 2)).toBeLessThan(2);
    const overflow = await page.evaluate(() => ({
      vertical: document.documentElement.scrollHeight > innerHeight,
      horizontal: document.documentElement.scrollWidth > innerWidth,
    }));
    expect(overflow.horizontal).toBe(false);
    if (size.height >= 430) expect(overflow.vertical).toBe(false);
    await page.getByRole('button', { name: 'Новая встреча', exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('button', { name: 'Новая встреча', exact: true })).toBeInViewport({
      ratio: 1,
    });
    await page.getByRole('button', { name: 'Присоединиться', exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('button', { name: 'Присоединиться', exact: true })).toBeInViewport({
      ratio: 1,
    });
  }
  await expect(page.getByRole('button', { name: 'Открыть избранное' })).toHaveCount(0);
  await page.setViewportSize({ width: 1120, height: 740 });
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze())
        .violations,
    ).toEqual([]);
    await page.screenshot({ path: `../.local/desktop-home-${theme}.png` });
  }
});

test('desktop code entry and create actions open the shared prejoin with devices off', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Код встречи или ссылка').fill('333444555');
  await expect(page.getByLabel('Код встречи или ссылка')).toHaveValue('333-444-555');
  await page.getByRole('button', { name: 'Присоединиться', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Войти во встречу' })).toBeVisible();
  await expect(page.getByLabel('Название встречи')).toHaveCount(0);
  await page.goto('/');
  await page.getByRole('button', { name: 'Новая встреча', exact: true }).click();
  await expect(page.getByLabel('Название встречи')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Настройки предпросмотра' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Включить камеру', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Включить микрофон', exact: true })).toBeVisible();
});

test('native favorite settings open unavailable rooms without joining and synchronize PING', async ({
  page,
}) => {
  const joins: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/join')) joins.push(request.url());
  });
  await page.goto('/');
  await expect(page.locator('.desktop-home')).toBeVisible();
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent('test:host', {
        detail: { version: 1, type: 'favorite.settings', roomId: '00000000-0000-4000-8000-000000000004' },
      }),
    ),
  );
  await expect(page.getByRole('dialog')).toHaveText(/Длинное название любимой комнаты/);
  await page.getByRole('switch', { name: 'Автоподключение' }).check();
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await expect(page.locator('.desktop-home')).toBeVisible();
  expect(joins).toEqual([]);
  await expect(page.locator('.ping-badge')).toHaveCount(0);
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent('test:host', {
        detail: { version: 1, type: 'preferences.changed', showPing: true, notificationSounds: false },
      }),
    ),
  );
  await expect(page.locator('.ping-badge')).toHaveText(/PING · \d+ мс/);
  await expect(page.locator('.ping-badge')).toHaveAttribute('title', /Время ответа сервера/);
  await page.route('**/api/v1/ping', (route) => route.abort());
  await expect(page.locator('.ping-badge')).toHaveText('PING · Нет связи', { timeout: 6000 });
});

/**
 * Профиль в боковой панели приложения открывает настройки — и во время разговора тоже.
 *
 * Раньше нажатие во встрече не делало ничего видимого: страница запоминала раздел, но
 * показать его умела только главная. Поэтому настройки открывались позже — после выхода
 * из встречи, вместо главной, как будто приложение вернулось не туда.
 */
test('the profile block opens settings during a meeting, and leaving goes home', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Новая встреча', exact: true }).click();
  await page.getByLabel('Название встречи').fill('Проверка настроек');
  await page.getByLabel('Ваше имя').fill('Организатор');
  await page.getByRole('button', { name: 'Начать встречу', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Выйти из встречи' })).toBeVisible();

  const open = () =>
    page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent('test:host', { detail: { version: 1, type: 'settings.open', tab: 'profile' } }),
      ),
    );
  await open();
  const settings = page.getByRole('dialog').filter({ hasText: 'Настроить под себя' });
  await expect(settings).toBeVisible();
  await expect(settings.getByLabel('Имя по умолчанию')).toBeVisible();
  await expect(settings.getByLabel('Тема')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);

  // Уйти на главную из встречи с открытыми настройками: главная и есть главная. Раздел,
  // запрошенный во встрече, там уже ничего не открывает.
  await open();
  await expect(settings).toBeVisible();
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent('test:host', { detail: { version: 1, type: 'navigate', page: 'home' } }),
    ),
  );
  await expect(page.locator('.desktop-home')).toBeVisible();
  await expect(page.getByRole('dialog').filter({ hasText: 'Настроить под себя' })).toHaveCount(0);
});
