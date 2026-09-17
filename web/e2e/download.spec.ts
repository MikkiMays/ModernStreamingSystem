import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * `/download` stands outside the application: no server session, no room. Somebody handed the
 * address should be able to fetch the client before they have a password or an invitation.
 *
 * Большинство серверов ничего у себя не выкладывают — Cord, поднятый по инструкции, своей
 * копии не имеет, пока владелец её туда не положит. Раньше это означало страницу «здесь
 * сборки нет» и исчезнувшую кнопку на главной. Теперь кнопка есть всегда: своя копия, если
 * она есть, иначе последний релиз проекта. Проверяются оба случая.
 */
const REPOSITORY = 'MikkiMays/ModernStreamingSystem.Windows';

test('the download page stands on its own and always leads to a real installer', async ({ page }) => {
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
  await expect(installer).toBeVisible();
  const href = (await installer.getAttribute('href'))!;
  if (published) {
    expect(href).toMatch(new RegExp(`^/downloads/windows/v${manifest!.version}/`));
    const head = await page.request.head(href);
    expect(head.status(), 'the button must point at a file this server really serves').toBe(200);
  } else {
    // Никаких сторонних адресов: по этой ссылке человек запустит исполняемый файл.
    expect(href).toMatch(new RegExp(`^https://github\\.com/${REPOSITORY}/releases/`));
  }

  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations,
  ).toEqual([]);

  // Ссылка на страницу есть везде, кроме самого приложения: там оно уже установлено.
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Скачать Cord' })).toHaveCount(1);
});
