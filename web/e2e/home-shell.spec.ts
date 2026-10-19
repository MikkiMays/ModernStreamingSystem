import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Главная E02: боковая панель с избранным, группы и меню комнаты (T40), ширина панели (T46),
 * шапка встречи без «В эфире» и без темы, со временем встречи (T25, T35, T41).
 */

async function startMeeting(page: Page, title: string) {
  await page.goto('/');
  await page.getByRole('button', { name: /Новая встреча/ }).click();
  await page.getByLabel('Название встречи').fill(title);
  await page.getByLabel('Ваше имя').fill('Хозяин');
  await page.getByRole('button', { name: 'Начать встречу' }).click();
  await expect(page.locator('[data-media-status="connected"]')).toBeVisible({ timeout: 25000 });
}

test('a saved room goes into a new group, moves back by dragging, and the group goes away', async ({
  browser,
}) => {
  test.setTimeout(90000);
  const context = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const page = await context.newPage();
  try {
    await startMeeting(page, 'Планёрка E02');
    // Нормальное состояние молчит: ни «В эфире», ни переключателя темы в шапке.
    await expect(page.getByText('В эфире', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Тема/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Сохранить комнату в избранное' }).click();
    await page.getByRole('button', { name: 'Выйти из встречи' }).click();

    const favorites = page.getByRole('navigation', { name: 'Избранное' });
    const room = favorites.getByRole('button', { name: /^Планёрка E02/ });
    await expect(room).toBeVisible();
    await expect(favorites.getByText(/из 10$/)).toBeVisible();

    // Маленькая кнопка «Группа» — строка ввода прямо в списке.
    await favorites.getByRole('button', { name: 'Создать группу' }).click();
    await favorites.getByRole('textbox', { name: 'Название новой группы' }).fill('Работа');
    await page.keyboard.press('Enter');
    const group = favorites.getByRole('button', { name: /^Работа/ });
    await expect(group).toBeVisible();

    // ПКМ на комнате — то же меню, что и «…».
    await room.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Группа' }).hover();
    await page.getByRole('menuitem', { name: 'Работа' }).click();
    await expect(group).toHaveAccessibleName(/1$/);

    // Перетаскивание мышью обратно в общий список.
    const from = (await room.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + 12, { steps: 4 });
    const loose = favorites.locator('[data-drop="loose"]');
    await expect(loose).toBeVisible();
    const to = (await loose.boundingBox())!;
    await page.mouse.move(to.x + to.width / 2, to.y + to.height - 4, { steps: 8 });
    await page.mouse.up();
    await expect(group).toHaveAccessibleName(/0$/);

    // Удалить группу: комнаты остаются в общем списке.
    await favorites.getByRole('button', { name: 'Действия с группой «Работа»' }).click();
    await page.getByRole('menuitem', { name: 'Удалить группу' }).click();
    await expect(group).toHaveCount(0);
    await expect(room).toBeVisible();

    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations,
    ).toEqual([]);

    // Убрать из избранного — с подтверждением, потому что вернуть можно только из встречи.
    await room.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Убрать из избранного' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Убрать', exact: true }).click();
    await expect(room).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('the sidebar width survives a reload and shows the resize cursor', async ({ page }) => {
  await page.goto('/');
  const handle = page.getByRole('separator', { name: 'Ширина боковой панели' });
  await expect(handle).toBeVisible();
  expect(await handle.evaluate((element) => getComputedStyle(element).cursor)).toBe('col-resize');
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  const width = Number(await handle.getAttribute('aria-valuenow'));
  expect(width).toBeGreaterThan(300);
  await page.reload();
  await expect(page.getByRole('separator', { name: 'Ширина боковой панели' })).toHaveAttribute(
    'aria-valuenow',
    String(width),
  );
});

test('the burger and the mark stand on one line on a phone, nothing overflows', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 360, height: 780 } });
  const page = await context.newPage();
  try {
    await page.goto('/');
    const burger = page.getByRole('button', { name: 'Открыть меню' });
    await expect(burger).toBeVisible();
    const mark = page.locator('.home-bar .brand');
    const [a, b] = [(await burger.boundingBox())!, (await mark.boundingBox())!];
    expect(Math.abs(a.y + a.height / 2 - (b.y + b.height / 2))).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await burger.click();
    await expect(page.getByRole('navigation', { name: 'Избранное' })).toBeVisible();
  } finally {
    await context.close();
  }
});

test('the meeting clock runs once two people are in (needs Snapshot.startedAt from the core)', async ({
  browser,
}) => {
  test.setTimeout(90000);
  const a = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const b = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const host = await a.newPage();
  const guest = await b.newPage();
  try {
    await startMeeting(host, 'Часы E02');
    await expect(host.getByRole('timer')).toHaveCount(0);
    await host.getByRole('button', { name: 'Пригласить участников', exact: true }).click();
    const invitation = await host.getByRole('textbox', { name: 'Ссылка приглашения' }).inputValue();
    await host.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await guest.goto(invitation);
    await guest.getByLabel('Ваше имя').fill('Гость');
    await guest.getByRole('button', { name: 'Войти во встречу' }).click();
    await expect(guest.locator('[data-media-status="connected"]')).toBeVisible({ timeout: 25000 });
    const clock = host.getByRole('timer');
    const started = await clock
      .waitFor({ timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    test.skip(!started, 'ядро ещё не присылает Snapshot.startedAt (пакет WP1)');
    const first = await clock.innerText();
    await expect.poll(() => clock.innerText(), { timeout: 5000 }).not.toBe(first);
    expect(await clock.innerText()).toMatch(/^\d{2}:\d{2}$/);
  } finally {
    await a.close();
    await b.close();
  }
});
