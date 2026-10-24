import { expect, test, type Page } from '@playwright/test';

/**
 * Окна не стопкой (S5, R49): «Поддержка» из диагностики закрывает диагностику, поддержка — верхнее
 * окно, и обращение в ней заполняется и уходит; «Открыть диагностику» — обратно, снова одно окно.
 * «Сообщить о проблеме» (R79) — отмеченное чипами и отчёт этого звонка. Там же — «Диагностика» без
 * подзаголовка и с обычным разделом подробностей (R47, R48), «Настройки встречи» с переключателем
 * интеграций и без лишних пояснений (R53–R56), «Поддержка» — раздел настроек без второго окна (R51).
 *
 * Одна встреча на весь сценарий. Отправка обращения подменена, как в `support.spec.ts`: сценарий
 * гоняют против стенда, и каждое обращение ушло бы владельцу в Telegram.
 */

/** Верхнее ли окно у этого места: в его середине — оно само, а не чужое окно над ним. */
const onTop = (page: Page, selector: string) =>
  page.locator(selector).evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return !!hit && (element === hit || element.contains(hit));
  });

test('диагностика → «Поддержка»: одно окно, обращение уходит; настройки встречи — переключатель', async ({
  page,
}) => {
  test.setTimeout(180000);
  let sent: Record<string, unknown> | null = null;
  await page.route('**/api/v1/proof?for=support', (route) => route.fulfill({ status: 204 }));
  await page.route('**/api/v1/support', async (route) => {
    sent = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ json: { id: '1a2b3c4d-0000-4000-8000-000000000000', number: '1A2B3C4D' } });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: /Новая встреча/ }).click();
  await page.getByLabel('Ваше имя').fill('Майя');
  await page.getByRole('button', { name: 'Начать встречу' }).click();
  await expect(page.locator('[data-media-status="connected"]')).toBeVisible({ timeout: 30000 });
  const more = () => page.getByRole('button', { name: 'Настройки и действия' }).click();

  // «Диагностика»: без подзаголовка (R47), подробности — раздел с заголовком, а не <details> (R48).
  await more();
  await page.getByRole('menuitem', { name: /^Диагностика/ }).click();
  const diagnostics = page.getByRole('dialog', { name: 'Диагностика' });
  await expect(diagnostics).toBeVisible();
  await expect(diagnostics).not.toContainText('Проверьте устройства и фактическое соединение');
  await expect(
    diagnostics.getByRole('heading', { name: 'Подробности аудио и видео', level: 3 }),
  ).toBeVisible();
  await expect(diagnostics.locator('details, summary')).toHaveCount(0);

  // R49: «Поддержка» — диагностика закрыта, поддержка сверху, фокус в ней.
  await diagnostics.getByRole('button', { name: 'Поддержка' }).click();
  const help = page.getByRole('dialog', { name: 'Поддержка' });
  await expect(help).toBeVisible();
  await expect(diagnostics).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(1);
  expect(await help.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await help.getByRole('tab', { name: 'Написать' }).click();
  const field = help.getByRole('textbox', { name: 'Что случилось' });
  await field.scrollIntoViewIfNeeded();
  expect(await onTop(page, '.help-dialog textarea')).toBe(true);
  await field.fill('Музыка заикается во встрече');
  await help.getByRole('switch', { name: /Приложить диагностику/ }).check();
  await help.getByRole('button', { name: 'Отправить' }).click();
  // Задача «не бот» решается в фоновом потоке — на медленной машине это секунды.
  await expect(help.getByText('Обращение 1A2B3C4D отправлено')).toBeVisible({ timeout: 20000 });
  expect(sent).toMatchObject({ topic: 'network', consent: true });

  // Из поддержки — обратно в диагностику этой встречи: снова одно окно.
  await help.getByRole('tab', { name: 'Проверить' }).click();
  await help.getByRole('button', { name: 'Открыть диагностику' }).click();
  const again = page.getByRole('dialog', { name: 'Диагностика' });
  await expect(again).toBeVisible();
  await expect(help).toHaveCount(0);

  // R79: «Сообщить о проблеме» — диагностика закрыта, поддержка сразу на выборе того, что не так;
  // к обращению приложен отчёт этого звонка — числа без имён.
  await again.getByRole('button', { name: 'Сообщить о проблеме' }).click();
  await expect(again).toHaveCount(0);
  const what = help.getByRole('group', { name: 'Что не так' });
  await what.getByRole('checkbox', { name: 'Не слышно музыку' }).click();
  await what.getByRole('checkbox', { name: 'Звук обрывается' }).click();
  await expect(help.getByRole('switch', { name: /Приложить отчёт о звонке/ })).toBeChecked();
  await help.getByRole('button', { name: 'Отправить' }).click();
  await expect(help.getByText('Обращение 1A2B3C4D отправлено')).toBeVisible({ timeout: 20000 });
  expect(sent).toMatchObject({ topic: 'report', issues: ['sound', 'music'], consent: true });
  expect(String(sent!['diagnostics'])).toMatch(/call: \d+ s/);
  expect(String(sent!['diagnostics'])).not.toContain('Майя');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // R53–R56: «Настройки встречи» — без «Меняет только организатор…», интеграции переключателем.
  await more();
  await page.getByRole('menuitem', { name: 'Настройки встречи' }).click();
  const room = page.getByRole('dialog', { name: 'Настройки встречи' });
  await expect(room).toBeVisible();
  await expect(room).not.toContainText('Меняет только организатор');
  await expect(room).not.toContainText('Громкость каждый');
  await expect(room.getByRole('checkbox')).toHaveCount(0);
  const integrations = room.getByRole('switch', { name: /Разрешить интеграции всем участникам/ });
  await expect(integrations).toBeChecked();
  const save = room.getByRole('button', { name: 'Сохранить' });
  await expect(save).toBeDisabled();
  await room.getByRole('radio', { name: 'С подтверждения' }).click();
  await expect(room).toContainText('Каждый входящий ждёт, пока вы его впустите.');
  await integrations.click();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(room).toHaveCount(0);

  // R51: «Поддержка» — раздел настроек над «О программе»: вкладки прямо в настройках, второго окна нет.
  await more();
  await page.getByRole('menuitem', { name: 'Настройки', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Настройки' });
  await settings
    .getByRole('navigation', { name: 'Разделы настроек' })
    .getByRole('button', { name: 'Поддержка', exact: true })
    .click();
  await settings.getByRole('tab', { name: 'Написать' }).click();
  await expect(settings.getByRole('textbox', { name: 'Что случилось' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Выйти из встречи' }).click();
});
