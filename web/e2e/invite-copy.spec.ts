import { expect, test } from '@playwright/test';
import { inviteLink } from './support/cinema';

/*
  R142 («ВАЖНО» владельца 31.10): при создании встречи ссылка-приглашение сразу в буфере, а встреча
  говорит об этом тем же тостом, что и главная. Тост живёт пять секунд — ждём его сразу после
  «Начать встречу», а не после выхода медиа в эфир.
*/
test('новая встреча кладёт ссылку-приглашение в буфер и говорит «Ссылка на встречу скопирована» (R142)', async ({
  browser,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'чтение буфера в тесте разрешает только Chromium');
  const context = await browser.newContext({
    permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();
  try {
    await page.goto('/');
    await page.getByRole('button', { name: /Новая встреча/ }).click();
    await page.getByLabel('Ваше имя').fill('Майс');
    await page.getByRole('button', { name: 'Начать встречу' }).click();
    await expect(page.getByText('Ссылка на встречу скопирована')).toBeVisible({ timeout: 20000 });
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    await expect(page.locator('[data-media-status="connected"]')).toBeVisible({ timeout: 20000 });
    expect(copied).toBe(await inviteLink(page));
  } finally {
    await context.close();
  }
});
