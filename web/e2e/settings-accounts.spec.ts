import { expect, test } from '@playwright/test';

/*
  Задача 13a: токен Яндекс Музыки переехал из «Профиля» во вкладку «Аккаунты» — тем же ключом
  и с тем же поведением. Проверяется то, что раньше проверить было нечем: значение переживает
  перезагрузку страницы (оно и раньше лежало в Preferences, но не под этой вкладкой), «Профиль»
  этого поля больше не показывает, а сама вкладка не ломает модалку шириной от телефона до
  широкого монитора — по одному разу на каждую вкладку настроек, а не только на «Аккаунты»:
  память об этом стенде помнит, что виноватой в горизонтальной прокрутке уже бывала совсем
  другая вкладка.
*/

const TABS = ['Звук', 'Видео', 'Профиль', 'Аккаунты', 'Подключение', 'Клавиши', 'О программе'];
const WIDTHS = [320, 390, 500, 820, 1024, 1280, 1440];
const TOKEN = 'e2e-stand-yandex-token-0123456789';

test('«Аккаунты» keeps the Yandex Music token across a reload and stays out of «Профиль»', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Настроить под себя' });
  await expect(dialog).toBeVisible();

  await page.getByRole('tab', { name: 'Аккаунты', exact: true }).click();
  const field = page.getByLabel('Токен Яндекс Музыки');
  await expect(field).toHaveAttribute('placeholder', 'Сохранить токен для автоподключения');
  await expect(field).toHaveValue('');
  await field.fill(TOKEN);
  await expect(field).toHaveValue(TOKEN);

  // «Профиль» больше не показывает этот токен — он переехал, а не задублировался.
  await page.getByRole('tab', { name: 'Профиль', exact: true }).click();
  await expect(page.getByLabel('Токен Яндекс Музыки')).toHaveCount(0);
  await expect(page.getByLabel('Имя по умолчанию')).toBeVisible();

  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await page.reload();

  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByRole('tab', { name: 'Аккаунты', exact: true }).click();
  await expect(page.getByLabel('Токен Яндекс Музыки')).toHaveValue(TOKEN);
});

test('no settings tab pushes the modal wider than the viewport, from a phone to a wide monitor', async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.goto('/');
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Настроить под себя' })).toBeVisible();

  const overflow = () =>
    page.evaluate(() => {
      const modal = document.querySelector<HTMLElement>('.modal');
      return modal ? modal.scrollWidth - modal.clientWidth : null;
    });
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    for (const name of TABS) {
      await page.getByRole('tab', { name, exact: true }).click();
      expect(await overflow(), `вкладка «${name}» на ${width}px`).toBeLessThanOrEqual(0);
    }
  }
});
