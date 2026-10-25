import { expect, test, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Кольцо фокуса и полосы прокрутки в настоящем Chromium (S1, S2; R26, R75, R11, R23, R17; Ц7, Ц9).
 *
 * Chromium считает клавиатурным вводом любую клавишу без Ctrl/Alt/Meta, и `:focus-visible` после
 * щелчка и Shift честно срабатывает — это jsdom не покажет. Здесь проверяется то, что видит человек:
 * `outline-style` у элемента. Пять мест из жалобы: окно настроек (карточка профиля и само окно), окно
 * набора (крестик), «Помощь», меню избранного, запись сочетания. Путь мышью: щелчок → Shift → кольца
 * нет. Путь клавиатурой: Tab → кольцо есть (WCAG 2.4.7).
 */

// Playwright без окна прячет полосы прокрутки (`--hide-scrollbars`) — их ширину меряем как у человека.
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

const FAVORITE = {
  roomId: '00000000-0000-4000-8000-0000000000aa',
  code: '123456789',
  title: 'Планёрка',
  alias: null,
  groupId: null,
  pinned: false,
  closed: false,
  canJoin: true,
  savedAt: 1760000000000,
};

const outline = (locator: Locator) => locator.evaluate((element) => getComputedStyle(element).outlineStyle);
/** Кольцо у того, что сейчас в фокусе, — и что это за элемент, если тест упадёт. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const element = document.activeElement as HTMLElement;
    return `${element.tagName.toLowerCase()}.${element.className} ${getComputedStyle(element).outlineStyle}`;
  });

async function home(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Новая встреча/ })).toBeVisible({ timeout: 30000 });
}

/**
 * Окно появляется 200 мс — прозрачность и масштаб (`settings.css`), а видимым Playwright считает его
 * с первого кадра. axe, запущенный посреди появления, смешивает полупрозрачный приглушённый текст с
 * подложкой и находит контраст ниже 4,5 (CI 40135293438: подписи, заголовки групп, подсказки). Ждём,
 * пока снят стиль начала и закончились все конечные переходы окна, — дальше оно такое, как у человека.
 */
async function settled(dialog: Locator) {
  await expect(dialog).not.toHaveAttribute('data-starting-style');
  await dialog.evaluate((element) =>
    Promise.all(
      element
        .getAnimations({ subtree: true })
        .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
}

async function openSettings(page: Page) {
  await page
    .getByRole('button', { name: 'Настройки', exact: true })
    .filter({ visible: true })
    .first()
    .click();
  const dialog = page.getByRole('dialog', { name: 'Настройки' });
  await expect(dialog).toBeVisible();
  await settled(dialog);
  return dialog;
}

test('настройки: открыты мышью — Shift не обводит ни карточку профиля, ни окно; Tab — обводит', async ({
  page,
}) => {
  await home(page);
  const dialog = await openSettings(page);
  await page.keyboard.press('Shift');
  await expect.poll(() => outline(page.locator('.settings-profile'))).toBe('none');

  // Щелчок по пустому месту отдаёт фокус самому окну (`tabindex=-1`): «выделяются окна».
  await dialog.getByRole('heading', { name: 'Настройки', exact: true }).click();
  await page.keyboard.press('Shift');
  expect(await outline(page.locator('.settings-window'))).toBe('none');
  expect(await focused(page)).toMatch(/ none$/);
  // Сочетание (микрофон) — тоже не навигация.
  await page.keyboard.press('Control+Shift+M');
  expect(await focused(page)).toMatch(/ none$/);

  await page.keyboard.press('Tab');
  await expect(page.locator('html')).toHaveAttribute('data-input', 'keyboard');
  expect(await focused(page)).toMatch(/ solid$/);
});

test('настройки: полоса прокрутки тонкая — не шире 10 px, без стрелок (R17, Ц9)', async ({ page }) => {
  await home(page);
  await openSettings(page);
  const content = page.locator('.settings-content');
  await expect(content).toBeVisible();
  const bar = await content.evaluate((element) => {
    const style = getComputedStyle(element);
    const borders = parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
    return element.offsetWidth - element.clientWidth - borders;
  });
  expect(bar, 'ширина полосы').toBeGreaterThan(0);
  expect(bar, 'ширина полосы').toBeLessThanOrEqual(10);
});

test('настройки: axe чист в открытом окне', async ({ page }) => {
  await home(page);
  await openSettings(page);
  const { violations } = await new AxeBuilder({ page })
    .include('.settings-window')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' ')}`)).toEqual([]);
});

test('запись сочетания: «Изменить» → Esc — кнопка без кольца; с клавиатуры — с кольцом (R23)', async ({
  page,
}) => {
  await home(page);
  const dialog = await openSettings(page);
  await dialog
    .getByRole('navigation', { name: 'Разделы настроек' })
    .getByRole('button', { name: 'Горячие клавиши', exact: true })
    .click();
  const change = dialog.getByRole('button', { name: 'Изменить сочетание микрофона' });
  await change.click();
  await expect(dialog.getByRole('button', { name: 'Esc — отмена записи сочетания' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(change).toBeFocused();
  await page.keyboard.press('Shift');
  expect(await outline(change)).toBe('none');

  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(change).toBeFocused();
  expect(await outline(change)).toBe('solid');
});

test('окно набора: крестик после щелчка и Shift без кольца, Tab — с кольцом', async ({ page }) => {
  await page.goto('/kit');
  await page.getByRole('button', { name: 'Открыть диалог' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Выйти из встречи?' });
  await expect(dialog).toBeVisible();
  const close = dialog.getByRole('button', { name: 'Закрыть' });
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift');
  expect(await outline(close)).toBe('none');
  expect(await outline(dialog)).toBe('none');
  await page.keyboard.press('Tab');
  expect(await focused(page)).toMatch(/ solid$/);
});

test('ряд вкладок с одной остановкой Tab: стрелкой — кольцо и на вкладке с tabindex=-1', async ({ page }) => {
  // Вкладки кинозала и площадок держат `tabindex=-1`, пока до них не дошли стрелкой (roving tabindex):
  // правило «контейнерам кольца нет» не должно их задевать. Ряд — тот же, что `cinema/catalog/Tabs`.
  await page.goto('/kit');
  await expect(page.getByRole('heading', { name: 'Набор примитивов' })).toBeVisible();
  await page.evaluate(() => {
    const row = document.createElement('div');
    row.setAttribute('role', 'tablist');
    for (const [name, stop] of [
      ['Первая', '0'],
      ['Вторая', '-1'],
    ]) {
      const tab = document.createElement('button');
      tab.setAttribute('role', 'tab');
      tab.tabIndex = Number(stop);
      tab.textContent = name;
      row.append(tab);
    }
    row.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowRight') (row.lastElementChild as HTMLElement).focus();
    });
    document.querySelector('.kit__bar')!.append(row);
  });
  await page.getByRole('tab', { name: 'Первая' }).click();
  await page.keyboard.press('Shift');
  expect(await outline(page.getByRole('tab', { name: 'Первая' }))).toBe('none');
  await page.keyboard.press('ArrowRight');
  const second = page.getByRole('tab', { name: 'Вторая' });
  await expect(second).toBeFocused();
  expect(await outline(second)).toBe('solid');
});

test('«Поддержка»: открыта мышью — Shift не обводит крестик и окно; Tab — обводит', async ({ page }) => {
  await home(page);
  await page
    .getByRole('button', { name: 'Поддержка', exact: true })
    .filter({ visible: true })
    .first()
    .click();
  const dialog = page.getByRole('dialog', { name: 'Поддержка' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Shift');
  expect(await focused(page)).toMatch(/ none$/);
  expect(await outline(dialog)).toBe('none');
  await page.keyboard.press('Tab');
  expect(await focused(page)).toMatch(/ solid$/);
});

test('меню избранного: пункт под курсором после Shift без кольца, стрелками — обведён внутри (R75)', async ({
  page,
}) => {
  // Подставной список: избранное стенда не трогаем.
  await page.route('**/api/v1/favorites', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: [FAVORITE] }) : route.fallback(),
  );
  await page.route('**/api/v1/favorites/groups', (route) => route.fulfill({ json: [] }));
  await home(page);
  const trigger = page
    .getByRole('navigation', { name: 'Избранное' })
    .getByRole('button', { name: `Действия с «${FAVORITE.title}»` });
  await trigger.click();
  const item = page.getByRole('menuitem', { name: /^Переименовать/ });
  await item.hover();
  await expect(item).toHaveAttribute('data-highlighted');
  await page.keyboard.press('Shift');
  expect(await outline(item)).toBe('none');
  expect(await item.evaluate((element) => getComputedStyle(element).boxShadow)).toBe('none');
  expect(await outline(page.getByRole('menu'))).toBe('none');

  await page.keyboard.press('ArrowDown');
  const next = page.locator('.ui-menu__item[data-highlighted]');
  expect(await outline(next)).toBe('none');
  expect(await next.evaluate((element) => getComputedStyle(element).boxShadow)).toMatch(/inset/);

  // Закрыли мышью — кнопка «…» получает фокус обратно без кольца, даже после Shift.
  await page.mouse.click(5, 5);
  await trigger.click();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Shift');
  expect(await outline(trigger)).toBe('none');
});
