/**
 * Старт показа (R98, порог §9.2): от нажатия «Показать экран» до кадра выбранного размера у зрителя
 * ≤ 2,5 с на стенде. Долгий и требует SFU: включается `CORD_MEDIA_PROBE=1`.
 */
import { expect, test } from '@playwright/test';

test.skip(!process.env.CORD_MEDIA_PROBE, 'живой замер: CORD_MEDIA_PROBE=1');

const hook = () => {
  const Native = window.RTCPeerConnection;
  if (!Native) return;
  (window as any).__pcs = [];
  class Wrapped extends Native {
    constructor(...a: any[]) {
      super(...a);
      (window as any).__pcs.push(this);
    }
  }
  window.RTCPeerConnection = Wrapped as any;
};

test('показ доходит до зрителя в выбранном размере за 2,5 с', async ({ browser }) => {
  const contexts = await Promise.all(
    [0, 1].map(() => browser.newContext({ viewport: { width: 1366, height: 900 } })),
  );
  for (const context of contexts) {
    await context.addInitScript(hook);
    await context.addInitScript(() => {
      if (!navigator.mediaDevices) return;
      navigator.mediaDevices.getDisplayMedia = async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 1920;
        canvas.height = 1080;
        const ctx = canvas.getContext('2d')!;
        let frame = 0;
        const paint = () => {
          ctx.fillStyle = `hsl(${frame % 360}, 60%, 40%)`;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = '#fff';
          ctx.font = '48px sans-serif';
          ctx.fillText(`TEST SCREEN · ${frame++}`, 80, 160);
        };
        paint();
        setInterval(paint, 1000 / 30);
        return canvas.captureStream(30);
      };
    });
  }
  const [host, guest] = await Promise.all(contexts.map((c) => c.newPage()));
  try {
    await host!.goto('/');
    await host!.getByRole('button', { name: /Новая встреча/ }).click();
    await host!.getByLabel('Ваше имя').fill('Экран');
    await host!.getByRole('button', { name: 'Начать встречу' }).click();
    await expect(host!.locator('[data-media-status="connected"]')).toBeVisible({ timeout: 60000 });
    await host!.getByRole('button', { name: 'Пригласить участников', exact: true }).click();
    const invite = await host!.getByLabel('Ссылка приглашения').inputValue();
    await host!.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await guest!.goto(invite);
    await guest!.getByLabel('Ваше имя').fill('Зритель');
    await guest!.getByRole('button', { name: 'Войти во встречу' }).click();
    await expect(guest!.locator('[data-media-status="connected"]')).toBeVisible({ timeout: 60000 });
    const t0 = Date.now();
    await host!.getByRole('button', { name: 'Показать экран', exact: true }).click();
    await guest!.getByRole('button', { name: /Смотреть стрим/ }).click({ timeout: 10000 });
    let ready = 0;
    while (Date.now() - t0 < 10000) {
      const height = await guest!.evaluate(async () => {
        let best = 0;
        for (const pc of (window as any).__pcs as RTCPeerConnection[]) {
          const report = await pc.getStats();
          report.forEach((s: any) => {
            if (s.type === 'inbound-rtp' && s.kind === 'video' && s.framesDecoded > 0)
              best = Math.max(best, s.frameHeight ?? 0);
          });
        }
        return best;
      });
      // Выбранный по умолчанию уровень — 720p (правила сервера): кадр не меньше него.
      if (height >= 720 * 0.95) {
        ready = Date.now() - t0;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    console.log('первый кадр целевого размера у зрителя через', ready, 'мс');
    expect(ready).toBeGreaterThan(0);
    expect(ready).toBeLessThanOrEqual(2500);
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});
