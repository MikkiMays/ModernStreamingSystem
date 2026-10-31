import { expect, test } from '@playwright/test';
import { inviteLink, joinMeeting } from './support/cinema';

/*
  R148 («НЕДАВНИЕ ВСТРЕЧИ супер ВАЖНО», владелец 31.10): встреча, из которой вышли, видна на главной
  под входом — пока в ней кто-то есть, «Вернуться» возвращает тем же участником; закончившаяся
  остаётся строкой «завершена» с «Создать снова» под тем же названием.
*/
test('недавние: вернуться в идущую встречу, «Создать снова» у закончившейся (R148)', async ({ browser }) => {
  test.setTimeout(150_000);
  const host = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const guest = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const me = await host.newPage();
  const other = await guest.newPage();
  try {
    // Своё название: «Создать снова» должно принести именно его, а не умолчание предвхода.
    await me.goto('/');
    await me.getByRole('button', { name: /Новая встреча/ }).click();
    await me.getByLabel('Ваше имя').fill('Майс');
    await me.getByLabel('Название встречи').fill('Разбор недавних');
    await me.getByRole('button', { name: 'Начать встречу' }).click();
    await expect(me.locator('[data-media-status="connected"]')).toBeVisible({ timeout: 20000 });
    const invitation = await inviteLink(me);
    await joinMeeting(other, invitation);
    await me.getByRole('button', { name: 'Выйти из встречи' }).click();
    await me.goto('/');
    const recent = me.getByRole('region', { name: 'Недавние' });
    await expect(recent).toBeVisible({ timeout: 20000 });
    const row = recent.getByRole('listitem').first();
    await expect(row.getByText('1 человек')).toBeVisible({ timeout: 20000 });
    await row.getByRole('button', { name: 'Вернуться' }).click();
    await me.getByRole('button', { name: 'Войти во встречу' }).click();
    await expect(me.locator('[data-media-status="connected"]')).toBeVisible({ timeout: 20000 });

    // Ведущий завершил встречу для всех — строка остаётся «завершённой».
    await me.getByRole('button', { name: 'Настройки и действия' }).click();
    await me.getByRole('menuitem', { name: 'Завершить для всех' }).click();
    await me.goto('/');
    await expect(recent.getByText(/завершена/)).toBeVisible({ timeout: 40000 });
    await recent.getByRole('button', { name: 'Создать снова' }).first().click();
    await expect(me.getByLabel('Название встречи')).toHaveValue('Разбор недавних');

    for (const width of [390, 1440]) {
      await me.goto('/');
      await me.setViewportSize({ width, height: 900 });
      await expect(recent).toBeVisible();
      expect(await me.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(
        0,
      );
    }
  } finally {
    await host.close();
    await guest.close();
  }
});
