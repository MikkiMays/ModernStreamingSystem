/**
 * «Завершить показ» — у зрителя закрыто сразу (R81, порог: ≤ 700 мс от нажатия у стримящего до
 * исчезновения плеера показа у зрителя — дорожка SFU, не снимок ядра). Требует SFU: `CORD_MEDIA_PROBE=1`.
 */
import { expect, test } from '@playwright/test';

test.skip(!process.env.CORD_MEDIA_PROBE, 'живой замер: CORD_MEDIA_PROBE=1');

test('остановка показа закрывает просмотр у зрителя за доли секунды', async ({ browser }) => {
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
          ctx.fillStyle = '#204060';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = '#fff';
          ctx.fillRect((frame++ * 10) % 1180, 300, 100, 100);
        };
        paint();
        setInterval(paint, 1000 / 30);
        return canvas.captureStream(30);
      };
    });
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
    await host!.getByRole('button', { name: 'Показать экран', exact: true }).click();
    await guest!.getByRole('button', { name: /Смотреть стрим/ }).click({ timeout: 20000 });
    await expect(guest!.locator('video.screen-video')).toHaveCount(1, { timeout: 20000 });
    const t0 = Date.now();
    await host!.getByRole('button', { name: /Остановить показ|Завершить показ/ }).click();
    await expect(guest!.locator('video.screen-video')).toHaveCount(0, { timeout: 5000 });
    const took = Date.now() - t0;
    console.log('просмотр закрылся у зрителя через', took, 'мс');
    expect(took).toBeLessThanOrEqual(700);
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});
