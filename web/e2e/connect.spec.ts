import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * The connect screen is the first thing Cord shows, and on a server with a password it is the
 * only thing until the handshake succeeds. Automatic connection is turned off here so the
 * screen stays put long enough to be exercised; with it on, an open server goes straight
 * through, which is what a normal visit looks like.
 */
test('the server is chosen before any meeting is shown', async ({ browser }) => {
  const context = await browser.newContext();
  // Seed once, not on every navigation: the list is shared by every tab of this origin, and
  // rewriting it on each page load would undo what the test is about to do to it.
  await context.addInitScript(() => {
    if (!localStorage.getItem('cord:servers:v1'))
      localStorage.setItem(
        'cord:servers:v1',
        JSON.stringify([
          { url: location.origin + '/', name: 'Мой сервер', password: '', autoConnect: false },
        ]),
      );
  });
  const page = await context.newPage();
  try {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Выберите сервер' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Новая встреча/ })).toHaveCount(0);
    // The dot says whether the address answers, which for the server serving this page it does.
    await expect(page.getByRole('img', { name: 'Сервер отвечает' })).toBeVisible();
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations,
    ).toEqual([]);

    // A server can be written down before it answers: the dialog keeps the reason and offers
    // to save the address anyway.
    await page.getByRole('button', { name: 'Добавить сервер' }).click();
    await page.getByLabel('Название сервера').fill('Запасной');
    await page.getByLabel('Адрес сервера').fill('https://spare.example.com');
    await page.getByRole('button', { name: 'Подключиться', exact: true }).click();
    await expect(page.getByText('Не подключено')).toBeVisible();
    await page.getByRole('button', { name: 'Всё равно сохранить' }).click();
    await expect(page.getByRole('button', { name: 'Настроить «Запасной»' })).toBeVisible();
    await expect(page.getByRole('img', { name: 'Адрес не отвечает' })).toBeVisible();

    await page.getByRole('button', { name: 'Подключиться', exact: true }).click();
    await expect(page.getByRole('button', { name: /Новая встреча/ })).toBeVisible();

    // The connection belongs to the visit: a new tab shakes hands again by itself.
    const second = await context.newPage();
    await second.goto('/');
    await expect(second.getByRole('heading', { name: 'Выберите сервер' })).toBeVisible();
    await second.close();

    // Switching servers puts the connect screen back without touching the saved list.
    await page.getByRole('button', { name: 'Настройки', exact: true }).click();
    await page.getByRole('tab', { name: 'Подключение', exact: true }).click();
    await page.getByRole('button', { name: 'Сменить сервер' }).click();
    await expect(page.getByRole('heading', { name: 'Выберите сервер' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Настроить «Запасной»' })).toBeVisible();
  } finally {
    await context.close();
  }
});
