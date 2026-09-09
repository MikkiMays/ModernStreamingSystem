import { expect, test, type WebSocketRoute } from '@playwright/test';

test('media signaling recovers inside the fixed deadline without duplicating the participant', async ({
  browser,
}) => {
  test.setTimeout(60000);
  const context = await browser.newContext({ permissions: ['camera', 'microphone'] });
  let blocked = false;
  let signaling: WebSocketRoute | undefined;
  const buffered: { socket: WebSocketRoute; message: Buffer | string }[] = [];
  await context.routeWebSocket('**/rtc**', (socket) => {
    signaling = socket;
    const server = socket.connectToServer();
    server.onMessage((message) => {
      if (blocked) buffered.push({ socket, message });
      else void socket.send(message);
    });
  });
  const page = await context.newPage();
  try {
    await page.goto('/');
    await page.getByRole('button', { name: /Новая встреча/ }).click();
    await page.getByLabel('Ваше имя').fill('Смена сети');
    await page.getByRole('button', { name: 'Начать встречу' }).click();
    await expect(page.getByText('В эфире', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Включить камеру' }).click();
    await expect
      .poll(() => page.locator('video.camera-video').evaluate((v: HTMLVideoElement) => v.videoWidth))
      .toBeGreaterThan(0);
    expect(signaling).toBeDefined();
    const credentials = await page.evaluate(() =>
      JSON.parse(sessionStorage.getItem(`cord:session:${location.pathname.split('/').at(-1)}`)!),
    );
    for (const outage of [2000, 5000, 10000]) {
      blocked = true;
      signaling!.close({ code: 1013, reason: 'Test media signaling outage' });
      await expect(page.getByText('Возвращаемся в разговор', { exact: true })).toBeVisible();
      // The wait is the controlled fault duration, not a synchronization workaround.
      await new Promise((resolve) => setTimeout(resolve, outage));
      blocked = false;
      for (const frame of buffered.splice(0)) frame.socket.send(frame.message);
      await expect(page.getByText('В эфире', { exact: true })).toBeVisible({ timeout: 7000 });
      const snapshot = await page.request.get(`/api/v1/rooms/${credentials.roomId}`, {
        headers: { Authorization: `Bearer ${credentials.credential}` },
      });
      const state = await snapshot.json();
      expect(state.participants).toHaveLength(1);
      expect(state.participants[0].id).toBe(credentials.participantId);
      await expect(page.getByRole('button', { name: 'Выключить камеру' })).toBeEnabled();
    }
    await page.getByRole('button', { name: 'Настройки и действия' }).click();
    await page.getByRole('menuitem', { name: 'Завершить для всех' }).click();
  } finally {
    await context.close();
  }
});
