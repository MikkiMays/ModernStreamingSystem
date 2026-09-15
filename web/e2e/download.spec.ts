import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * `/download` stands outside the application: no server session, no room. Somebody handed the
 * address should be able to fetch the client before they have a password or an invitation.
 *
 * Most servers publish no Windows build — a Cord somebody installed for themselves has none
 * until its operator puts one there — so the case exercised here is the honest empty one: the
 * page says so and offers the browser, and nothing anywhere advertises a link to nowhere.
 */
test('the download page stands on its own and offers only what this server has', async ({ page }) => {
  // A missing manifest is a 404 behind the real gateway, but a development server answers
  // every unknown path with the application shell. Trust the content, not the status — which
  // is exactly what the page itself does.
  const probe = await page.request.get('/downloads/windows/download.json');
  const manifest = probe.ok()
    ? ((await probe.json().catch(() => null)) as { version?: string } | null)
    : null;
  const published = typeof manifest?.version === 'string';
  await page.goto('/download');
  await expect(page.getByRole('heading', { name: 'Cord для Windows' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Windows покажет предупреждение/ })).toBeVisible();

  if (published) {
    const installer = page.getByRole('link', { name: /Скачать установщик/ });
    await expect(installer).toBeVisible();
    await expect(installer).toHaveAttribute('href', new RegExp(`^/downloads/windows/v${manifest!.version}/`));
    const head = await page.request.head((await installer.getAttribute('href'))!);
    expect(head.status(), 'the button must point at a file this server really serves').toBe(200);
  } else {
    await expect(page.getByText(/нет опубликованной сборки/)).toBeVisible();
    await expect(page.getByRole('link', { name: /Скачать установщик/ })).toHaveCount(0);
  }

  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations,
  ).toEqual([]);

  // The link into this page is offered only where it can be honoured.
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Скачать Cord' })).toHaveCount(published ? 1 : 0);
});
