import { expect, test } from '@playwright/test';

/**
 * Камера не уступает демонстрации — не в решении модуля, а в настоящем браузере.
 *
 * Модульные тесты `upstream.test.ts` проверяют, что решение принимается правильно: по П2 камера
 * рядом с показом **не** ужимается до 640×360, если сервер не велел иначе. Здесь проверяется,
 * что оно доезжает: размер собственного захвата виден прямо в `<video>` своей плитки, и он
 * обязан остаться выбранным (по умолчанию 720p с сервера) всё время показа. Раньше ровно здесь
 * ожидалось падение до 360 — это и было «600×300» из T44.
 */
test('камера держит выбранный кадр на время показа и после него', async ({ browser }) => {
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
    await expect(page.locator('[data-media-status="connected"]')).toBeVisible({ timeout: 20000 });

    await page.getByRole('button', { name: 'Включить камеру', exact: true }).click();
    const camera = page.locator('video[aria-label="Камера: Майс"]').first();
    await expect(camera).toBeVisible({ timeout: 15000 });
    const height = () => camera.evaluate((video: HTMLVideoElement) => video.videoHeight);
    // Умолчание с сервера — 720p. Дожидаемся первого кадра, а не нуля.
    await expect.poll(height, { timeout: 15000 }).toBeGreaterThan(400);

    await page.getByRole('button', { name: 'Показать экран', exact: true }).click();
    await expect(page.getByText('Вы показываете экран')).toBeVisible({ timeout: 20000 });
    // Десять секунд показа — ни одного кадра мельче выбранного.
    for (let i = 0; i < 10; i++) {
      expect(await height()).toBeGreaterThan(400);
      await page.waitForTimeout(1000);
    }

    await page.getByRole('button', { name: 'Остановить показ', exact: true }).click();
    await expect.poll(height, { timeout: 20000 }).toBeGreaterThan(400);
  } finally {
    await context.close();
  }
});
