import { expect, test } from '@playwright/test';
import { startMeeting } from './support/cinema';

/*
  Экран звонка (E04): смена камеры на телефоне без списка (T21), поле чата на линии кнопок и отказ
  в слишком большом файле в момент выбора (T02), обводка говорящего от своего замера (T23).
*/

test('on a phone «Сменить камеру» switches at once and opens no list', async ({ browser }) => {
  const context = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  try {
    await startMeeting(page);
    await page.getByRole('button', { name: 'Включить камеру', exact: true }).tap();
    await expect(page.getByRole('button', { name: 'Выключить камеру', exact: true })).toBeVisible();
    const flip = page.getByRole('button', { name: 'Сменить камеру', exact: true });
    await flip.tap();
    // Списка нет вовсе: ни сразу, ни после удержания, как было раньше.
    await expect(page.getByRole('menu')).toHaveCount(0);
    await page.waitForTimeout(700);
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Выключить камеру', exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

test('the composer grows with the text, keeps «Отправить» on its last line and sends several lines', async ({
  browser,
}) => {
  const context = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  try {
    await startMeeting(page);
    await page.getByRole('button', { name: 'Чат', exact: true }).click();
    const box = page.getByRole('textbox', { name: 'Сообщение', exact: true });
    const send = page.getByRole('button', { name: 'Отправить сообщение' });
    const attach = page.getByRole('button', { name: 'Прикрепить файл' });
    // Подписи предела под полем больше нет (T02).
    await expect(page.getByText(/до 100 МиБ/)).toHaveCount(0);
    const line = async () => {
      const [field, button, clip] = await Promise.all([
        box.boundingBox(),
        send.boundingBox(),
        attach.boundingBox(),
      ]);
      return {
        height: Math.round(field!.height),
        send: Math.round(field!.y + field!.height - (button!.y + button!.height)),
        attach: Math.round(field!.y + field!.height - (clip!.y + clip!.height)),
      };
    };
    const single = await line();
    // Одна строка — кнопки вровень с полем.
    expect(single.send).toBe(0);
    expect(single.attach).toBe(0);
    await box.fill('Первая строка\nвторая\nтретья');
    const three = await line();
    expect(three.height).toBeGreaterThan(single.height);
    // Поле выросло вверх, а кнопки остались на линии его последней строки.
    expect(three.send).toBe(0);
    expect(three.attach).toBe(0);
    await box.fill(Array.from({ length: 12 }, (_, i) => `строка ${i + 1}`).join('\n'));
    const capped = await line();
    expect(capped.height).toBeLessThanOrEqual(single.height * 4);
    await box.fill('Первая строка\nвторая');
    await send.click();
    await expect(page.locator('.message.own p')).toHaveText(/Первая строка\s+вторая/);
    await expect(box).toHaveValue('');
  } finally {
    await context.close();
  }
});

test('a file over the limit is refused with words when it is chosen, and nothing uploads', async ({
  browser,
}) => {
  const context = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  // Предел — тот, что назвал сервер: здесь он 1 КиБ, чтобы не гонять в тесте сотню мебибайт.
  await page.route('**/api/v1/capabilities', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), fileMaxBytes: 1024 } });
  });
  try {
    await startMeeting(page);
    await page.getByRole('button', { name: 'Чат', exact: true }).click();
    let reserved = false;
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/attachments/.test(request.url())) reserved = true;
    });
    await page.locator('.chat-panel input[type="file"]').setInputFiles({
      name: 'отчёт.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.alloc(3 * 1024, 1),
    });
    await expect(page.locator('.composer-refusal')).toHaveText(
      '«отчёт.pdf» — 3 КиБ. Во встречу можно отправить файл до 1 КиБ.',
    );
    expect(reserved).toBe(false);
  } finally {
    await context.close();
  }
});

/*
  Обводка говорящего — от своего замера (`media/levels.ts`), без SFU. Тон поддельного микрофона
  Chromium шумоподавление вырезает, поэтому обработка звука здесь выключена в настройках.
*/
test('my own tile lights up from my microphone without waiting for the SFU', async ({ browser }) => {
  const context = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: { width: 1280, height: 800 },
  });
  await context.addInitScript(() => {
    const key = 'cord:preferences:v1';
    const current = JSON.parse(localStorage.getItem(key) ?? '{}');
    localStorage.setItem(
      key,
      JSON.stringify({
        ...current,
        audio: { suppression: 'off', echoCancellation: false, autoGainControl: false, gain: 1 },
      }),
    );
  });
  const page = await context.newPage();
  try {
    await startMeeting(page);
    await page.getByRole('button', { name: 'Включить микрофон', exact: true }).click();
    const ring = page.locator('.person-tile .person-voice[data-voice]');
    await expect(ring.first()).toBeAttached({ timeout: 15000 });
    expect(Number(await ring.first().getAttribute('data-voice'))).toBeGreaterThanOrEqual(1);
  } finally {
    await context.close();
  }
});
