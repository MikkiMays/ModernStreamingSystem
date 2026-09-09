import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('nine-digit admission, explicit return and cached camera/screen quality work together', async ({
  browser,
}) => {
  test.setTimeout(90000);
  const a = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const b = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const host = await a.newPage();
  const guest = await b.newPage();
  try {
    await host.goto('/');
    await host.getByRole('button', { name: /Новая встреча/ }).click();
    await host.getByLabel('Название встречи').fill('Наша любимая комната');
    await host.getByRole('button', { name: 'Настройки предпросмотра' }).click();
    await expect(host.getByRole('combobox', { name: 'Микрофон', exact: true })).toBeVisible();
    await expect(host.getByLabel('Камера: частота кадров', { exact: true })).toHaveValue('auto');
    await host.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await expect(host.getByRole('combobox', { name: 'Микрофон', exact: true })).toHaveCount(0);
    await expect(host.getByText(/Доступ разрешён/)).toBeVisible();
    await host.getByLabel('Ваше имя').fill('Хозяин');
    await host.getByRole('button', { name: 'Начать встречу' }).click();
    await expect(host.getByText('В эфире', { exact: true })).toBeVisible();
    await expect(host.getByRole('button', { name: 'Включить камеру', exact: true })).toBeVisible();
    await expect(host.getByRole('button', { name: 'Включить микрофон', exact: true })).toBeVisible();
    const code = (await host.getByRole('button', { name: 'Код встречи', exact: true }).innerText()).trim();
    expect(code).toMatch(/^\d{3}-\d{3}-\d{3}$/);
    await host.getByRole('button', { name: 'Чат', exact: true }).click();
    await host.getByLabel('Сообщение', { exact: true }).fill('Продолжаем этот разговор');
    await host.getByRole('button', { name: 'Отправить сообщение' }).click();
    await guest.goto('/');
    await guest.getByLabel('Код встречи или ссылка').fill(code.replaceAll('-', ''));
    await expect(guest.getByLabel('Код встречи или ссылка')).toHaveValue(code);
    await guest.getByRole('button', { name: 'Присоединиться', exact: true }).click();
    await guest.getByLabel('Ваше имя').fill('Гость по коду');
    await guest.getByRole('button', { name: 'Запросить подключение' }).click();
    await expect(guest.getByText('Организатор скоро впустит вас')).toBeVisible();
    await host.getByRole('button', { name: /Запросы на подключение/ }).click();
    await host.getByRole('button', { name: 'Разрешить вход: Гость по коду' }).click();
    await expect(guest.getByText('В эфире', { exact: true })).toBeVisible();
    await guest.getByRole('button', { name: 'Сохранить комнату в избранное' }).click();
    await host.getByRole('button', { name: 'Сохранить комнату в избранное' }).click();
    await guest.getByRole('button', { name: 'Чат', exact: true }).click();
    await expect(guest.getByText('Продолжаем этот разговор', { exact: true })).toBeVisible();

    await host.getByRole('button', { name: 'Настройки качества', exact: true }).click();
    await expect(host.getByLabel('Камера: качество', { exact: true })).toHaveValue('auto');
    await expect(host.getByLabel('Экран: качество', { exact: true })).toHaveValue('auto');
    await host.getByLabel('Камера: качество', { exact: true }).selectOption('1080');
    await host.getByLabel('Камера: частота кадров', { exact: true }).selectOption('60');
    await host.getByLabel('Экран: качество', { exact: true }).selectOption('1440');
    await host.getByLabel('Экран: частота кадров', { exact: true }).selectOption('60');
    await host.emulateMedia({ reducedMotion: 'reduce' });
    expect(
      (await new AxeBuilder({ page: host }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations,
    ).toEqual([]);
    await host.screenshot({ path: '../.local/quality-settings.png' });
    await host.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await expect(host.locator('video.camera-video')).toHaveCount(0);
    await host.getByRole('button', { name: 'Включить камеру', exact: true }).click();
    await expect
      .poll(() => guest.locator('video.camera-video').evaluate((v: HTMLVideoElement) => v.videoWidth))
      .toBeGreaterThan(0);
    await host.getByRole('button', { name: 'Настройки качества', exact: true }).click();
    await host.getByLabel('Камера: частота кадров', { exact: true }).selectOption('30');
    await host.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await expect
      .poll(() => guest.locator('video.camera-video').evaluate((v: HTMLVideoElement) => v.videoWidth))
      .toBeGreaterThan(0);

    await guest.getByRole('button', { name: 'Выйти из встречи' }).click();
    await expect(guest.getByRole('heading', { name: 'На одной волне.' })).toBeVisible();
    await guest.reload();
    await expect(guest.getByRole('heading', { name: 'Недавние встречи' })).toHaveCount(0);
    await guest.getByRole('button', { name: new RegExp(code) }).click();
    await expect(guest.getByLabel('Ваше имя')).toHaveValue('Гость по коду');
    await expect(guest.getByLabel('Название встречи')).toHaveCount(0);
    await expect(guest.getByRole('button', { name: 'Включить камеру', exact: true })).toBeVisible();
    await guest.getByRole('button', { name: 'Войти во встречу' }).click();
    await expect(guest.getByText('В эфире', { exact: true })).toBeVisible();
    await guest.getByRole('button', { name: 'Чат', exact: true }).click();
    await expect(guest.getByText('Продолжаем этот разговор', { exact: true })).toBeVisible();
    await expect(host.locator('.participant-row')).toHaveCount(2);

    await host.getByRole('button', { name: 'Выйти из встречи' }).click();
    await expect(host.getByRole('heading', { name: 'На одной волне.' })).toBeVisible();
    await host.getByRole('button', { name: new RegExp(code) }).click();
    await host.getByRole('button', { name: 'Войти во встречу' }).click();
    await expect(host.getByText('В эфире', { exact: true })).toBeVisible();
    await host.getByRole('button', { name: 'Настройки качества', exact: true }).click();
    await expect(host.getByLabel('Камера: качество', { exact: true })).toHaveValue('1080');
    await expect(host.getByLabel('Камера: частота кадров', { exact: true })).toHaveValue('30');
    await expect(host.getByLabel('Экран: качество', { exact: true })).toHaveValue('1440');
    await expect(host.getByLabel('Экран: частота кадров', { exact: true })).toHaveValue('60');
    await host.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await expect(host.getByRole('button', { name: 'Включить камеру', exact: true })).toBeVisible();
    await host.getByRole('button', { name: 'Настройки и действия' }).click();
    await host.getByRole('menuitem', { name: 'Завершить для всех' }).click();
    // Only the definition persists: favorited closed rooms can start another conversation.
    await host.getByRole('button', { name: 'На главную', exact: true }).click();
    await host.getByRole('button', { name: new RegExp(code) }).click();
    await host.getByRole('button', { name: 'Войти во встречу' }).click();
    await expect(host.getByText('В эфире', { exact: true })).toBeVisible();
    await expect(host.getByRole('heading', { name: 'Наша любимая комната' })).toBeVisible();
    await host.getByRole('button', { name: 'Убрать комнату из избранного' }).click();
    await host.getByRole('button', { name: 'Выйти из встречи' }).click();
  } finally {
    await a.close();
    await b.close();
  }
});
