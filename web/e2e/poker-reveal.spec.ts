import { expect, test } from '@playwright/test';

/**
 * «Показать карты» — право, а не обязанность.
 *
 * Банк, взятый без вскрытия, — единственный случай, когда карты победителя не видит никто, и
 * именно тогда за столом просят их показать. Проверяется весь путь: кнопка есть у того, у кого
 * карты, нажатие открывает их **остальным**, и второй раз нажимать нечего.
 */
test('карты показывают по желанию, и это видят все', async ({ browser }) => {
  test.setTimeout(150000);
  const a = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const b = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const host = await a.newPage();
  const guest = await b.newPage();
  try {
    await host.goto('/');
    await host.getByRole('button', { name: /Новая встреча/ }).click();
    await host.getByLabel('Ваше имя').fill('Майс');
    await host.getByRole('button', { name: 'Начать встречу' }).click();
    await expect(host.getByText('В эфире', { exact: true })).toBeVisible({ timeout: 25000 });
    await host.getByRole('button', { name: 'Пригласить участников', exact: true }).click();
    const invitation = await host.getByRole('textbox', { name: 'Ссылка приглашения' }).inputValue();
    await host.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await guest.goto(invitation);
    await guest.getByLabel('Ваше имя').fill('Алекс');
    await guest.getByRole('button', { name: 'Войти во встречу' }).click();
    await expect(guest.getByText('В эфире', { exact: true })).toBeVisible({ timeout: 25000 });

    await host.getByRole('button', { name: 'Интеграции', exact: true }).click();
    await host.getByRole('button', { name: /Игры/ }).click();
    await host.getByRole('button', { name: /Покер/ }).click();
    await host.getByRole('button', { name: /Открыть стол/ }).click();
    await host.locator('.game-seat-action').first().click();
    await guest.locator('.game-seat-action').first().click();
    await expect.poll(() => host.locator('.poker-seat:not(.is-empty)').count()).toBe(2);
    await host.locator('.poker-bar').getByRole('button', { name: 'Раздать' }).click();
    await expect(host.locator('.poker-mine-cards .playing-card')).toHaveCount(2);

    // Кто-то пасует — банк уходит без вскрытия, и карт победителя не видел никто.
    // Вдвоём один пас сразу заканчивает раздачу. Ждём опубликованный ход, а после
    // команды — итог у обоих клиентов: ответ на нажатие ещё не означает новый снимок.
    await expect
      .poll(
        async () =>
          (await host.locator('.poker-action.is-fold').isVisible()) ||
          (await guest.locator('.poker-action.is-fold').isVisible()),
      )
      .toBe(true);
    const acting = (await host.locator('.poker-action.is-fold').isVisible()) ? host : guest;
    await acting.locator('.poker-action.is-fold').click();
    await expect(host.locator('.poker[data-phase="showdown"]')).toBeVisible({ timeout: 15000 });
    await expect(guest.locator('.poker[data-phase="showdown"]')).toBeVisible({ timeout: 15000 });

    // Итог раздачи ждёт ведущего — значит, и кнопка ждёт вместе с ним, а не гаснет за две секунды.
    const shower = (await host.getByRole('button', { name: /Показать карты/ }).count()) ? host : guest;
    const watcher = shower === host ? guest : host;
    await expect(shower.getByRole('button', { name: /Показать карты/ })).toBeVisible();
    await expect(watcher.locator('.poker-seat:not([data-mine]) .playing-card[data-back]')).toHaveCount(2);
    await shower.getByRole('button', { name: /Показать карты/ }).click();
    // Карты открылись соседу, а показавшему предлагать больше нечего.
    await expect(watcher.locator('.poker-seat:not([data-mine]) .playing-card:not([data-back])')).toHaveCount(
      2,
      { timeout: 10000 },
    );
    await expect(shower.getByRole('button', { name: /Показать карты/ })).toHaveCount(0);
    await watcher.screenshot({ path: '../.local/poker-reveal.png' });
  } finally {
    await a.close();
    await b.close();
  }
});
