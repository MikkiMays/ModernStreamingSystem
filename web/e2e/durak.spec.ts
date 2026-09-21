import { expect, test, type Page } from '@playwright/test';

/**
 * Стол дурака двумя настоящими браузерами.
 *
 * Проверяется не вёрстка, а четыре вещи, которых нельзя увидеть в юнит-тестах: карты
 * раздаются обоим, **чужая рука не приезжает в браузер вовсе**, партия доигрывается до дурака
 * через общий канал команд, и браузер сам пересобирает колоду из раскрытого зерна.
 *
 * ПОЧЕМУ ХОД ВЫБИРАЕТСЯ ПО КНОПКАМ, А НЕ ПО ПРАВИЛАМ. Здесь нет и не должно быть второй
 * реализации правил: что законно, решил сервер и прислал в снимке. Тест делает ровно то, что
 * делает человек, — нажимает на карту, которая поднялась.
 */
test('two browsers play a hand of durak with private hands and a verifiable deal', async ({ browser }) => {
  test.setTimeout(180000);
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
    await expect(host.getByRole('button', { name: /Новая встреча/ })).toBeVisible({ timeout: 25000 });
    await host.getByRole('button', { name: /Новая встреча/ }).click();
    await host.getByLabel('Ваше имя').fill('Майс');
    await host.getByRole('button', { name: 'Начать встречу' }).click();
    await expect(host.getByText('В эфире', { exact: true })).toBeVisible({ timeout: 40000 });
    await host.getByRole('button', { name: 'Пригласить участников', exact: true }).click();
    const invitation = await host.getByRole('textbox', { name: 'Ссылка приглашения' }).inputValue();
    await host.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await guest.goto(invitation);
    await guest.getByLabel('Ваше имя').fill('Алекс');
    await guest.getByRole('button', { name: 'Войти во встречу' }).click();
    await expect(guest.getByText('В эфире', { exact: true })).toBeVisible({ timeout: 40000 });

    // Игр в группе больше одной, поэтому сначала раскрывается строка нужной.
    await host.getByRole('button', { name: 'Интеграции', exact: true }).click();
    await host.getByRole('button', { name: /Игры/ }).click();
    await host.getByRole('button', { name: /Дурак/ }).click();
    await host.getByRole('button', { name: /Открыть стол/ }).click();
    await expect(host.locator('.durak-felt')).toBeVisible();
    await expect(guest.locator('.durak-felt')).toBeVisible({ timeout: 10000 });

    // Козырь под колодой — главный ориентир стола — виден ещё до раздачи? Нет: он появляется
    // вместе с ней. А вот сесть можно сразу.
    await host.locator('.durak-seat.is-empty .durak-sit').first().click();
    await guest.locator('.durak-seat.is-empty .durak-sit').nth(1).click();
    await expect(host.locator('.durak-seat[data-mine]')).toBeVisible();
    await expect(guest.locator('.durak-seat[data-mine]')).toBeVisible();

    await host.locator('.games-group').getByRole('button', { name: 'Раздать', exact: true }).click();
    await expect(host.locator('.durak[data-phase="bout"]')).toBeVisible({ timeout: 10000 });
    await expect(host.locator('.durak-hand .durak-hand-card')).toHaveCount(6);
    await expect(guest.locator('.durak-hand .durak-hand-card')).toHaveCount(6);
    // Козырь лежит под колодой лицом вверх — его видно обоим.
    await expect(host.locator('.durak-trump .durak-card:not([data-back])')).toBeVisible();

    /*
      Чужая рука закрыта, и это главное.

      У соседнего места видны только рубашки: открытых карт там ровно ноль. Если бы снимок
      собирался общий на всю комнату, здесь было бы шесть.
    */
    await expect(host.locator('.durak-seat:not([data-mine]) .durak-card[data-back]')).toHaveCount(6);
    await expect(host.locator('.durak-seat:not([data-mine]) .durak-card:not([data-back])')).toHaveCount(0);

    /*
      Доигрываем партию: ходит тот, у кого поднялась карта или появилась кнопка.

      Порядок попыток — тот же, в каком за столом и думают: положить карту, сказать «бито»,
      взять. Правил здесь нет: поднятая карта — это ответ сервера.
    */
    for (let step = 0; step < 220; step++) {
      if (await host.locator('.durak[data-phase="over"]').count()) break;
      let moved = false;
      for (const page of [host, guest] as Page[]) {
        if (await page.locator('.durak[data-phase="over"]').count()) break;
        const card = page.locator('.durak-hand-card[data-legal="true"]').first();
        if (await card.count()) {
          await card.click();
          // Карта могла подняться, ожидая цели: тогда цель — обведённая карта на столе.
          const target = page.locator('.durak-pair[data-target="true"] .durak-attack').first();
          if (await target.count()) await target.click();
          moved = true;
          continue;
        }
        const pass = page.locator('.durak-act[data-kind="pass"]');
        if (await pass.count()) {
          await pass.click();
          moved = true;
          continue;
        }
        const take = page.locator('.durak-act[data-kind="take"]');
        if (await take.count()) {
          await take.click();
          moved = true;
        }
      }
      if (!moved) await host.waitForTimeout(300);
    }

    await expect(host.locator('.durak[data-phase="over"]')).toBeVisible({ timeout: 30000 });
    // Итог открывается сам, и в нём названо то единственное, ради чего играли.
    await expect(host.locator('.durak-over b')).toContainText(/дурак|Ничья/);
    await expect(guest.locator('.durak-over b')).toContainText(/дурак|Ничья/);

    // Раздача проверяема: браузер пересобирает колоду из зерна и сверяет с отпечатком.
    await host.getByRole('button', { name: 'К столу' }).click();
    await host.getByRole('button', { name: 'Настройки стола' }).click();
    await host.getByRole('button', { name: /Проверить/ }).click();
    await expect(host.locator('.durak-sheet-body')).toContainText('сошлась с обещанной', {
      timeout: 10000,
    });
    await host.screenshot({ path: '../.local/durak-over.png' });
  } finally {
    await a.close();
    await b.close();
  }
});
