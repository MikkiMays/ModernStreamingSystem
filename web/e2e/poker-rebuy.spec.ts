import { expect, test, type Page } from '@playwright/test';

/**
 * Фишки кончились — и это событие, а не кнопка.
 *
 * Проверяется то, из-за чего правило и переписали: одно нажатие больше не выдаёт новый стек.
 * Человек видит красную полосу с суммой, тянет ползунок вправо — и только тогда фишки
 * появляются. И второе: когда додепы кончились, полосы нет вовсе, а место освобождают руками.
 */
test('додеп подтверждают движением, а не нажатием', async ({ browser }) => {
  test.setTimeout(180000);
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

    // Стол с одним додепом на человека: второго вылета никто не переживёт.
    await host.getByRole('button', { name: 'Интеграции', exact: true }).click();
    await host.getByRole('button', { name: /Игры/ }).click();
    await host.getByRole('button', { name: /Покер/ }).click();
    const stack = host.getByLabel('Стартовый стек, фишки');
    await stack.fill('400');
    await stack.press('Enter');
    await host.getByRole('button', { name: '1', exact: true }).click();
    await host.getByRole('button', { name: /Открыть стол/ }).click();
    await expect(host.locator('.poker-felt')).toBeVisible();
    /*
      Сесть — с повтором.

      Стол открывается двумя командами (правила додепа приезжают следом), и между ними сцена
      перерисовывается. Нажатие, попавшее ровно в этот кадр, теряется — человек нажмёт ещё раз и
      не заметит, а тест обязан довести дело до конца.
    */
    const sit = async (page: Page) => {
      for (let attempt = 0; attempt < 6; attempt++) {
        if (await page.locator('.poker-seat[data-mine]').count()) return;
        await page
          .locator('.game-seat-action')
          .click({ timeout: 5000 })
          .catch(() => {});
        await page.waitForTimeout(300);
      }
      throw new Error('не удалось сесть за стол');
    };
    await sit(host);
    await sit(guest);
    await expect.poll(() => host.locator('.poker-seat:not(.is-empty)').count()).toBe(2);

    const bust = async () => {
      await host.locator('.poker-bar').getByRole('button', { name: 'Раздать' }).click();
      for (let step = 0; step < 40; step++) {
        if (await host.locator('.poker[data-phase="showdown"]').count()) break;
        const acting: Page = (await host.locator('.poker-controls[data-turn]').count()) ? host : guest;
        const allin = acting.locator('.poker-action.is-allin');
        const raise = acting.locator('.poker-action.is-raise');
        const call = acting.locator('.poker-action.is-call, .poker-action.is-check').first();
        if (await allin.count()) await allin.click();
        else if (await raise.count()) {
          await raise.click();
          await acting.locator('.poker-step', { hasText: 'Ва-банк' }).click();
          await acting.locator('.poker-sizer-row .button.primary').click();
        } else if (await call.count()) await call.click();
        else await acting.waitForTimeout(250);
      }
      await expect(host.locator('.poker[data-phase="showdown"]')).toBeVisible({ timeout: 20000 });
      await host.locator('.poker-bar').getByRole('button', { name: 'Продолжить' }).click();
    };

    await bust();
    // У проигравшего фишек нет: красная полоса вместо кнопок, и кнопки «докупиться» больше нет.
    const loser: Page = (await host.locator('.poker-rebuy').count()) ? host : guest;
    await expect(loser.locator('.poker-controls[data-out="true"]')).toBeVisible();
    await expect(loser.getByText('Фишки кончились')).toBeVisible();
    await expect(loser.getByRole('button', { name: /Докупиться/ })).toHaveCount(0);

    // Тянем ползунок вправо — только это и добавляет фишки.
    const slide = loser.locator('.poker-slide');
    const knob = loser.locator('.poker-slide-knob');
    const box = (await slide.boundingBox())!;
    const grip = (await knob.boundingBox())!;
    await loser.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await loser.mouse.down();
    await loser.mouse.move(box.x + box.width * 0.5, grip.y + grip.height / 2, { steps: 8 });
    // На середине пути ещё ничего не произошло.
    await expect(loser.locator('.poker-slide[data-done]')).toHaveCount(0);
    await loser.mouse.move(box.x + box.width - 4, grip.y + grip.height / 2, { steps: 8 });
    await loser.mouse.up();
    await expect(loser.locator('.poker-rebuy')).toHaveCount(0, { timeout: 10000 });
    await expect(loser.locator('.poker-seat[data-mine][data-busted]')).toHaveCount(0);
    await loser.screenshot({ path: '../.local/poker-rebuy.png' });

    // Второй вылет: додеп был один, и предлагать больше нечего.
    await bust();
    const out: Page = (await host.locator('.poker-seat[data-busted]').count()) ? host : guest;
    await expect(out.locator('.poker-rebuy')).toHaveCount(0);
  } finally {
    await a.close();
    await b.close();
  }
});
