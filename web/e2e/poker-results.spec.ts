import { expect, test, type Page } from '@playwright/test';

/**
 * Конец игры двумя настоящими браузерами.
 *
 * Здесь проверяется не вёрстка, а три вещи, которых не видно ни в одном юнит-тесте: итоги игры
 * приезжают **обоим** (их считает сервер, а не каждый сам), они остаются в истории беседы уже
 * после того, как стола не стало, и пустой стол честно объявляет свой срок. Последнее особенно
 * важно: игру заканчивает сервер сам, и человек обязан узнать об этом заранее.
 *
 * Турнир по триста фишек взят не для красоты: при таком стеке одна раздача решает игру целиком,
 * и весь путь до «Игра окончена» укладывается в полминуты.
 */

async function start(page: Page, name: string) {
  await page.goto('/');
  await page.getByRole('button', { name: /Новая встреча/ }).click();
  await page.getByLabel('Ваше имя').fill(name);
  await page.getByRole('button', { name: 'Начать встречу' }).click();
  await expect(page.getByText('В эфире', { exact: true })).toBeVisible({ timeout: 25000 });
}

async function invite(host: Page): Promise<string> {
  await host.getByRole('button', { name: 'Пригласить участников', exact: true }).click();
  const link = await host.getByRole('textbox', { name: 'Ссылка приглашения' }).inputValue();
  await host.getByRole('button', { name: 'Закрыть', exact: true }).click();
  return link;
}

test('итоги игры приезжают обоим, остаются в истории и пустой стол объявляет свой срок', async ({
  browser,
}) => {
  test.setTimeout(240000);
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
    await start(host, 'Майс');
    const link = await invite(host);
    await guest.goto(link);
    await guest.getByLabel('Ваше имя').fill('Алекс');
    await guest.getByRole('button', { name: 'Войти во встречу' }).click();
    await expect(guest.getByText('В эфире', { exact: true })).toBeVisible({ timeout: 25000 });

    await host.getByRole('button', { name: 'Интеграции', exact: true }).click();
    await host.getByRole('button', { name: /Игры/ }).click();
    await host.getByRole('button', { name: /Покер/ }).click();

    // Стрелка выпадающего списка стоит по центру карточки, а не по центру её первой строки.
    const skew = await host.evaluate(() => {
      const head = document.querySelector('.games-head') as HTMLElement;
      const chevron = document.querySelector('.games-chevron') as HTMLElement;
      const a = head.getBoundingClientRect();
      const c = chevron.getBoundingClientRect();
      return { skew: Math.abs(a.top + a.height / 2 - (c.top + c.height / 2)), right: a.right - c.right };
    });
    expect(skew.skew).toBeLessThan(2);

    // Своя сумма фишек: поле принимает любое число, блайнды считаются от него.
    const stack = host.getByLabel('Стартовый стек, фишки');
    await stack.fill('300');
    await stack.press('Enter');
    await expect(host.locator('.games-stack-head small')).toContainText('блайнды');

    // Турнир: с таким стеком одна раздача решает игру целиком.
    await host.getByRole('button', { name: /^Турнир/ }).click();
    await stack.fill('300');
    await stack.press('Enter');
    await host.getByRole('button', { name: /Открыть стол/ }).click();
    await expect(host.locator('.poker-felt')).toBeVisible();

    await host.locator('.poker-seat.is-empty .poker-sit').first().click();
    await guest.locator('.poker-seat.is-empty .poker-sit').nth(3).click();
    await expect.poll(() => host.locator('.poker-seat:not(.is-empty)').count()).toBe(2);

    // Фишки стоят рядом с человеком и в банке.
    await expect(host.locator('.poker-seat[data-mine] .chip-columns i').first()).toBeVisible();

    // Комбинации открываются внутри сцены, а не уводят в панель справа.
    await host.locator('.poker-bar').getByRole('button', { name: 'Вид стола' }).click();
    await host.getByRole('menuitem', { name: /Комбинации/ }).click();
    await expect(host.locator('.poker-sheet')).toBeVisible();
    await expect(host.locator('.poker-sheet .hand-ranks li').first()).toContainText('Флеш-рояль');
    // Панель лежит внутри стола, а не в боковой панели встречи.
    expect(
      await host.evaluate(() => !!document.querySelector('.poker-felt-wrap > .poker-sheet')),
    ).toBeTruthy();
    await host.locator('.poker-sheet').getByRole('button', { name: 'Закрыть' }).click();
    await expect(host.locator('.poker-sheet')).toBeHidden();

    await host.locator('.games-group').getByRole('button', { name: 'Раздать', exact: true }).click();
    await expect(host.locator('.poker-mine-cards .playing-card')).toHaveCount(2);

    // Ва-банк с двух сторон: игра кончится этой же раздачей.
    for (let step = 0; step < 40; step++) {
      if (await host.locator('.poker[data-phase="over"], .poker[data-phase="showdown"]').count()) break;
      const acting: Page = (await host.locator('.poker-controls[data-turn]').count()) ? host : guest;
      const allin = acting.locator('.poker-action.is-allin');
      const raise = acting.locator('.poker-action.is-raise');
      const call = acting.locator('.poker-action.is-call, .poker-action.is-check').first();
      if (await allin.count()) await allin.click();
      else if (await raise.count()) {
        await raise.click();
        // Готовая ставка «Ва-банк» — последний шаг в списке; ползунок по умолчанию стоит на
        // минимальном повышении, и без этого нажатия раздача идёт по два фишки за круг.
        await acting.locator('.poker-step', { hasText: 'Ва-банк' }).click();
        await acting.locator('.poker-sizer-row .button.primary').click();
      } else if (await call.count()) await call.click();
      else await acting.waitForTimeout(250);
    }
    // Итоги игры открываются сами, как только игра кончилась.
    await expect(host.locator('.poker-sheet[data-wide]')).toBeVisible({ timeout: 30000 });
    await expect(host.locator('.poker-result-players li')).toHaveCount(2);
    await expect(host.locator('.poker-result-highlights li').first()).toBeVisible();
    await host.screenshot({ path: '../.local/poker-results.png' });
    // Итоги приехали и второму браузеру: их считает сервер, а не каждый сам.
    await expect(guest.locator('.poker-sheet[data-wide]')).toBeVisible({ timeout: 15000 });
    await guest.locator('.poker-sheet').getByRole('button', { name: 'Закрыть' }).click();

    // История игр в панели: та же таблица, но уже после стола.
    await host.locator('.poker-sheet').getByRole('button', { name: 'Закрыть' }).click();
    await expect(host.locator('.games-history')).toBeVisible({ timeout: 15000 });
    await host.locator('.games-history .games-head').first().click();
    await expect(host.locator('.games-history .poker-result-players li').first()).toBeVisible();

    // Пустой стол объявляет свой срок: оба встают, и отсчёт виден на сцене.
    await host
      .locator('.poker-idle')
      .getByRole('button', { name: /Встать из-за стола/ })
      .click();
    await guest
      .locator('.poker-idle')
      .getByRole('button', { name: /Встать из-за стола/ })
      .click();
    await expect(host.locator('.poker-linger')).toBeVisible({ timeout: 15000 });
    await expect(host.locator('.poker-linger')).toContainText('мин');
  } finally {
    await a.close();
    await b.close();
  }
});
