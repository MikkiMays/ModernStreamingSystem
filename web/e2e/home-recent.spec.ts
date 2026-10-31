import { expect, test } from '@playwright/test';
import { inviteLink, joinMeeting, startMeeting } from './support/cinema';

/*
  R148 («НЕДАВНИЕ ВСТРЕЧИ супер ВАЖНО», владелец 31.10): встреча, из которой вышли, видна на главной
  под входом — пока в ней кто-то есть, «Вернуться» возвращает тем же участником; закончившаяся
  остаётся строкой «завершена» с «Создать снова» под тем же названием.
*/
test('недавние: вернуться в идущую встречу, «Создать снова» у закончившейся (R148)', async ({ browser }) => {
  const host = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const guest = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const me = await host.newPage();
  const other = await guest.newPage();
  try {
    await startMeeting(me);
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

    // Оба вышли — несохранённая встреча удаляется, а строка остаётся «завершённой».
    await other.getByRole('button', { name: 'Выйти из встречи' }).click();
    await me.getByRole('button', { name: 'Выйти из встречи' }).click();
    await me.goto('/');
    await expect(recent.getByText(/завершена/)).toBeVisible({ timeout: 40000 });
    await recent.getByRole('button', { name: 'Создать снова' }).first().click();
    await expect(me.getByLabel('Название встречи')).not.toHaveValue('Наша встреча');

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
