import { expect, test, type Page } from '@playwright/test';
import { routeCinema, startMeeting } from './support/cinema';

/*
  Пульт звонка — три отдельные группы (T22): слева микрофон, камера и экран, в центре «ещё» и
  «выйти», справа чат, участники и интеграции. На телефоне — две группы одной строкой от 320 px.

  Здесь же прежняя жалоба: на 768 px «Интеграции» уходила за край сцены, а нажатие по ней
  прокручивало сцену ради фокуса — у каталога и плиток срезался левый край. Прокручивать сцене по-
  прежнему нечего ни на одной ширине.
*/

/** Подписи групп пульта и сколько кнопок в каждой, слева направо. */
async function groups(page: Page) {
  return page.locator('.call-dock > [role="group"]').evaluateAll((list) =>
    list.map((group) => ({
      name: group.getAttribute('aria-label'),
      buttons: group.querySelectorAll('button').length,
    })),
  );
}

/** Сколько разных строк занимают кнопки пульта и насколько что-нибудь торчит за край. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const footer = document.querySelector<HTMLElement>('.call-footer')!;
    const stage = document.querySelector<HTMLElement>('.stage-wrap')!;
    const buttons = [...document.querySelectorAll<HTMLElement>('.call-dock button')].filter(
      (button) => button.getBoundingClientRect().width > 0,
    );
    const rows = new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().top)));
    const right = Math.max(...buttons.map((button) => button.getBoundingClientRect().right));
    return {
      rows: rows.size,
      outside: right > stage.getBoundingClientRect().right + 0.5,
      footer: footer.scrollWidth - footer.clientWidth,
      stage: stage.scrollWidth - stage.clientWidth,
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      scrolled: stage.scrollLeft,
    };
  });
}

test('three groups on a desktop, nothing overflows, and «Интеграции» does not scroll the stage', async ({
  browser,
}) => {
  const room = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: { width: 1440, height: 900 },
  });
  const page = await room.newPage();
  // Каталог служб — из записи: панель интеграций без службы иначе показывает отказ.
  await routeCinema(page);
  const integrations = page.getByRole('button', { name: 'Интеграции', exact: true });
  try {
    await startMeeting(page);
    expect(await groups(page)).toEqual([
      { name: 'Звук встречи', buttons: 1 },
      { name: 'Микрофон и камера', buttons: 3 },
      { name: 'Встреча', buttons: 2 },
      { name: 'Чат и интеграции', buttons: 3 },
    ]);
    // Стрелки выбора камеры справа от её кнопки больше нет (T21): выбор — в «ещё».
    await expect(page.getByRole('button', { name: 'Выбрать камеру' })).toHaveCount(0);
    for (const width of [768, 800, 900, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await integrations.click();
      await expect(page.locator('.services-panel')).toBeVisible();
      expect(await measure(page), `${width}px, «Интеграции» нажата`).toMatchObject({
        rows: 1,
        outside: false,
        footer: 0,
        stage: 0,
        page: 0,
        scrolled: 0,
      });
      await integrations.click();
      await expect(page.locator('.side-panel')).toHaveCount(0);
    }
    for (const width of [701, 768, 1024, 1199, 1440, 2560]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await measure(page), `пульт на ${width}px`).toMatchObject({
        rows: 1,
        outside: false,
        footer: 0,
        stage: 0,
        page: 0,
      });
    }
  } finally {
    await room.close();
  }
});

test('a phone: «звук встречи» alone at 390, in the mic group below 375, flip in «ещё» below 360 (R156)', async ({
  browser,
}) => {
  const context = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  try {
    await startMeeting(page);
    // «Звук встречи» — своя одинокая плашка слева от микрофона (R156).
    expect(await groups(page)).toEqual([
      { name: 'Звук встречи', buttons: 1 },
      { name: 'Микрофон и камера', buttons: 3 },
      { name: 'Встреча', buttons: 2 },
    ]);
    // Третья слева на касании — смена камеры, а не показ экрана.
    await expect(page.getByRole('button', { name: 'Сменить камеру', exact: true })).toBeVisible();
    await page.setViewportSize({ width: 360, height: 844 });
    // Раскладка пульта меняется по media query — после перерисовки, а не в ту же миллисекунду.
    await expect
      .poll(() => groups(page))
      .toEqual([
        { name: 'Микрофон и камера', buttons: 4 },
        { name: 'Встреча', buttons: 2 },
      ]);
    await page.setViewportSize({ width: 320, height: 844 });
    await expect
      .poll(() => groups(page))
      .toEqual([
        { name: 'Микрофон и камера', buttons: 3 },
        { name: 'Встреча', buttons: 2 },
      ]);
    await page.setViewportSize({ width: 390, height: 844 });
    for (const width of [320, 360, 390, 430, 700]) {
      await page.setViewportSize({ width, height: 844 });
      // Где стоит «звук встречи», решает media query в React (R156) — замер после перерисовки.
      await expect
        .poll(() => measure(page), { message: `телефон ${width}px` })
        .toMatchObject({ rows: 1, outside: false, stage: 0, page: 0 });
    }
    await page.getByRole('button', { name: 'Настройки и действия' }).click();
    for (const item of ['Чат и файлы', 'Участники', 'Интеграции', 'Показать экран', 'Полноэкранный режим'])
      await expect(page.getByRole('menuitem', { name: item })).toBeVisible();
  } finally {
    await context.close();
  }
});
