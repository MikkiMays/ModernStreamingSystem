import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Знакомство с Cord (E13, T34): свежий профиль проходит его до конца, повторный запуск его не
 * показывает, «Пройти знакомство» в «О программе» показывает снова. Подсказки стоят у настоящих
 * кнопок и не запирают страницу.
 *
 * Остальные сценарии начинают с уже знакомого профиля (`global-setup.ts`); здесь — свежий.
 */
test.use({ storageState: { cookies: [], origins: [] } });

const tip = (page: Page, title: string) => page.getByRole('dialog', { name: title });

test('a fresh profile walks the tour once, and «Пройти знакомство» brings it back', async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Новая встреча/ })).toBeVisible({ timeout: 25000 });

  const first = tip(page, 'Новая встреча');
  await expect(first).toBeVisible();
  await expect(first).toContainText('1 из 5');
  // Подсказка у настоящей кнопки: та подсвечена, а страница под подсказкой живая.
  await expect(page.locator('[data-coachmark-target]')).toHaveAttribute('data-tour', 'create');
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations,
  ).toEqual([]);

  for (const [title, step] of [
    ['Вас пригласили?', '2 из 5'],
    ['Избранное', '3 из 5'],
    ['Настройки', '4 из 5'],
    ['Помощь', '5 из 5'],
  ] as const) {
    await page.getByRole('button', { name: 'Далее' }).click();
    await expect(tip(page, title)).toContainText(step);
  }
  await page.getByRole('button', { name: 'Готово' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('[data-coachmark-target]')).toHaveCount(0);

  // Повторный запуск — знакомства нет.
  await page.reload();
  await expect(page.getByRole('button', { name: /Новая встреча/ })).toBeVisible({ timeout: 25000 });
  await page.waitForTimeout(1500);
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // «Пройти знакомство» — снова с первого шага, окно настроек закрывается само.
  await page.getByRole('button', { name: 'О программе' }).click();
  await page.getByRole('button', { name: 'Пройти знакомство' }).click();
  await expect(tip(page, 'Новая встреча')).toContainText('1 из 5');
  await page.getByRole('button', { name: 'Пропустить' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('on a phone the tour is three steps, the last one at the menu', async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/');
  await expect(tip(page, 'Новая встреча')).toContainText('1 из 3', { timeout: 45000 });
  await page.getByRole('button', { name: 'Далее' }).click();
  await page.getByRole('button', { name: 'Далее' }).click();
  await expect(tip(page, 'Меню')).toContainText('3 из 3');
  // Подсказка не шире экрана.
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  await page.getByRole('button', { name: 'Готово' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
