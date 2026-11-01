import { expect, test, type Page } from '@playwright/test';

/**
 * Микрофон и «звук встречи» (R160, R161, Р-54) — только против стенда с SFU.
 *
 * R160: «включается очень долго, странные звуки, на каждое включение просит разрешение». Захват —
 * один на встречу: включить/выключить — mute/unmute той же дорожки, шумодав «Усиленное» (умолчание ПК,
 * R145) не пересобирается, одно переключение — один сигнал. Счёт — перехватом до кода страницы:
 * `getUserMedia`, `addModule` ворклета, `replaceTrack` отправителя, ноты сигналов (`OscillatorNode`).
 *
 * R161: выключенный звук встречи не переживает повторного входа — встреча начинается со звуком, с
 * выключенными микрофоном и камерой.
 */
test.skip(!process.env.PLAYWRIGHT_BASE_URL, 'нужен стенд с SFU: PLAYWRIGHT_BASE_URL=https://…');

const count = () => {
  if (typeof MediaDevices === 'undefined' || !window.isSecureContext) return;
  const seen = {
    gum: 0,
    modules: 0,
    replaced: 0,
    notes: [] as number[],
    clicks: [] as number[],
    flips: [] as number[],
  };
  (window as unknown as { __mic: typeof seen }).__mic = seen;
  const gum = MediaDevices.prototype.getUserMedia;
  MediaDevices.prototype.getUserMedia = function (constraints?: MediaStreamConstraints) {
    if (constraints?.audio) seen.gum++;
    return gum.call(this, constraints);
  };
  const add = AudioWorklet.prototype.addModule;
  AudioWorklet.prototype.addModule = function (url: string | URL, options?: WorkletOptions) {
    if (String(url).includes('rnnoise')) seen.modules++;
    return add.call(this, url, options);
  };
  const replace = RTCRtpSender.prototype.replaceTrack;
  RTCRtpSender.prototype.replaceTrack = function (track: MediaStreamTrack | null) {
    if (track?.kind === 'audio') seen.replaced++;
    return replace.call(this, track);
  };
  const start = OscillatorNode.prototype.start;
  OscillatorNode.prototype.start = function (when?: number) {
    seen.notes.push(performance.now());
    return start.call(this, when);
  };
  // Нажатие на микрофон и смена его надписи — временем страницы, без круга до Playwright.
  document.addEventListener(
    'click',
    (event) => {
      const button = (event.target as Element).closest?.('button');
      if (/микрофон/.test(button?.getAttribute('aria-label') ?? '')) seen.clicks.push(performance.now());
    },
    true,
  );
  const watch = () =>
    new MutationObserver((records) => {
      for (const record of records) {
        const label = (record.target as Element).getAttribute('aria-label');
        if (label === 'Включить микрофон' || label === 'Выключить микрофон')
          seen.flips.push(performance.now());
      }
    }).observe(document.documentElement, {
      attributes: true,
      subtree: true,
      attributeFilter: ['aria-label'],
    });
  if (document.documentElement) watch();
  else document.addEventListener('DOMContentLoaded', watch);
};

type Seen = {
  gum: number;
  modules: number;
  replaced: number;
  notes: number[];
  clicks: number[];
  flips: number[];
};
const seen = (page: Page) => page.evaluate(() => (window as unknown as { __mic: Seen }).__mic);

test('микрофон: один захват на встречу, шумодав не пересобирается, один сигнал; звук встречи — заново при входе', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(240_000);
  // Ведущий держит встречу открытой, пока гость уходит и входит снова: пустая встреча закрывается сразу.
  const hosting = await browser.newContext({ permissions: ['camera', 'microphone'] });
  // Гость — новый человек на ПК: умолчание «Усиленное» (R145), а общий профиль сценариев ставит «Стандартное».
  const context = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: { width: 1440, height: 900 },
    storageState: {
      cookies: [],
      origins: [
        {
          origin: new URL(baseURL!).origin,
          localStorage: [{ name: 'cord:onboarding:v1', value: JSON.stringify({ tour: true }) }],
        },
      ],
    },
  });
  await context.addInitScript(count);
  const host = await hosting.newPage();
  const page = await context.newPage();
  try {
    await host.goto('/');
    await host.getByRole('button', { name: /Новая встреча/ }).click();
    await host.getByLabel('Ваше имя').fill('Ведущий');
    await host.getByRole('button', { name: 'Начать встречу' }).click();
    await expect(host.locator('[data-media-status="connected"]')).toBeVisible({ timeout: 30000 });
    await host.getByRole('button', { name: 'Пригласить участников', exact: true }).click();
    const invitation = await host.getByRole('textbox', { name: 'Ссылка приглашения' }).inputValue();
    await host.getByRole('button', { name: 'Закрыть', exact: true }).click();

    const enter = async () => {
      await page.goto(invitation);
      await page.getByLabel('Ваше имя').fill('Микрофон');
      await page.getByRole('button', { name: 'Войти во встречу' }).click();
      await expect(page.locator('[data-media-status="connected"]')).toBeVisible({ timeout: 30000 });
    };
    await enter();
    // ПК не захватывает микрофон, пока его не включили (E12-1).
    expect((await seen(page)).gum).toBe(0);
    await page.waitForTimeout(1000);
    const before = (await seen(page)).notes.length;

    const on = page.getByRole('button', { name: 'Включить микрофон', exact: true });
    const off = page.getByRole('button', { name: 'Выключить микрофон', exact: true });
    const toggles = 8;
    for (let i = 0; i < toggles / 2; i++) {
      await on.click();
      await expect(off).toBeVisible();
      // Сигнал «включён» звучит после включения — дождаться его, чтобы сосчитать ноты честно.
      await expect.poll(async () => (await seen(page)).notes.length - before).toBe(4 * i + 2);
      await off.click();
      await expect(on).toBeVisible();
      await expect.poll(async () => (await seen(page)).notes.length - before).toBe(4 * i + 4);
      await page.waitForTimeout(300);
    }
    const result = await seen(page);
    // Один захват на всю встречу: дальше — mute/unmute той же дорожки.
    expect(result.gum, 'getUserMedia на все включения').toBe(1);
    // Шумодав собран один раз и до публикации: ворклет не поднимается заново, отправитель не меняет дорожку.
    expect(result.modules, 'addModule ворклета RNNoise').toBeLessThanOrEqual(1);
    expect(result.replaced, 'replaceTrack звука').toBe(0);
    // Одно переключение — один сигнал из двух нот (второй «выключен» не звучит).
    expect(result.notes.length - before).toBe(2 * toggles);
    // После первого включения (захват и публикация) — сразу: надпись кнопки и сигнал. Сигнал звучит,
    // когда переключение закончилось, — раньше он ждал пересборки шумодава (на стенде до 13 с).
    const after = (marks: number[]) =>
      result.clicks.slice(1).map((click) => (marks.find((mark) => mark >= click) ?? Infinity) - click);
    const flips = after(result.flips);
    const cues = after(result.notes);
    expect(Math.max(...flips), `смена надписи, мс: ${flips.map(Math.round).join(', ')}`).toBeLessThan(500);
    expect(Math.max(...cues), `сигнал, мс: ${cues.map(Math.round).join(', ')}`).toBeLessThan(500);

    // R161: звук встречи выключен — ушли и вошли снова: звук, микрофон и камера включаются заново.
    await on.click();
    await expect(off).toBeVisible();
    await page.getByRole('button', { name: 'Выключить звук встречи', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Включить звук встречи', exact: true })).toBeVisible();
    await expect(on).toBeVisible();
    // Ведущий видит наушники у гостя (R156).
    await expect(host.getByLabel('Звук встречи выключен').filter({ visible: true }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Выйти из встречи' }).click();
    await expect(
      page.getByRole('main').getByRole('textbox', { name: 'Код встречи или ссылка' }),
    ).toBeVisible();
    await enter();
    await expect(page.getByRole('button', { name: 'Выключить звук встречи', exact: true })).toBeVisible();
    await expect(on).toBeVisible();
    await expect(page.getByRole('button', { name: 'Включить камеру', exact: true })).toBeVisible();
    // Вошедший снова — со звуком, и ведущий наушников у него больше не видит.
    await expect(host.getByLabel('Звук встречи выключен')).toHaveCount(0);
    await host.getByRole('button', { name: 'Настройки и действия' }).click();
    await host.getByRole('menuitem', { name: 'Завершить для всех' }).click();
  } finally {
    await context.close();
    await hosting.close();
  }
});
