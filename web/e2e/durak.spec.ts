import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Стол дурака двумя настоящими браузерами.
 *
 * Проверяется не вёрстка, а пять вещей, которых нельзя увидеть в юнит-тестах: карты раздаются
 * обоим, **чужая рука не приезжает в браузер вовсе**, карта ходит перетаскиванием, партия
 * доигрывается до дурака через общий канал команд, а итог появляется в истории встречи.
 *
 * ПОЧЕМУ ПАРТИЯ ИГРАЕТСЯ ИМЕННО ТАК. Подсказок в интерфейсе больше нет — значит, и тест не знает,
 * какая карта законна, ровно как человек. Зато он знает два правила, которых достаточно, чтобы
 * партия кончилась: заход в пустой бой законен любой картой, а «Беру» и «Бито» есть кнопками.
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
  test.setTimeout(200000);
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

    await host.locator('.game-seat-action').first().click();
    await guest.locator('.game-seat-action').first().click();
    await expect(host.locator('.durak-seat[data-mine]')).toBeVisible();
    await expect(guest.locator('.durak-seat[data-mine]')).toBeVisible();

    await host.locator('.games-group').getByRole('button', { name: 'Раздать', exact: true }).click();
    await expect(host.locator('.durak[data-phase="bout"]')).toBeVisible({ timeout: 10000 });
    await expect(host.locator('.durak-hand .durak-hand-card')).toHaveCount(6);
    await expect(guest.locator('.durak-hand .durak-hand-card')).toHaveCount(6);
    await expect(host.locator('.durak-trump .durak-card:not([data-back])')).toBeVisible();

    /*
      Чужой руки в браузере нет вовсе.

      У чужого места не рубашки, а число карт: единственное, что о ней известно. Открытых карт на
      чужом месте ноль — если бы снимок собирался общий на всю комнату, их было бы шесть.
    */
    await expect(host.locator('.durak-seat:not([data-mine]) .durak-seat-count')).toHaveText('6');
    await expect(host.locator('.durak-seat:not([data-mine]) .durak-card')).toHaveCount(0);

    // Подсказок нет: ни одна карта в руке не помечена законной или незаконной.
    await expect(host.locator('.durak-hand-card[data-legal]')).toHaveCount(0);

    /*
      Дождаться, пока карты долетят.

      Раздача — это полторы секунды полёта от колоды, и всё это время карта едет: координаты,
      взятые до прилёта, к моменту нажатия уже не те. Человек столкнётся с этим разве что нарочно,
      а тест — каждый раз, потому что он быстрее человека.
    */
    await expect(host.locator('.game-card-flight')).toHaveCount(0, { timeout: 10000 });

    /*
      Первый ход — перетаскиванием, и он обязан пройти с первой попытки: заход в пустой бой
      законен любой картой. Это и есть проверка самого механизма броска.
    */
    const first: Page = (await host.locator('.durak-controls[data-turn]').count()) ? host : guest;
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
    for (let step = 0; step < 160; step++) {
      if (await host.locator('.durak[data-phase="over"]').count()) break;
      let moved = false;
      for (const page of [host, guest] as Page[]) {
        if (await page.locator('.durak[data-phase="over"]').count()) break;
        const take = page.locator('.durak-act[data-kind="take"]');
        if (await take.count()) {
          await take.click({ timeout: 10000 });
          // A click sends an asynchronous room command. Do not click the same old snapshot
          // again while its acknowledgement and authoritative snapshot are still in flight.
          await expect(take).toHaveCount(0, { timeout: 10000 });
          moved = true;
          continue;
        }
        const pass = page.locator('.durak-act[data-kind="pass"]');
        if (await pass.count()) {
          await pass.click({ timeout: 10000 });
          await expect(pass).toHaveCount(0, { timeout: 10000 });
          moved = true;
          continue;
        }
        const turn = await page.locator('.durak-controls[data-turn]').count();
        const empty = (await page.locator('.durak-pair').count()) === 0;
        const card = page.locator('.durak-hand-card').first();
        if (turn && empty && (await card.count())) {
          await dragTo(page, card, page.locator('.durak-mat'));
          await expect(page.locator('.durak-pair')).toHaveCount(1, { timeout: 10000 });
          moved = true;
        }
      }
      if (!moved) await host.waitForTimeout(400);
    }

    await expect(host.locator('.durak[data-phase="over"]')).toBeVisible({ timeout: 30000 });
    await expect(host.locator('.durak-over b')).toContainText(/дурак|Ничья/);
    await expect(guest.locator('.durak-over b')).toContainText(/дурак|Ничья/);

    // Счёт вечера появился на столе, как только партия кончилась.
    await host.getByRole('button', { name: 'К столу' }).click();
    await expect(host.locator('.durak-score')).toBeVisible();

    // Итог партии уехал в историю беседы вместе со счётом.
    await host.getByRole('button', { name: 'История игр', exact: true }).click();
    await expect(host.locator('.games-history').filter({ hasText: 'Дурак' })).toBeVisible({
      timeout: 15000,
    });

    await host
      .getByRole('dialog', { name: 'История игр' })
      .getByRole('button', { name: 'Закрыть', exact: true })
      .click();
    await host.getByRole('button', { name: 'Настройки стола' }).click();
    await expect(host.getByRole('button', { name: /Проверить раздачу/ })).toHaveCount(0);
    await host.screenshot({ path: '../.local/durak-over.png' });
  } finally {
    await a.close();
    await b.close();
  }
});
