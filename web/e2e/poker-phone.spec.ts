import { expect, test } from '@playwright/test';

/**
 * Стол на телефоне.
 *
 * Проверяется одно: панели, которые выезжают поверх сукна (комбинации, итоги игры), на трёхстах
 * девяноста пикселях остаются внутри экрана. Именно здесь это и ломается — на большом экране
 * панель шириной 340 пикселей помещается всегда, а на телефоне её ширину задаёт другой набор
 * правил.
 */

test('стол на телефоне: панели не выезжают за экран', async ({ browser }) => {
  test.setTimeout(150000);
  const phone = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await phone.newPage();
  try {
    await page.goto('/');
    await page.getByRole('button', { name: /Новая встреча/ }).click();
    await page.getByLabel('Ваше имя').fill('Майс');
    await page.getByRole('button', { name: 'Начать встречу' }).click();
    await expect(page.getByText('В эфире', { exact: true })).toBeVisible({ timeout: 25000 });
    await page.getByRole('button', { name: 'Настройки и действия' }).click();
    await page.getByRole('menuitem', { name: /Интеграции/ }).click();
    await page.getByRole('button', { name: /Игры/ }).click();
    await page.getByRole('button', { name: /Покер/ }).click();
    await page.getByRole('button', { name: /Открыть стол/ }).click();
    // На телефоне панель интеграций занимает экран целиком: пока она открыта, стола не видно.
    await page.getByRole('button', { name: 'Закрыть панель' }).click();
    await expect(page.locator('.poker-felt')).toBeVisible();
    await page
      .locator('.poker-bar')
      .getByRole('button', { name: /Настройки игры/ })
      .click();
    await expect(page.locator('.poker-sheet')).toBeVisible();
    // Переключатель стоит справа: подпись слева, ползунок у правого края строки.
    const hints = page.getByRole('switch', { name: /Подсказки/ });
    const placed = await hints.evaluate((node) => {
      const row = node.getBoundingClientRect();
      const knob = node.querySelector('i')!.getBoundingClientRect();
      return { right: row.right - knob.right, left: knob.left - row.left };
    });
    expect(placed.left).toBeGreaterThan(placed.right);
    await page.getByRole('button', { name: /Комбинации/ }).click();
    await expect(page.locator('.poker-sheet .hand-ranks')).toBeVisible();
    const overflow = await page.evaluate(() => ({
      body: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      sheet: (() => {
        const sheet = document.querySelector('.poker-sheet')!.getBoundingClientRect();
        return { left: sheet.left, right: window.innerWidth - sheet.right };
      })(),
    }));
    expect(overflow.body).toBeLessThanOrEqual(0);
    expect(overflow.sheet.left).toBeGreaterThanOrEqual(0);
    expect(overflow.sheet.right).toBeGreaterThanOrEqual(0);
    await page.screenshot({ path: '../.local/poker-phone.png' });
    // Полный экран: стол забирает себе всё окно, как плеер в кинозале.
    await page.locator('.poker-sheet').getByRole('button', { name: 'Закрыть' }).click();
    await page.getByRole('button', { name: 'Развернуть стол' }).click();
    await expect(page.locator('.poker[data-full="true"]')).toBeVisible();
    const scene = await page.locator('.poker').boundingBox();
    expect(scene?.height ?? 0).toBeGreaterThan(700);
    await page.screenshot({ path: '../.local/poker-phone-full.png' });
  } finally {
    await phone.close();
  }
});
