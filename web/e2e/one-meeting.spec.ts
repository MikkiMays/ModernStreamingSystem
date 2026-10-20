import { expect, test } from '@playwright/test';
import { inviteLink, startMeeting } from './support/cinema';

/**
 * Одна встреча на устройство (T52, WP1). Ядро не пускает профиль во вторую встречу —
 * `409 ALREADY_IN_MEETING`, — и человек выбирает словами: «Выйти оттуда и войти сюда»
 * повторяет вход с `X-Cord-Leave`, и ядро в одном шаге выводит из первой и впускает во вторую.
 * Вкладки одного браузера делят профиль, поэтому вторая вкладка того же контекста — то же
 * «устройство». Обе встречи создаются здесь же: создание проходит задачу «не бот» (E11-B).
 */
test('a second meeting on the same device asks first, then moves the person over', async ({ browser }) => {
  test.setTimeout(150000);
  const mine = await browser.newContext();
  const theirs = await browser.newContext();
  try {
    const first = await mine.newPage();
    await startMeeting(first, 'Майс');

    const host = await theirs.newPage();
    await startMeeting(host, 'Алекс');
    const invitation = await inviteLink(host);

    const second = await mine.newPage();
    await second.goto(invitation);
    await second.getByLabel('Ваше имя').fill('Майс');
    await second.getByRole('button', { name: 'Войти во встречу' }).click();

    const choice = second.getByRole('dialog', { name: /^Вы уже во встрече/ });
    await expect(choice).toBeVisible({ timeout: 25000 });
    await expect(choice.getByRole('button', { name: 'Перейти туда' })).toBeVisible();
    await choice.getByRole('button', { name: 'Выйти оттуда и войти сюда' }).click();

    await expect(second.locator('[data-media-status="connected"]')).toBeVisible({ timeout: 25000 });
    await expect(choice).toHaveCount(0);
    // Ведущий второй встречи видит пришедшего.
    await expect(host.getByText('Майс', { exact: true }).first()).toBeVisible({ timeout: 20000 });
    // Первая вкладка из своей встречи вышла: эфира там больше нет.
    await expect(first.locator('[data-media-status="connected"]')).toHaveCount(0, { timeout: 20000 });
  } finally {
    await mine.close();
    await theirs.close();
  }
});
