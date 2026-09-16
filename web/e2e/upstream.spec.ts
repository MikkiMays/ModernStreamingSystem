import { expect, test } from '@playwright/test';

/**
 * Камера должна уступить демонстрации — не в решении модуля, а в настоящем браузере.
 *
 * Модульные тесты `upstream.test.ts` проверяют, что решение принимается правильно. Здесь
 * проверяется, что оно доезжает: дорожка камеры действительно пересобирается под меньший
 * кадр и действительно возвращается обратно. Проверять это по исходящей статистике нельзя
 * дёшево, а вот размер самого захвата виден прямо в `<video>` собственной плитки — и
 * меняется он ровно тогда, когда `restartTrack` применил новые ограничения.
 */
test('камера уходит в маленький кадр на время показа и возвращается после него', async ({ browser }) => {
  const context = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: { width: 1440, height: 960 },
  });
  const page = await context.newPage();
  try {
    await page.goto('/');
    await page.getByRole('button', { name: /Новая встреча/ }).click();
    await page.getByLabel('Ваше имя').fill('Майс');
    await page.getByRole('button', { name: 'Начать встречу' }).click();
    await expect(page.getByText('В эфире', { exact: true })).toBeVisible({ timeout: 20000 });

    await page.getByRole('button', { name: 'Включить камеру', exact: true }).click();
    const camera = page.locator('video[aria-label="Камера: Майс"]').first();
    await expect(camera).toBeVisible({ timeout: 15000 });
    const height = () => camera.evaluate((video: HTMLVideoElement) => video.videoHeight);
    // По умолчанию камера — 720p. Дожидаемся первого кадра, а не нуля.
    await expect.poll(height, { timeout: 15000 }).toBeGreaterThan(400);

    await page.getByRole('button', { name: 'Показать экран', exact: true }).click();
    await expect.poll(height, { timeout: 20000 }).toBeLessThanOrEqual(360);

    await page.getByRole('button', { name: 'Остановить', exact: true }).click();
    await expect.poll(height, { timeout: 20000 }).toBeGreaterThan(400);
  } finally {
    await context.close();
  }
});
