import { expect, test, type Page } from '@playwright/test';

/*
  Настройки (E03).

  T33: «Аккаунты» — строка на сервис и кнопка «Подключить» / «Подключено» / «Сбросить». Токен
  Яндекс Музыки сохраняется тем же ключом, что и раньше, и переживает перезагрузку.

  T26: окно не «ездит» — у каждого раздела тот же размер окна на каждой ширине (замер
  `getBoundingClientRect`), и ни один раздел не даёт горизонтальной прокрутки ни окну, ни странице.

  Ревью 1.0.3: окно по центру (R19, ±2 px, ru и it, на главной и во встрече), крестик в строке
  заголовка раздела и вне прокрутки (R15, центры по вертикали ±2 px), каждый раздел помещается
  без прокрутки в окне 1280×800 и 1440×900 (R101).
*/

const SECTIONS = [
  'Профиль',
  'Оформление',
  'Горячие клавиши',
  'Микрофон',
  'Видео',
  'Звуки',
  'Аккаунты',
  'Сервер',
  'О программе',
];
const WIDTHS = [360, 768, 1024, 1440, 2560];
const TOKEN = 'e2e-stand-yandex-token-0123456789';

async function openSettings(page: Page, name = 'Настройки') {
  await page.getByRole('button', { name, exact: true }).filter({ visible: true }).first().click();
  const dialog = page.getByRole('dialog', { name });
  await expect(dialog).toBeVisible();
  // Появление — 200 мс масштаба: мерить после него.
  await expect(page.locator('.settings-window[data-starting-style]')).toHaveCount(0);
  await page.waitForTimeout(300);
  return dialog;
}

/** Поля окна до краёв страницы и расстояние между центрами заголовка раздела и крестика. */
const geometry = (page: Page) =>
  page.evaluate(() => {
    const box = document.querySelector('.settings-window')!.getBoundingClientRect();
    const title = document.querySelector('.settings-content__title')!.getBoundingClientRect();
    const close = document.querySelector('.settings-close')!.getBoundingClientRect();
    const page = document.documentElement;
    return {
      horizontal: Math.abs(box.left - (page.clientWidth - box.right)),
      vertical: Math.abs(box.top - (page.clientHeight - box.bottom)),
      closeToTitle: Math.abs((title.top + title.bottom) / 2 - (close.top + close.bottom) / 2),
      closeScrolls: !!document.querySelector('.settings-content .settings-close'),
    };
  });

async function expectCentered(page: Page, where: string) {
  const size = await geometry(page);
  expect(size.horizontal, `${where}: окно по центру по горизонтали`).toBeLessThanOrEqual(2);
  expect(size.vertical, `${where}: окно по центру по вертикали`).toBeLessThanOrEqual(2);
  expect(size.closeToTitle, `${where}: крестик в строке заголовка`).toBeLessThanOrEqual(2);
  expect(size.closeScrolls, `${where}: крестик вне прокрутки`).toBe(false);
}

const nav = (page: Page) => page.getByRole('navigation', { name: 'Разделы настроек' });
/** Кнопка раздела: у раздела «Микрофон» (R114) подраздел с тем же именем — он ниже кнопки раздела. */
const section = (page: Page, name: string) => nav(page).getByRole('button', { name, exact: true }).first();

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
      await section(page, name).click();
      await expect(page.locator('.settings-content__title')).toHaveText(name);
      const size = await measure();
      expect(size.overflow, `«${name}» на ${width}px`).toBeLessThanOrEqual(0);
      sizes.add(`${size.width}×${size.height}`);
    }
    expect([...sizes], `размер окна на ${width}px`).toHaveLength(1);
  }
});

test('окно по центру, крестик в строке заголовка — на главной и во встрече (R15, R19)', async ({ page }) => {
  test.setTimeout(120000);
  for (const size of [
    { width: 1280, height: 800 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(size);
    await page.goto('/');
    await openSettings(page);
    await expectCentered(page, `главная ${size.width}×${size.height}`);
    await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: /Новая встреча/ }).click();
  await page.getByLabel('Ваше имя').fill('Проверка окна');
  await page.getByRole('button', { name: 'Начать встречу' }).click();
  await page.getByRole('button', { name: 'Настройки и действия' }).click();
  await page.getByRole('menuitem', { name: 'Настройки', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Настройки' })).toBeVisible();
  await page.waitForTimeout(300);
  await expectCentered(page, 'встреча 1440×900');
});

test.describe('по-итальянски (r103-08)', () => {
  test.use({ locale: 'it-IT' });
  test('окно по центру и в итальянском интерфейсе (R19)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 935 });
    await page.goto('/');
    await openSettings(page, 'Impostazioni');
    await expectCentered(page, 'главная, it');
  });
});

test('каждый раздел помещается в окно без прокрутки (R101)', async ({ page }) => {
  test.setTimeout(120000);
  await page.goto('/');
  for (const size of [
    { width: 1280, height: 800 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(size);
    await openSettings(page);
    for (const name of SECTIONS) {
      await section(page, name).click();
      await expect(page.locator('.settings-content__title')).toHaveText(name);
      // Превью камеры и шрифт догружаются — раскладка устоялась.
      await page.waitForTimeout(150);
      const extra = await page
        .locator('.settings-content')
        .evaluate((element) => element.scrollHeight - element.clientHeight);
      expect(extra, `«${name}» на ${size.width}×${size.height}`).toBeLessThanOrEqual(0);
    }
    await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  }
});

test('подсветка подраздела: на дне прокрутки — последний, щелчок по якорю — он (R12, Ц9)', async ({
  page,
}) => {
  // Низкое окно: «Видео» в нём прокручивается — правило «помещается» для эталона и выше (R101).
  await page.setViewportSize({ width: 1280, height: 560 });
  await page.goto('/');
  await openSettings(page);
  await nav(page).getByRole('button', { name: 'Видео', exact: true }).click();
  const anchors = nav(page).getByRole('list', { name: 'Подразделы: Видео' });
  const content = page.locator('.settings-content');
  expect(await content.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(0);
  await content.hover();
  await page.mouse.wheel(0, 2000);
  await expect
    .poll(() =>
      content.evaluate((element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 2),
    )
    .toBe(true);
  await expect(anchors.getByRole('button', { name: 'Демонстрация экрана' })).toHaveAttribute(
    'aria-current',
    'location',
  );
  await anchors.getByRole('button', { name: 'Камера' }).click();
  await page.waitForTimeout(800);
  await expect(anchors.getByRole('button', { name: 'Камера' })).toHaveAttribute('aria-current', 'location');
});

test('подсветка подраздела без прокрутки — выбранный щелчком, колесо её не меняет (R115)', async ({
  page,
}) => {
  // Эталонное окно: «Микрофон» помещается целиком (R101), прокручивать нечего.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await openSettings(page);
  await section(page, 'Микрофон').click();
  const anchors = nav(page).getByRole('list', { name: 'Подразделы: Микрофон' });
  const content = page.locator('.settings-content');
  expect(
    await content.evaluate((element) => element.scrollHeight - element.clientHeight),
  ).toBeLessThanOrEqual(2);
  for (const name of ['Динамики', 'Микрофон']) {
    await anchors.getByRole('button', { name }).click();
    await content.hover();
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(800);
    await expect(anchors.getByRole('button', { name })).toHaveAttribute('aria-current', 'location');
  }
});
