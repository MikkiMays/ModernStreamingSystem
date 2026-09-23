import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Стол дурака двумя настоящими браузерами.
 *
 * Проверяется не вёрстка, а пять вещей, которых нельзя увидеть в юнит-тестах: карты раздаются
 * обоим, **чужая рука не приезжает в браузер вовсе**, карта ходит перетаскиванием, партия
 * доигрывается до дурака через общий канал команд, а итог появляется в истории встречи.
 *
 * Для завершения партии достаточно двух правил: заход в пустой бой законен любой картой,
 * а «Беру» и «Бито» доступны отдельными кнопками. Подсказки выбранной карты не нужны этому
 * сценарию: их точность отдельно проверяется вместе с серверными правилами.
 * Защитник берёт всегда, нападающие пасуют — колода пустеет, у заходящего карты кончаются, и
 * дурак находится сам.
 */
async function dragTo(page: Page, source: Locator, target: Locator) {
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error('не за что взяться или некуда нести');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  // Первый сдвиг вверх — чтобы карта считалась поднятой, а не случайно задетой.
  await page.mouse.move(from.x + from.width / 2, from.y - 40, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
  await page.mouse.up();
}

test('two browsers play a hand of durak by dragging cards onto the table', async ({ browser }) => {
  test.setTimeout(360000);
  const a = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: { width: 1500, height: 950 },
  });
  const b = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: { width: 1400, height: 920 },
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

    await host.getByRole('button', { name: 'Интеграции', exact: true }).click();
    await host.getByRole('button', { name: /Игры/ }).click();
    await host.getByRole('button', { name: /Дурак/ }).click();
    await host.getByRole('button', { name: /Открыть стол/ }).click();
    await expect(host.locator('.durak-felt')).toBeVisible();
    await expect(guest.locator('.durak-felt')).toBeVisible({ timeout: 10000 });

    await host.locator('.durak').getByRole('button', { name: 'Сесть за стол', exact: true }).click();
    await guest.locator('.durak').getByRole('button', { name: 'Сесть за стол', exact: true }).click();
    await expect(host.locator('.durak-seat[data-mine]')).toBeVisible();
    await expect(guest.locator('.durak-seat[data-mine]')).toBeVisible();

    await host.locator('.games-group').getByRole('button', { name: 'Раздать', exact: true }).click();
    await expect(host.locator('.durak[data-phase="bout"]')).toBeVisible({ timeout: 10000 });
    await expect(host.locator('.durak-hand .durak-hand-card')).toHaveCount(6);
    await expect(guest.locator('.durak-hand .durak-hand-card')).toHaveCount(6);
    await expect(host.locator('.durak-trump .durak-card:not([data-back])')).toBeVisible();

    /*
      Чужой руки в браузере нет вовсе.

      У чужого места нет ни открытых карт, ни счётчика. Приватные карты доступны только владельцу.
    */
    await expect(host.locator('.durak-seat-count')).toHaveCount(0);
    await expect(host.locator('.durak-seat:not([data-mine]) .durak-card')).toHaveCount(0);

    // Рука остаётся читаемой: выделение цели появляется после выбора карты.
    await expect(host.locator('.durak-hand-card[data-legal]')).toHaveCount(0);

    // Автоматическая раздача не анимируется; движется только подтверждённый бросок.
    await expect(host.locator('.game-card-flight')).toHaveCount(0);

    /*
      Первый ход — перетаскиванием, и он обязан пройти с первой попытки: заход в пустой бой
      законен любой картой. Это и есть проверка самого механизма броска.
    */
    const first: Page = (await host.locator('.durak-turn[data-active]').count()) ? host : guest;
    await dragTo(first, first.locator('.durak-hand-card').first(), first.locator('.durak-mat'));
    await expect(first.locator('.durak-pair')).toHaveCount(1, { timeout: 10000 });
    await expect(first.locator('.durak-hand-card')).toHaveCount(5);
    // Карта на столе видна обоим — ход ушёл через общий канал, а не остался в одном браузере.
    const other = first === host ? guest : host;
    await expect(other.locator('.durak-pair .durak-attack .durak-card')).toBeVisible();

    /*
      Дальше партия доигрывается двумя кнопками и одним перетаскиванием на бой: защитник берёт,
      нападающий пасует, заходящий кладёт карту в пустой бой.
    */
    // Bound actual commands, not polls: each settled bout intentionally pauses for 1300 ms.
    // Counting idle scans used up the old 160-step budget with cards still in the attacker's hand.
    // Защитник здесь всегда берёт, и партия идёт около тридцати боёв по 1,3 с паузы каждый плюс
    // бросок: двух минут не хватало ни раннеру CI, ни нагруженной машине — партия обрывалась
    // посередине, и тест падал не на правилах, а на часах.
    const playUntil = Date.now() + 270000;
    let actions = 1; // The first attack above is already acknowledged.
    while (actions < 160 && Date.now() < playUntil) {
      if (await host.locator('.durak[data-phase="over"]').count()) break;
      let moved = false;
      for (const page of [host, guest] as Page[]) {
        if (await page.locator('.durak[data-phase="over"]').count()) break;
        const take = page.locator('.durak-actions').getByRole('button', { name: 'Беру', exact: true });
        if (await take.count()) {
          await take.click({ timeout: 10000 });
          // A click sends an asynchronous room command. Do not click the same old snapshot
          // again while its acknowledgement and authoritative snapshot are still in flight.
          await expect(take).toHaveCount(0, { timeout: 10000 });
          actions++;
          moved = true;
          continue;
        }
        const pass = page.locator('.durak-actions').getByRole('button', { name: 'Бито', exact: true });
        if (await pass.count()) {
          await pass.click({ timeout: 10000 });
          await expect(pass).toHaveCount(0, { timeout: 10000 });
          actions++;
          moved = true;
          continue;
        }
        const turn = await page.locator('.durak-turn[data-active]').count();
        const empty = (await page.locator('.durak-pair').count()) === 0;
        const card = page.locator('.durak-hand-card').first();
        if (turn && empty && (await card.count())) {
          await dragTo(page, card, page.locator('.durak-mat'));
          await expect(page.locator('.durak-pair')).toHaveCount(1, { timeout: 10000 });
          actions++;
          moved = true;
        }
      }
      if (!moved) {
        await expect
          .poll(
            async () => {
              for (const page of [host, guest]) {
                const ready = await page.locator('.durak').evaluate((table) => {
                  if (table.getAttribute('data-phase') === 'over') return true;
                  if (table.querySelector('.durak-actions .durak-act')) return true;
                  return !!(
                    table.querySelector('.durak-turn[data-active]') &&
                    !table.querySelector('.durak-pair') &&
                    table.querySelector('.durak-hand-card')
                  );
                });
                if (ready) return true;
              }
              return false;
            },
            {
              message: 'A settled bout must expose the next legal action or the game result',
              timeout: Math.max(1, Math.min(10000, playUntil - Date.now())),
            },
          )
          .toBe(true);
      }
    }

    await expect(host.locator('.durak[data-phase="over"]')).toBeVisible({ timeout: 30000 });
    await expect(host.locator('.durak-over h3')).toContainText(/дурак|Ничья/);
    await expect(guest.locator('.durak-over h3')).toContainText(/дурак|Ничья/);

    // Счёт вечера появился на столе, как только партия кончилась.
    await host.getByRole('button', { name: 'К столу' }).click();
    await host.getByRole('button', { name: 'Счёт игры', exact: true }).click();
    await expect(host.locator('.durak-score-table')).toBeVisible();
    await host
      .getByRole('dialog', { name: 'Счёт игры' })
      .getByRole('button', { name: 'Закрыть', exact: true })
      .click();

    // Итог партии уехал в историю беседы вместе со счётом.
    await host.getByRole('button', { name: 'История игр', exact: true }).click();
    await expect(host.locator('.games-history').filter({ hasText: 'Дурак' })).toBeVisible({
      timeout: 15000,
    });

    await host
      .getByRole('dialog', { name: 'История игр' })
      .getByRole('button', { name: 'Закрыть', exact: true })
      .click();
    await host.getByRole('button', { name: 'Настройки игры' }).click();
    await expect(host.getByRole('button', { name: /Проверить раздачу/ })).toHaveCount(0);
    await host.screenshot({ path: '../.local/durak-over.png' });
  } finally {
    await a.close();
    await b.close();
  }
});
