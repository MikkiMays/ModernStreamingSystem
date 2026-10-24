import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * «Поддержка» (E13, T36, R37, R38): страница `/support` вне приложения и гарнитура там, где
 * застревают; внутри — вкладки «Частые вопросы · Проверить · Написать». Отправка формы подменена:
 * сценарий гоняют и против прода, и каждое обращение ушло бы владельцу в Telegram. Само обращение до
 * базы и очереди бота проверяет ядро (`SupportTest`).
 */
test('the support page answers common questions and sends a ticket with the visitor’s consent', async ({
  page,
}) => {
  test.setTimeout(90000);
  let sent: Record<string, unknown> | null = null;
  await page.route('**/api/v1/proof?for=support', (route) => route.fulfill({ status: 204 }));
  await page.route('**/api/v1/support', async (route) => {
    sent = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ json: { id: '1a2b3c4d-0000-4000-8000-000000000000', number: '1A2B3C4D' } });
  });

  await page.goto('/support#smartscreen');
  await expect(page.getByRole('heading', { level: 1, name: 'Поддержка' })).toBeVisible();
  // Вопрос из адреса раскрыт первым — аккордеон, без `<details>`; ни ссылок на исходники, ни автора.
  await expect(page.getByRole('button', { expanded: true }).first()).toContainText('Windows пишет');
  await expect(page.locator('details')).toHaveCount(0);
  await expect(page.locator('a[href*="github.com"], a[href*="t.me"]')).toHaveCount(0);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations,
  ).toEqual([]);

  // «Написать» — форма начинается с темы вопроса из адреса; тема — чипами (R38).
  await page.getByRole('tab', { name: 'Написать' }).click();
  await expect(page.getByRole('radio', { name: 'Приложение для Windows' })).toBeChecked();
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations,
  ).toEqual([]);
  await page
    .getByRole('textbox', { name: 'Что случилось' })
    .fill('Установщик не запускается после «Подробнее»');
  await page.getByRole('textbox', { name: 'Как с вами связаться' }).fill('@someone');
  // Да или нет — переключатель (X4).
  await page.getByRole('switch', { name: /Приложить диагностику/ }).check();
  await page.getByRole('button', { name: 'Что будет отправлено' }).click();
  await expect(page.locator('.help-preview__text')).toContainText('client: web');
  await page.getByRole('button', { name: 'Отправить' }).click();
  // Задача «не бот» решается в фоновом потоке — на медленной машине это секунды.
  await expect(page.getByText('Обращение 1A2B3C4D отправлено')).toBeVisible({ timeout: 20000 });
  expect(sent).toMatchObject({ topic: 'windows', contact: '@someone', consent: true });
  expect(String(sent!['diagnostics'])).toContain('browser:');
});

test('«Поддержка» on the home page opens the support window without leaving it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Новая встреча/ })).toBeVisible({ timeout: 25000 });
  await page.getByRole('button', { name: 'Поддержка' }).click();
  const help = page.getByRole('dialog', { name: 'Поддержка' });
  const tabs = help.getByRole('tablist', { name: 'Разделы поддержки' });
  await expect(tabs.getByRole('tab', { name: 'Частые вопросы' })).toHaveAttribute('aria-selected', 'true');
  // Вкладки стоят на месте, окно не меняет высоту от вкладки к вкладке.
  const height = (await help.boundingBox())!.height;
  await tabs.getByRole('tab', { name: 'Написать' }).click();
  await expect(help.getByRole('textbox', { name: 'Что случилось' })).toBeVisible();
  expect((await help.boundingBox())!.height).toBe(height);
  expect(new URL(page.url()).pathname).toBe('/');
  await help.getByRole('button', { name: 'Закрыть' }).click();
  await expect(help).toHaveCount(0);
});

for (const width of [360, 1440, 2560])
  test(`the support page fits ${width} px in both themes`, async ({ page }) => {
    test.setTimeout(90000);
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((value) => localStorage.setItem('cord:theme', value), theme);
      await page.goto('/support');
      await expect(page.getByRole('heading', { level: 1, name: 'Поддержка' })).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
      ).toBeLessThanOrEqual(0);
    }
  });
