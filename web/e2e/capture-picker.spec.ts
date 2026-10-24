import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { startMeeting } from './support/cinema';

/*
  Окно показа клиента Windows (R60, R80, R95, R82 → n05) — единственное: окно выбора оболочки
  удалено (WD2). Мост v2 подменён, как у оболочки: экраны и окна приходят ответом `capture.sources`,
  выбор уходит `capture.select`, а сам экран отдаёт Chromium (`--auto-select-desktop-capture-source`).
  Показ должен пойти с тем, что выбрано в окне, — режимом, качеством и превью, — и выбор запомниться.
*/

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const calls: { method: string; payload: unknown }[] = [];
    (window as unknown as { captureCalls: typeof calls }).captureCalls = calls;
    (window as unknown as { cordDesktop: unknown }).cordDesktop = {
      protocol: { major: 2, minor: 0 },
      features: ['capture', 'capture.system-audio'],
      app: { version: '1.0.6', arch: 'x64' },
      bootstrap: {
        profile: '',
        theme: 'system',
        language: null,
        showPing: false,
        notificationSounds: true,
        autoConnect: true,
      },
      send() {},
      invoke: async (method: string, payload: unknown) => {
        calls.push({ method, payload });
        if (method === 'capture.sources')
          return {
            systemAudio: true,
            appAudio: false,
            sources: [
              { id: 'screen:0:0', name: 'Экран 1', thumbnail: '', icon: '' },
              { id: 'window:7:0', name: 'Блокнот', thumbnail: '', icon: '' },
            ],
          };
        if (method === 'capture.select') return true;
        return null;
      },
      on: () => () => {},
    };
  });
});

test('окно показа: вкладки, режим, качество и превью — и показ идёт с выбранным (R60, R80, R95)', async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 1280, height: 720 });
  await startMeeting(page, 'Ника');
  await page.getByRole('button', { name: 'Показать экран', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Что показать' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('tab')).toHaveText(['Приложения', 'Весь экран', 'Устройства']);
  await expect(dialog.getByRole('tab', { name: 'Весь экран' })).toHaveAttribute('aria-selected', 'true');
  // Окно целиком в окне браузера: подвал с «Показать» не уезжает под край.
  const share = dialog.getByRole('button', { name: 'Показать', exact: true });
  await expect(share).toBeInViewport({ ratio: 1 });
  await expect(share).toBeDisabled();
  expect(
    (await new AxeBuilder({ page }).include('.capture-picker').withTags(['wcag2a', 'wcag2aa']).analyze())
      .violations,
  ).toEqual([]);
  // Своей камеры среди устройств захвата нет; другой здесь нет — понятная строка.
  await dialog.getByRole('tab', { name: 'Устройства' }).click();
  await expect(dialog.getByText('Устройств захвата нет')).toBeVisible();
  await dialog.getByRole('tab', { name: 'Приложения' }).click();
  await expect(dialog.getByRole('button', { name: 'Блокнот' })).toBeVisible();
  await dialog.getByRole('tab', { name: 'Весь экран' }).click();

  await dialog.getByRole('radio', { name: 'Чёткость', exact: true }).click();
  await dialog.getByRole('button', { name: 'Настройки показа' }).click();
  const options = page.locator('.capture-picker__options');
  await options.getByRole('radio', { name: '720p', exact: true }).click();
  await options.getByRole('switch', { name: 'Показывать превью зрителям' }).click();
  await expect(options.getByRole('switch', { name: 'Показывать превью зрителям' })).not.toBeChecked();
  // Карточка шестерёнки — поверх окна показа, а не под ним.
  const gear = await options.boundingBox();
  expect(
    await page.evaluate(
      ([x, y]) => !!document.elementFromPoint(x!, y!)?.closest('.capture-picker__options'),
      [gear!.x + gear!.width / 2, gear!.y + 12],
    ),
  ).toBe(true);
  await dialog.getByRole('button', { name: 'Настройки показа' }).click();
  await expect(options).toBeHidden();
  await expect(dialog.locator('.capture-picker__summary')).toHaveText(/^Чёткость · 720p · до \d+ fps$/);

  await dialog.getByRole('button', { name: 'Экран 1' }).click();
  await share.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Остановить показ', exact: true })).toBeVisible({
    timeout: 20000,
  });
  const calls = await page.evaluate(
    () => (window as unknown as { captureCalls: { method: string; payload: unknown }[] }).captureCalls,
  );
  expect(calls).toContainEqual({ method: 'capture.select', payload: { id: 'screen:0:0', audio: 'none' } });
  // Выбор помнится: следующий показ откроется с ним (`preferences.screen`).
  const saved = await page.evaluate(
    () => JSON.parse(localStorage.getItem('cord:preferences:v1') ?? '{}').screen as Record<string, unknown>,
  );
  expect(saved).toMatchObject({ mode: 'sharp', resolution: 720, preview: false, audio: 'none' });
  // «Остановить показ» сразу после старта — показ кончается, даже если ещё не разогнался (R81).
  await page.getByRole('button', { name: 'Остановить показ', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Показать экран', exact: true })).toBeVisible({
    timeout: 5000,
  });
});
