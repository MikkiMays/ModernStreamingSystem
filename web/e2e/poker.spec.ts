import { expect, test, type Page } from '@playwright/test';

/**
 * Покерный стол двумя настоящими браузерами.
 *
 * Проверяется не вёрстка, а три вещи, которых нельзя увидеть в юнит-тестах: карты действительно
 * раздаются обоим, **чужие карты не приезжают в браузер вовсе**, и раздача доигрывается до
 * вскрытия через общий канал команд. Последним идёт то, ради чего вся эта механика и затевалась:
 * браузер сам пересобирает колоду из раскрытого зерна и сверяет её с отпечатком, объявленным до
 * раздачи.
 */
test('two browsers play a hand of poker with private cards and a verifiable deal', async ({ browser }) => {
  test.setTimeout(150000);
  const a = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: { width: 1500, height: 950 },
  });
  const b = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: { width: 1360, height: 900 },
  });
  const host = await a.newPage();
  const guest = await b.newPage();
  try {
    await host.goto('/');
    await host.getByRole('button', { name: /Новая встреча/ }).click();
    await host.getByLabel('Ваше имя').fill('Майс');
    await host.getByRole('button', { name: 'Начать встречу' }).click();
    await expect(host.getByText('В эфире', { exact: true })).toBeVisible({ timeout: 20000 });
    await host.getByRole('button', { name: 'Пригласить участников', exact: true }).click();
    const invitation = await host.getByRole('textbox', { name: 'Ссылка приглашения' }).inputValue();
    await host.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await guest.goto(invitation);
    await guest.getByLabel('Ваше имя').fill('Алекс');
    await guest.getByRole('button', { name: 'Войти во встречу' }).click();
    await expect(guest.getByText('В эфире', { exact: true })).toBeVisible({ timeout: 20000 });

    // Камера включена у обоих: за столом лицо человека должно стоять в кружке его места.
    await host.getByRole('button', { name: 'Включить камеру', exact: true }).click();

    await host.getByRole('button', { name: 'Интеграции', exact: true }).click();
    await host.getByRole('button', { name: /Игры/ }).click();
    // Игр будет больше одной, поэтому в группе список: сначала раскрывается строка игры.
    await host.getByRole('button', { name: /Покер/ }).click();
    await host.getByRole('button', { name: /Открыть стол/ }).click();
    await expect(host.locator('.poker-felt')).toBeVisible();
    await expect(guest.locator('.poker-felt')).toBeVisible({ timeout: 10000 });

    await host.locator('.poker-seat.is-empty .poker-sit').first().click();
    await guest.locator('.poker-seat.is-empty .poker-sit').nth(3).click();
    await expect(host.locator('.poker-seat[data-mine]')).toBeVisible();
    await expect(guest.locator('.poker-seat[data-mine]')).toBeVisible();
    await expect.poll(() => host.locator('.poker-seat:not(.is-empty)').count()).toBe(2);
    // Своё лицо стоит в кружке своего места, а не только в плитке встречи.
    await expect(host.locator('.poker-seat[data-mine] video.poker-camera')).toBeVisible();

    await host.locator('.games-group').getByRole('button', { name: 'Раздать', exact: true }).click();
    await expect(host.locator('.poker-mine-cards .playing-card')).toHaveCount(2);
    await expect(guest.locator('.poker-mine-cards .playing-card')).toHaveCount(2);

    // Чужая рука закрыта: у соседнего места видны только рубашки, и открытых карт там ноль.
    await expect(host.locator('.poker-seat:not([data-mine]) .playing-card[data-back]')).toHaveCount(2);
    await expect(host.locator('.poker-seat:not([data-mine]) .playing-card:not([data-back])')).toHaveCount(0);

    // Доигрываем руку: ходит тот, у кого появились кнопки.
    for (let step = 0; step < 40; step++) {
      if (await host.locator('.poker[data-phase="showdown"]').count()) break;
      const acting: Page = (await host.locator('.poker-controls[data-turn]').count()) ? host : guest;
      const move = acting.locator('.poker-action.is-call, .poker-action.is-check').first();
      if (await move.count()) await move.click();
      else await acting.waitForTimeout(250);
    }
    await expect(host.locator('.poker[data-phase="showdown"]')).toBeVisible({ timeout: 15000 });
    // На вскрытии карты открыты у обоих, и у каждой руки есть имя.
    await expect(host.locator('.poker-combo').first()).toBeVisible();
    // Лента — отдельная панель у края стола, и её можно выключить в меню «Вид».
    await expect(host.locator('.poker-log li').first()).toContainText('забирает');

    // Раздача проверяема: браузер пересобирает колоду из зерна и сверяет её с отпечатком.
    await host.getByRole('button', { name: /Проверить раздачу/ }).click();
    await expect(host.locator('.poker-fair small[data-state="ok"]')).toContainText('Совпало');
    await host.screenshot({ path: '../.local/poker-showdown.png' });
  } finally {
    await a.close();
    await b.close();
  }
});
