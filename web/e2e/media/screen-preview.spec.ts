/**
 * Доходит ли превью демонстрации до зрителя (R07/R80, порог §7: ≤ 6 с): хост показывает синтетический экран,
 * у гостя смотрим, получает ли `.screen-preview` картинку (атрибут style) и сколько пакетов
 * данных темы `cord.screen-preview` пришло.
 */
import { expect, test } from '@playwright/test';

test.skip(!process.env.CORD_MEDIA_PROBE, 'живой замер: CORD_MEDIA_PROBE=1');

test('превью показа доходит до зрителя, который его не открывал (R07/R80)', async ({ browser }) => {
  const contexts = await Promise.all(
    [0, 1].map(() => browser.newContext({ viewport: { width: 1366, height: 900 } })),
  );
  for (const context of contexts)
    await context.addInitScript(() => {
      if (!navigator.mediaDevices) return;
      navigator.mediaDevices.getDisplayMedia = async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 1280;
        canvas.height = 720;
        const ctx = canvas.getContext('2d')!;
        let frame = 0;
        const paint = () => {
          ctx.fillStyle = '#153f73';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = '#fff';
          ctx.font = '36px sans-serif';
          ctx.fillText(`TEST SCREEN · ${frame++}`, 64, 120);
          ctx.fillRect((frame * 12) % 1180, 240, 100, 100);
        };
        paint();
        setInterval(paint, 1000 / 30);
        return canvas.captureStream(30);
      };
      // Считаем пакеты данных по теме превью на стороне зрителя.
      (window as any).__previewPackets = 0;
      const NativeDC = window.RTCPeerConnection;
      const Wrapped = function (this: any, ...a: any[]) {
        const pc = new (NativeDC as any)(...a);
        pc.addEventListener('datachannel', (event: RTCDataChannelEvent) => {
          event.channel.addEventListener('message', (m: MessageEvent) => {
            const size = m.data instanceof ArrayBuffer ? m.data.byteLength : 0;
            (window as any).__dcBytes = ((window as any).__dcBytes ?? 0) + size;
            (window as any).__dcMessages = ((window as any).__dcMessages ?? 0) + 1;
          });
        });
        return pc;
      } as any;
      Wrapped.prototype = NativeDC.prototype;
      Object.setPrototypeOf(Wrapped, NativeDC);
      window.RTCPeerConnection = Wrapped;
    });
  const [host, guest] = await Promise.all(contexts.map((c) => c.newPage()));
  try {
    await host!.goto('/');
    await host!.getByRole('button', { name: /Новая встреча/ }).click();
    await host!.getByLabel('Ваше имя').fill('Экран');
    await host!.getByRole('button', { name: 'Начать встречу' }).click();
    await expect(host!.locator('[data-media-status="connected"]')).toBeVisible({ timeout: 30000 });
    await host!.getByRole('button', { name: 'Пригласить участников', exact: true }).click();
    const invite = await host!.getByLabel('Ссылка приглашения').inputValue();
    await host!.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await guest!.goto(invite);
    await guest!.getByLabel('Ваше имя').fill('Зритель');
    await guest!.getByRole('button', { name: 'Войти во встречу' }).click();
    await expect(guest!.locator('[data-media-status="connected"]')).toBeVisible({ timeout: 30000 });
    await host!.getByRole('button', { name: 'Показать экран', exact: true }).click();
    await expect(guest!.getByRole('button', { name: /Смотреть стрим/ })).toHaveCount(1, { timeout: 30000 });
    const t0 = Date.now();
    for (let i = 0; i < 25; i++) {
      const state = await guest!.evaluate(() => {
        const el = document.querySelector('.screen-preview') as HTMLElement | null;
        return {
          tiles: document.querySelectorAll('.screen-preview').length,
          style: el?.getAttribute('style') ?? null,
          bg: el ? getComputedStyle(el).backgroundImage.slice(0, 60) : null,
          dcMessages: (window as any).__dcMessages ?? 0,
          dcBytes: (window as any).__dcBytes ?? 0,
        };
      });
      console.log(`+${Math.round((Date.now() - t0) / 1000)}s`, JSON.stringify(state));
      if (state.style) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    // Порог §7: картинка у зрителя не позже чем через 6 с после начала показа.
    const got = await guest!.evaluate(() =>
      (document.querySelector('.screen-preview') as HTMLElement | null)?.getAttribute('style'),
    );
    expect(got, 'плитка показывающего получила кадр превью').toBeTruthy();
    expect(Date.now() - t0).toBeLessThanOrEqual(6000);
    const hostSide = await host!.evaluate(() => {
      const v = document.querySelectorAll('video');
      return {
        videos: v.length,
        sizes: [...v].map((x) => [x.videoWidth, x.videoHeight, x.readyState, x.paused]),
      };
    });
    console.log('host videos', JSON.stringify(hostSide));
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});
