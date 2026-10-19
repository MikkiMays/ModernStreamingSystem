import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * `/download` stands outside the application: no server session, no room. Somebody handed the
 * address should be able to fetch the client before they have a password or an invitation.
 *
 * Установщик лежит только на этом сервере: репозиторий приватный, и ссылка в него — 404.
 * Есть манифест — кнопка ведёт в файл, который сервер действительно отдаёт; нет — кнопки нет,
 * и ни одного стороннего адреса на странице тоже. Проверяются оба случая.
 */
test('the download page stands on its own and leads only to this server', async ({ page }) => {
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

  const installer = page.getByRole('link', { name: /Скачать установщик/ });
  if (published) {
    await expect(installer).toBeVisible();
    const href = (await installer.getAttribute('href'))!;
    expect(href).toMatch(new RegExp(`^/downloads/windows/v${manifest!.version}/`));
    const head = await page.request.head(href);
    expect(head.status(), 'the button must point at a file this server really serves').toBe(200);
  } else {
    await expect(page.getByText(/Сборка для Windows сейчас недоступна/)).toBeVisible();
    await expect(installer).toHaveCount(0);
  }
  await expect(page.locator('a[href*="github.com"]')).toHaveCount(0);

  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations,
  ).toEqual([]);

  // Ссылка на страницу есть везде, кроме самого приложения: там оно уже установлено.
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Скачать Cord' })).toHaveCount(1);
});
