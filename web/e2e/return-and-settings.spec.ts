import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/** Пункт сегмента качества (R78): «Камера: качество» → «1080p», «Экран: частота кадров» → «60 fps». */
/** Раздел «Видео» окна настроек: камера и показ экрана (R100). */
async function openVideo(page: Page) {
  await page
    .getByRole('navigation', { name: 'Разделы настроек' })
    .getByRole('button', { name: 'Видео', exact: true })
    .click();
  await expect(page.locator('.settings-content__title')).toHaveText('Видео');
}

const level = (page: Page, group: string, name: string) =>
  page.getByRole('radiogroup', { name: group, exact: true }).getByRole('radio', { name, exact: true });

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
    // Вход по коду подчиняется этой настройке: чтобы проверить ожидание и допуск, комнату
    // надо явно закрыть. Открытая комната впускает по правильному коду сразу.
    //
    // Спрашивают об этом на самом предпросмотре, а не в его настройках, — и нажимать нужно
    // там же. Пока это лежало в диалоге, нажатие делалось при открытом диалоге; теперь
    // диалог модальный и прячет от теста всё, что за ним.
    // «Кто может войти» — сегментом, как в настройках встречи (R74): «Сразу по ссылке» / «С подтверждения».
    await host.getByRole('radio', { name: 'С подтверждения', exact: true }).check();
    await host.getByRole('button', { name: 'Настройки предпросмотра' }).click();
    await expect(host.getByRole('combobox', { name: 'Микрофон', exact: true })).toBeVisible();
    // «Авто» больше нет (E05, П2): камера по умолчанию — 480p30 (Р-35).
    await expect(level(host, 'Камера: частота кадров', '30 fps')).toBeChecked();
    await host.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await expect(host.getByRole('combobox', { name: 'Микрофон', exact: true })).toHaveCount(0);
    await expect(host.getByRole('button', { name: /Запросить доступ/ })).toHaveCount(0);
    await host.getByLabel('Ваше имя').fill('Хозяин');
    await host.getByRole('button', { name: 'Начать встречу' }).click();
    await expect(host.locator('[data-media-status="connected"]')).toBeVisible({ timeout: 25000 });
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
    await guest.getByRole('button', { name: 'Войти во встречу' }).click();
    // Вход по коду решает задачу «не бот» и ждёт ядро — на загруженном стенде дольше 5 с по умолчанию.
    await expect(guest.getByText('Организатор скоро впустит вас')).toBeVisible({ timeout: 25000 });
    await host.getByRole('button', { name: /Запросы на подключение/ }).click();
    await host.getByRole('button', { name: 'Разрешить вход: Гость по коду' }).click();
    await expect(guest.locator('[data-media-status="connected"]')).toBeVisible();
    await guest.getByRole('button', { name: 'Сохранить комнату в избранное' }).click();
    await host.getByRole('button', { name: 'Сохранить комнату в избранное' }).click();
    await guest.getByRole('button', { name: 'Чат', exact: true }).click();
    await expect(guest.getByText('Продолжаем этот разговор', { exact: true })).toBeVisible();

    await host.getByRole('button', { name: 'Настройки и действия' }).click();
    await host.getByRole('menuitem', { name: 'Настройки', exact: true }).click();
    // Настройки открываются на «Микрофоне» (R114); камера и показ — в соседнем разделе «Видео» (R100).
    await expect(host.locator('.settings-content__title')).toHaveText('Микрофон');
    await openVideo(host);
    // Камера — 480 / 720 / 1080, умолчание 480p, 1080p виден, но недоступен (Р-35).
    await expect(level(host, 'Камера: качество', '480p')).toBeChecked();
    await expect(level(host, 'Камера: качество', '1080p')).toBeDisabled();
    await expect(level(host, 'Экран: качество', '720p')).toBeChecked();
    // Потолок сервера — 1080p60: 1440p виден, но недоступен (R78).
    await expect(level(host, 'Экран: качество', '1440p')).toBeDisabled();
    await level(host, 'Камера: качество', '720p').click();
    await level(host, 'Камера: частота кадров', '60 fps').click();
    await level(host, 'Экран: качество', '1080p').click();
    await level(host, 'Экран: частота кадров', '60 fps').click();
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
    await host.getByRole('button', { name: 'Настройки и действия' }).click();
    await host.getByRole('menuitem', { name: 'Настройки', exact: true }).click();
    await openVideo(host);
    await level(host, 'Камера: частота кадров', '30 fps').click();
    await host.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await expect
      .poll(() => guest.locator('video.camera-video').evaluate((v: HTMLVideoElement) => v.videoWidth))
      .toBeGreaterThan(0);

    await guest.getByRole('button', { name: 'Выйти из встречи' }).click();
    await expect(
      guest.getByRole('main').getByRole('textbox', { name: 'Код встречи или ссылка' }),
    ).toBeVisible();
    await guest.reload();
    await expect(guest.getByRole('heading', { name: 'Недавние встречи' })).toHaveCount(0);
    // Избранное — в боковой панели главной (E02), а не в диалоге из шапки.
    await guest
      .getByRole('navigation', { name: 'Избранное' })
      .getByRole('button', { name: new RegExp(code) })
      .click();
    await expect(guest.getByLabel('Ваше имя')).toHaveValue('Гость по коду');
    await expect(guest.getByLabel('Название встречи')).toHaveCount(0);
    await expect(guest.getByRole('button', { name: 'Включить камеру', exact: true })).toBeVisible();
    await guest.getByRole('button', { name: 'Войти во встречу' }).click();
    await expect(guest.locator('[data-media-status="connected"]')).toBeVisible();
    await guest.getByRole('button', { name: 'Чат', exact: true }).click();
    await expect(guest.getByText('Продолжаем этот разговор', { exact: true })).toBeVisible();
    await expect(host.locator('.participant-row')).toHaveCount(2);

    await host.getByRole('button', { name: 'Выйти из встречи' }).click();
    await expect(
      host.getByRole('main').getByRole('textbox', { name: 'Код встречи или ссылка' }),
    ).toBeVisible();
    const favorites = host.getByRole('navigation', { name: 'Избранное' });
    await favorites.getByRole('button', { name: 'Действия с «Наша любимая комната»' }).click();
    const automatic = host.getByRole('menuitemcheckbox', { name: 'Автоподключение' });
    await automatic.click();
    // Переключатель меню не закрывает (R70): видно, что включилось, закрывает Esc.
    await expect(automatic).toHaveAttribute('aria-checked', 'true');
    await host.keyboard.press('Escape');
    await expect(host.getByRole('menu')).toHaveCount(0);
    await favorites.getByRole('button', { name: new RegExp(code) }).click();
    await expect(host.getByLabel('Ваше имя')).toHaveCount(0);
    await expect(host.getByRole('button', { name: 'Выключить микрофон', exact: true })).toBeVisible();
    await expect(host.getByRole('button', { name: 'Включить камеру', exact: true })).toBeVisible();
    await expect(host.locator('[data-media-status="connected"]')).toBeVisible();
    await host.getByRole('button', { name: 'Настройки и действия' }).click();
    await host.getByRole('menuitem', { name: 'Настройки', exact: true }).click();
    await openVideo(host);
    await expect(level(host, 'Камера: качество', '720p')).toBeChecked();
    await expect(level(host, 'Камера: частота кадров', '30 fps')).toBeChecked();
    await expect(level(host, 'Экран: качество', '1080p')).toBeChecked();
    await expect(level(host, 'Экран: частота кадров', '60 fps')).toBeChecked();
    await host.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await expect(host.getByRole('button', { name: 'Включить камеру', exact: true })).toBeVisible();
    await host.getByRole('button', { name: 'Настройки и действия' }).click();
    await host.getByRole('menuitem', { name: 'Завершить для всех' }).click();
    // Only the definition persists: favorited closed rooms can start another conversation.
    await host.getByRole('button', { name: 'На главную', exact: true }).click();
    await favorites.getByRole('button', { name: new RegExp(code) }).click();
    await expect(host.locator('[data-media-status="connected"]')).toBeVisible();
    await expect(host.getByRole('heading', { name: 'Наша любимая комната' })).toBeVisible();
    await host.getByRole('button', { name: 'Убрать комнату из избранного' }).click();
    await host.getByRole('button', { name: 'Выйти из встречи' }).click();
  } finally {
    await a.close();
    await b.close();
  }
});
