import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('home and prejoin are responsive and keyboard accessible', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('main').getByRole('textbox', { name: 'Код встречи или ссылка' })).toBeVisible();
  await page.screenshot({ path: '../.local/home-desktop.png', fullPage: true });
  const accessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await page.getByRole('button', { name: /Новая встреча/ }).click();
  await expect(page.getByLabel('Ваше имя')).toBeFocused();
  // Да или нет — переключателем, а не галочкой (X4, R55); встреча не создаётся.
  await expect(page.getByRole('switch', { name: /Разрешить интеграции всем участникам/ })).toBeChecked();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await page.screenshot({ path: '../.local/prejoin-desktop.png', fullPage: true });
});

/*
  Предвход в любом окне (R73, R76): от 320 до 2560 по ширине, от 480 по высоте — без горизонтальной
  прокрутки, кнопка входа видна целиком, превью и форма начинаются с одной линии, а при изменении
  окна раскладка меняется плавно — без скачков, кроме одного перехода с двух колонок на одну.
  Встреча не создаётся.
*/
type PrejoinBox = { overflowX: number; preview: DOMRect; form: DOMRect; twoColumns: boolean };
async function prejoinLayout(page: Page): Promise<PrejoinBox> {
  return page.evaluate(() => {
    const preview = document.querySelector('.preview-stage')!.getBoundingClientRect();
    const form = document.querySelector('.prejoin-form')!.getBoundingClientRect();
    return {
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      preview: preview.toJSON() as DOMRect,
      form: form.toJSON() as DOMRect,
      twoColumns: preview.right <= form.left,
    };
  });
}

test('предвход помещается в любое окно и не прыгает при изменении размера (R73, R76)', async ({ page }) => {
  test.setTimeout(120000);
  await page.goto('/');
  await page.getByRole('button', { name: /Новая встреча/ }).click();
  await expect(page.getByLabel('Ваше имя')).toBeFocused();
  const start = page.getByRole('button', { name: 'Начать встречу', exact: true });
  const sizes = [
    ...[320, 390, 768, 1024, 1280, 1366, 1440, 1920, 2560].flatMap((width) =>
      [480, 600, 714, 720, 900].map((height) => ({ width, height })),
    ),
    { width: 2560, height: 1440 },
  ];
  for (const size of sizes) {
    await page.setViewportSize(size);
    const box = await prejoinLayout(page);
    const at = `${size.width}×${size.height}`;
    expect(box.overflowX, `${at}: шире окна`).toBeLessThanOrEqual(0);
    await expect(start, `${at}: кнопка входа`).toBeInViewport({ ratio: 1 });
    // Две колонки — с 768 px: обе с одной линии; превью целиком в окне по высоте.
    if (size.width >= 768) {
      expect(box.twoColumns, `${at}: две колонки`).toBe(true);
      expect(Math.abs(box.preview.top - box.form.top), `${at}: верх превью и формы`).toBeLessThanOrEqual(8);
      expect(box.preview.bottom, `${at}: превью по высоте`).toBeLessThanOrEqual(size.height);
    } else expect(box.twoColumns, `${at}: одна колонка`).toBe(false);
  }
  // Плавно: окно меняется на 10 px — раскладка сдвигается не больше чем на 2,5 шага (превью 16:10 по
  // высоте — 1,6 шага, центровка — полшага). Скачок — только на переходе между колонками.
  const sweep = async (steps: { width: number; height: number }[]) => {
    let last: PrejoinBox | null = null;
    for (const size of steps) {
      await page.setViewportSize(size);
      const box = await prejoinLayout(page);
      if (last && last.twoColumns === box.twoColumns)
        for (const [name, a, b] of [
          ['ширина превью', last.preview.width, box.preview.width],
          ['левый край превью', last.preview.left, box.preview.left],
          ['верх превью', last.preview.top, box.preview.top],
          ['левый край формы', last.form.left, box.form.left],
          ['верх формы', last.form.top, box.form.top],
        ] as const)
          expect(Math.abs(b - a), `${size.width}×${size.height}: ${name}`).toBeLessThanOrEqual(25);
      last = box;
    }
  };
  const range = (from: number, to: number) =>
    Array.from({ length: Math.floor((to - from) / 10) + 1 }, (_, i) => from + i * 10);
  await sweep(range(320, 2560).map((width) => ({ width, height: 714 })));
  await sweep(range(480, 1440).map((height) => ({ width: 1280, height })));
  await sweep(range(480, 1000).map((height) => ({ width: 390, height })));
});

test('two real browser contexts exchange camera, audio and messages through LiveKit', async ({ browser }) => {
  const a = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: { width: 1440, height: 960 },
  });
  const b = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: { width: 1280, height: 900 },
  });
  const host = await a.newPage();
  const guest = await b.newPage();
  try {
    await host.goto('/');
    await host.getByRole('button', { name: /Новая встреча/ }).click();
    await host.getByLabel('Ваше имя').fill('Майс');
    await host.getByRole('button', { name: 'Начать встречу' }).click();
    await expect(host.locator('[data-media-status="connected"]')).toBeVisible({ timeout: 20000 });
    await host.getByRole('button', { name: 'Пригласить участников', exact: true }).click();
    const invitation = await host.getByRole('textbox', { name: 'Ссылка приглашения' }).inputValue();
    await host.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await guest.goto(invitation);
    await guest.getByLabel('Ваше имя').fill('Алекс');
    await guest.getByRole('button', { name: 'Войти во встречу' }).click();
    await expect(guest.locator('[data-media-status="connected"]')).toBeVisible({ timeout: 20000 });
    await host.getByRole('button', { name: 'Включить камеру', exact: true }).click();
    await host.getByRole('button', { name: 'Включить микрофон', exact: true }).click();
    await expect(guest.locator('video[aria-label="Камера: Майс"]')).toBeVisible();
    await expect
      .poll(() =>
        guest.locator('video[aria-label="Камера: Майс"]').evaluate((v: HTMLVideoElement) => v.videoWidth),
      )
      .toBeGreaterThan(0);
    await expect.poll(() => guest.locator('audio').count()).toBeGreaterThan(0);
    await guest.locator('.person-tile').filter({ hasText: 'Майс' }).click({ button: 'right' });
    const volume = guest.getByRole('slider', { name: 'Громкость: Майс' });
    await volume.fill('150');
    await guest.getByRole('menuitem', { name: 'Отключить звук у меня', exact: true }).click();
    await expect(host.getByRole('button', { name: 'Выключить микрофон', exact: true })).toBeVisible();
    await guest.locator('.person-tile').filter({ hasText: 'Майс' }).click({ button: 'right' });
    await expect(volume).toHaveValue('0');
    await guest.getByRole('menuitem', { name: 'Восстановить громкость', exact: true }).click();
    await guest.locator('.person-tile').filter({ hasText: 'Майс' }).click({ button: 'right' });
    await expect(volume).toHaveValue('150');
    await guest.keyboard.press('Escape');
    await guest.getByRole('button', { name: 'Включить микрофон', exact: true }).click();
    await host.locator('.person-tile').filter({ hasText: 'Алекс' }).click({ button: 'right' });
    await host.getByRole('menuitem', { name: 'Выключить микрофон для всех', exact: true }).click();
    await expect(guest.getByRole('button', { name: 'Включить микрофон', exact: true })).toBeVisible();
    await guest.getByRole('button', { name: 'Включить микрофон', exact: true }).click();
    await expect(guest.getByRole('button', { name: 'Выключить микрофон', exact: true })).toBeVisible();
    await host.getByRole('button', { name: 'Чат', exact: true }).click();
    await guest.getByRole('button', { name: 'Чат', exact: true }).click();
    await host.getByRole('textbox', { name: 'Сообщение', exact: true }).fill('Привет! Связь работает.');
    await host.getByRole('button', { name: 'Отправить сообщение' }).click();
    await expect(guest.getByText('Привет! Связь работает.', { exact: true })).toBeVisible();
    await host.locator('input[type=file]').setInputFiles({
      name: 'meeting-notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('A document shared during the call.'),
    });
    await expect(host.getByRole('button', { name: 'Скачать meeting-notes.txt' })).toBeVisible({
      timeout: 15000,
    });
    await expect(guest.getByRole('button', { name: 'Скачать meeting-notes.txt' })).toBeVisible({
      timeout: 10000,
    });
    await host.screenshot({ path: '../.local/room-desktop.png' });
    await guest.setViewportSize({ width: 390, height: 844 });
    await guest.getByRole('textbox', { name: 'Сообщение', exact: true }).fill('Ответ с узкого экрана');
    await guest.getByRole('button', { name: 'Отправить сообщение' }).click();
    await expect(host.getByText('Ответ с узкого экрана', { exact: true })).toBeVisible();
    await guest.screenshot({ path: '../.local/room-mobile.png' });
    expect(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await host.getByRole('button', { name: 'Настройки и действия' }).click();
    await host.getByRole('menuitem', { name: 'Завершить для всех' }).click();
    await expect(host.getByRole('heading', { name: 'Встреча завершена' })).toBeVisible();
    await expect(guest.getByRole('heading', { name: 'Встреча завершена' })).toBeVisible();
  } finally {
    await a.close();
    await b.close();
  }
});

/**
 * Встреча на телефоне: пульт одной строкой и ничем не закрытый.
 *
 * Жалоба была «панелька, где микрофон и камера, ходит, неровно». Кнопки с зазорами не влезали
 * в ширину телефона на несколько пикселей, «завершить» уезжала на вторую строку, и высота
 * пульта менялась от того, что в нём сейчас лежит: включённая камера добавляет рядом выбор
 * линзы. Эту высоту знали трое и каждый по-своему — сцена, лист панели и сам пульт.
 *
 * Проверяется то, что видно: все кнопки на одной линии, пульт не залезает на плитку с людьми,
 * а открытая панель не накрывает его собой.
 */
test('the call dock stays one row on a phone and nothing covers it', async ({ browser }) => {
  const context = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  try {
    await page.goto('/');
    await page.getByRole('button', { name: /Новая встреча/ }).click();
    await page.getByLabel('Ваше имя').fill('Тест');
    await page.getByRole('button', { name: 'Начать встречу' }).click();
    await expect(page.locator('[data-media-status="connected"]')).toBeVisible({ timeout: 20000 });

    const rows = async () =>
      page.evaluate(
        () =>
          [
            ...new Set(
              [...document.querySelectorAll('.call-dock button')]
                .filter((b) => b.getBoundingClientRect().width > 0)
                .map((b) => Math.round(b.getBoundingClientRect().top)),
            ),
          ].length,
      );
    expect(await rows()).toBe(1);
    // Камера добавляет в пульт ещё кнопку — строка от этого не удваивается.
    await page.getByRole('button', { name: 'Включить камеру', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Выключить камеру', exact: true })).toBeVisible();
    expect(await rows()).toBe(1);

    // Панель открывается листом снизу и останавливается над пультом, а не поверх него.
    await page.getByRole('button', { name: 'Настройки и действия' }).click();
    await page.getByRole('menuitem', { name: 'Чат и файлы' }).click();
    const gap = await page.evaluate(() => {
      const panel = document.querySelector('.side-panel')?.getBoundingClientRect();
      const dock = document.querySelector('.call-footer')?.getBoundingClientRect();
      return panel && dock ? Math.round(dock.top - panel.bottom) : null;
    });
    expect(gap).not.toBeNull();
    expect(gap).toBeGreaterThanOrEqual(0);
    await page.screenshot({ path: '../.local/meeting-phone.png' });
  } finally {
    await context.close();
  }
});
