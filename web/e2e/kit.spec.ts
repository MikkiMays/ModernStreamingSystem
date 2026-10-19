import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Витрина набора примитивов (`/kit`, E16) стоит вне приложения, как `/download`: ни сервера,
 * ни сессии. Здесь проверяется то, что нельзя проверить в jsdom: axe по обеим темам, кольцо
 * фокуса ползунка только с клавиатуры (T31) и ручка-разделитель, которая помнит ширину (T46).
 */
test('витрина: axe чист в обеих темах, фокус только с клавиатуры, ширина панели помнится', async ({
  page,
}) => {
  await page.goto('/kit');
  await expect(page.getByRole('heading', { name: 'Набор примитивов' })).toBeVisible();
  // Статичная загрузка из index.html гаснет после первого кадра и удаляется из DOM.
  await expect(page.locator('#cord-boot')).toHaveCount(0);

  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(violations, theme).toEqual([]);
  }

  const slider = page.getByRole('slider', { name: 'Громкость' }).first();
  await slider.click();
  expect(await slider.evaluate((el) => el.matches(':focus-visible')), 'после клика кольца нет').toBe(false);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  expect(await slider.evaluate((el) => el.matches(':focus-visible')), 'с клавиатуры кольцо есть').toBe(true);

  const handle = page.getByRole('separator', { name: 'Ширина левой панели' }).first();
  await expect(handle).toHaveCSS('cursor', 'col-resize');
  await handle.focus();
  await page.keyboard.press('ArrowRight');
  await expect(handle).toHaveAttribute('aria-valuenow', '296');
  await page.reload();
  await expect(page.getByRole('separator', { name: 'Ширина левой панели' }).first()).toHaveAttribute(
    'aria-valuenow',
    '296',
  );
});
