import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('home and prejoin are responsive and keyboard accessible', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'На одной волне.' })).toBeVisible();
  await page.screenshot({ path: '../.local/home-desktop.png', fullPage: true });
  const accessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await page.getByRole('button', { name: /Новая встреча/ }).click();
  await expect(page.getByLabel('Ваше имя')).toBeFocused();
  await page.screenshot({ path: '../.local/prejoin-desktop.png', fullPage: true });
  for (const width of [320, 390, 768, 1200]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.screenshot({ path: '../.local/prejoin-responsive.png', fullPage: true });
});

test('two real browser contexts exchange camera, audio and messages through LiveKit', async ({ browser }) => {
  const a = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: { width: 1440, height: 960 },
  });
  const b = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: { width: 1280, height: 900 },
  });
  const host = await a.newPage();
  const guest = await b.newPage();
  try {
    await host.goto('/');
    await host.getByRole('button', { name: /Новая встреча/ }).click();
    await host.getByLabel('Ваше имя').fill('Майс');
    await host.getByRole('button', { name: 'Начать встречу' }).click();
    await expect(host.getByText('В эфире', { exact: true })).toBeVisible({ timeout: 20000 });
    await host.getByRole('button', { name: 'Пригласить участников', exact: true }).click();
    const invitation = await host.getByRole('textbox', { name: 'Ссылка приглашения' }).inputValue();
    await host.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await guest.goto(invitation);
    await guest.getByLabel('Ваше имя').fill('Алекс');
    await guest.getByRole('button', { name: 'Войти во встречу' }).click();
    await expect(guest.getByText('В эфире', { exact: true })).toBeVisible({ timeout: 20000 });
    await host.getByRole('button', { name: 'Включить камеру', exact: true }).click();
    await host.getByRole('button', { name: 'Включить микрофон', exact: true }).click();
    await expect(guest.locator('video[aria-label="Камера: Майс"]')).toBeVisible();
    await expect
      .poll(() =>
        guest.locator('video[aria-label="Камера: Майс"]').evaluate((v: HTMLVideoElement) => v.videoWidth),
      )
      .toBeGreaterThan(0);
    await expect.poll(() => guest.locator('audio').count()).toBeGreaterThan(0);
    await host.getByRole('button', { name: 'Чат', exact: true }).click();
    await guest.getByRole('button', { name: 'Чат', exact: true }).click();
    await host.getByRole('textbox', { name: 'Сообщение', exact: true }).fill('Привет! Связь работает.');
    await host.getByRole('button', { name: 'Отправить сообщение' }).click();
    await expect(guest.getByText('Привет! Связь работает.', { exact: true })).toBeVisible();
    await host.locator('input[type=file]').setInputFiles({
      name: 'meeting-notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('A document shared during the call.'),
    });
    await expect(host.getByRole('button', { name: 'Скачать meeting-notes.txt' })).toBeVisible({
      timeout: 15000,
    });
    await expect(guest.getByRole('button', { name: 'Скачать meeting-notes.txt' })).toBeVisible({
      timeout: 10000,
    });
    await host.screenshot({ path: '../.local/room-desktop.png' });
    await guest.setViewportSize({ width: 390, height: 844 });
    await guest.screenshot({ path: '../.local/room-mobile.png' });
    expect(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await host.getByRole('button', { name: 'Настройки и действия' }).click();
    await host.getByRole('menuitem', { name: 'Завершить для всех' }).click();
    await expect(host.getByRole('heading', { name: 'Встреча завершена' })).toBeVisible();
    await expect(guest.getByRole('heading', { name: 'Встреча завершена' })).toBeVisible();
  } finally {
    await a.close();
    await b.close();
  }
});
