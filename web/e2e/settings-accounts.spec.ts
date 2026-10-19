import { expect, test, type Page } from '@playwright/test';

/*
  Настройки (E03).

  T33: «Аккаунты» — строка на сервис и кнопка «Подключить» / «Подключено» / «Сбросить». Токен
  Яндекс Музыки сохраняется тем же ключом, что и раньше, и переживает перезагрузку.

  T26: окно не «ездит» — у каждого раздела тот же размер окна на каждой ширине (замер
  `getBoundingClientRect`), и ни один раздел не даёт горизонтальной прокрутки ни окну, ни странице.
*/

const SECTIONS = [
  'Профиль',
  'Оформление',
  'Горячие клавиши',
  'Голос и видео',
  'Звуки',
  'Аккаунты',
  'Сервер',
  'О программе',
];
const WIDTHS = [360, 768, 1024, 1440, 2560];
const TOKEN = 'e2e-stand-yandex-token-0123456789';

async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Настройки' });
  await expect(dialog).toBeVisible();
  return dialog;
}

const nav = (page: Page) => page.getByRole('navigation', { name: 'Разделы настроек' });

test('«Аккаунты»: подключить Яндекс Музыку токеном, пережить перезагрузку и сбросить', async ({ page }) => {
  await page.goto('/');
  await openSettings(page);
  await nav(page).getByRole('button', { name: 'Аккаунты', exact: true }).click();
  await expect(page.locator('[data-service="telegram"]')).toContainText('Скоро');

  await page.getByRole('button', { name: 'Подключить: Яндекс Музыка' }).click();
  const field = page.getByLabel('Токен Яндекс Музыки');
  await expect(field).toHaveAttribute('type', 'password');
  await field.fill(TOKEN);
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Сбросить: Яндекс Музыка' })).toBeVisible();

  // В «Профиле» токена нет — он переехал, а не задублировался.
  await nav(page).getByRole('button', { name: 'Профиль', exact: true }).click();
  await expect(page.getByLabel('Токен Яндекс Музыки')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Имя' })).toBeVisible();

  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await page.reload();
  await openSettings(page);
  await nav(page).getByRole('button', { name: 'Аккаунты', exact: true }).click();
  await page.getByRole('button', { name: 'Сбросить: Яндекс Музыка' }).click();
  await expect(page.getByRole('button', { name: 'Подключить: Яндекс Музыка' })).toBeVisible();
});

test('окно настроек одного размера во всех разделах и без горизонтальной прокрутки, 360–2560', async ({
  page,
}) => {
  test.setTimeout(180000);
  await page.goto('/');
  const dialog = await openSettings(page);
  const measure = () =>
    page.evaluate(() => {
      const window = document.querySelector<HTMLElement>('.settings-window')!;
      const box = window.getBoundingClientRect();
      const content = document.querySelector<HTMLElement>('.settings-content');
      return {
        width: Math.round(box.width),
        height: Math.round(box.height),
        overflow: Math.max(
          window.scrollWidth - window.clientWidth,
          content ? content.scrollWidth - content.clientWidth : 0,
          document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      };
    });
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: width >= 2560 ? 1440 : width < 768 ? 800 : 900 });
    const phone = width < 768;
    const sizes = new Set<string>();
    for (const name of SECTIONS) {
      // На телефоне раздел открывается своим экраном, а «назад» возвращает к списку.
      if (phone && (await dialog.getByRole('button', { name: 'К разделам' }).isVisible()))
        await dialog.getByRole('button', { name: 'К разделам' }).click();
      await nav(page).getByRole('button', { name, exact: true }).click();
      await expect(page.locator('.settings-content__title')).toHaveText(name);
      const size = await measure();
      expect(size.overflow, `«${name}» на ${width}px`).toBeLessThanOrEqual(0);
      sizes.add(`${size.width}×${size.height}`);
    }
    expect([...sizes], `размер окна на ${width}px`).toHaveLength(1);
  }
});
