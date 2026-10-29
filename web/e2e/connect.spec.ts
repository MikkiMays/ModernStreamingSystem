import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * The connect screen is the first thing Cord shows, and on a server with a password it is the
 * only thing until the handshake succeeds. In a browser connecting is always automatic (R135):
 * even a visit that remembers «не подключаться» from an older version goes straight through, and
 * there is no switch for it — that choice lives only in the Windows client. The handshake is held
 * here for a moment so the screen can be checked before it moves on.
 *
 * There is one server on it, because in a browser there can be only one: the core refuses a
 * foreign Origin. Other servers of the installation are other sites (R136).
 */
test('the server answers before any meeting is shown, and connects by itself', async ({ browser }) => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    localStorage.setItem(
      'cord:servers:v1',
      JSON.stringify({ url: location.origin + '/', name: 'Мой сервер', password: '', autoConnect: false }),
    );
  });
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await context.route('**/api/v1/session', async (route) => {
    await held;
    await route.continue();
  });
  const page = await context.newPage();
  try {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Мой сервер' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Новая встреча/ })).toHaveCount(0);
    await expect(page.getByRole('switch', { name: /Подключаться автоматически/ })).toHaveCount(0);
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations,
    ).toEqual([]);

    // Without a click: the stale «не подключаться» from an older version does not hold the screen.
    release();
    await expect(page.getByRole('button', { name: /Новая встреча/ })).toBeVisible();

    // The connection belongs to the visit: a new tab shakes hands again by itself.
    const second = await context.newPage();
    await second.goto('/');
    await expect(second.getByRole('button', { name: /Новая встреча/ })).toBeVisible();
    await second.close();

    // Settings → «Сервер»: no switch and no «Отключиться» — reconnecting would follow at once.
    await page.getByRole('button', { name: 'Настройки', exact: true }).click();
    await page
      .getByRole('navigation', { name: 'Разделы настроек' })
      .getByRole('button', { name: 'Сервер', exact: true })
      .click();
    await expect(page.getByRole('switch', { name: 'Подключаться при запуске' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Отключиться' })).toHaveCount(0);
  } finally {
    await context.close();
  }
});
