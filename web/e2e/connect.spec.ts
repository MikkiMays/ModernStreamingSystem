import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * The connect screen is the first thing Cord shows, and on a server with a password it is the
 * only thing until the handshake succeeds. Automatic connection is turned off here so the
 * screen stays put long enough to be exercised; with it on, an open server goes straight
 * through, which is what a normal visit looks like.
 *
 * There is one server on it, because in a browser there can be only one: the core refuses a
 * foreign Origin. The list of servers belongs to the Windows client.
 */
test('the server answers before any meeting is shown', async ({ browser }) => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    localStorage.setItem(
      'cord:servers:v1',
      JSON.stringify({ url: location.origin + '/', name: 'Мой сервер', password: '', autoConnect: false }),
    );
  });
  const page = await context.newPage();
  try {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Мой сервер' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Новая встреча/ })).toHaveCount(0);
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations,
    ).toEqual([]);

    await page.getByRole('button', { name: 'Подключиться' }).click();
    await expect(page.getByRole('button', { name: /Новая встреча/ })).toBeVisible();

    // The connection belongs to the visit: a new tab shakes hands again by itself.
    const second = await context.newPage();
    await second.goto('/');
    await expect(second.getByRole('heading', { name: 'Мой сервер' })).toBeVisible();
    await second.close();

    // Disconnecting puts the connect screen back.
    await page.getByRole('button', { name: 'Настройки', exact: true }).click();
    await page.getByRole('tab', { name: 'Подключение', exact: true }).click();
    await page.getByRole('button', { name: 'Отключиться' }).click();
    await expect(page.getByRole('heading', { name: 'Мой сервер' })).toBeVisible();
  } finally {
    await context.close();
  }
});
