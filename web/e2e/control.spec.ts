import { expect, test, type WebSocketRoute } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('control reconnects and replays messages while remote video continues', async ({ browser }) => {
  test.setTimeout(60000);
  const hostContext = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const guestContext = await browser.newContext();
  let blocked = false;
  let control: WebSocketRoute | undefined;
  await guestContext.routeWebSocket('**/api/v1/events', (socket) => {
    if (blocked) {
      socket.close({ code: 1013, reason: 'Test control outage' });
      return;
    }
    control = socket;
    socket.connectToServer();
  });
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  try {
    await host.goto('/');
    await host.getByRole('button', { name: /Новая встреча/ }).click();
    await host.getByLabel('Ваше имя').fill('Организатор');
    await host.getByRole('button', { name: 'Начать встречу' }).click();
    await expect(host.getByText('В эфире', { exact: true })).toBeVisible();
    await host.getByRole('button', { name: 'Включить камеру' }).click();
    await host.getByRole('button', { name: 'Пригласить участников' }).click();
    const invite = await host.getByLabel('Ссылка приглашения').inputValue();
    await host.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await guest.goto(invite);
    await guest.getByLabel('Ваше имя').fill('Зритель');
    await guest.getByRole('button', { name: 'Войти во встречу' }).click();
    await expect(guest.getByText('В эфире', { exact: true })).toBeVisible();
    await expect
      .poll(() => guest.locator('video.camera-video').evaluate((v: HTMLVideoElement) => v.videoWidth))
      .toBeGreaterThan(0);
    blocked = true;
    control!.close({ code: 1013, reason: 'Test control outage' });
    await expect(guest.getByText(/Восстанавливаем чат и управление/)).toBeVisible();
    const video = guest.locator('video.camera-video');
    const before = await video.evaluate((v: HTMLVideoElement) => {
      const quality = v.getVideoPlaybackQuality();
      return {
        frames: quality.totalVideoFrames - quality.droppedVideoFrames,
        track: (v.srcObject as MediaStream).getVideoTracks()[0].id,
      };
    });
    // Verify continued decoding and the same track; a live MediaStream's currentTime
    // is not a wall clock or a measurement of glass-to-glass latency.
    await expect
      .poll(() =>
        video.evaluate((v: HTMLVideoElement) => {
          const quality = v.getVideoPlaybackQuality();
          return quality.totalVideoFrames - quality.droppedVideoFrames;
        }),
      )
      .toBeGreaterThan(before.frames + 15);
    expect(
      await video.evaluate((v: HTMLVideoElement) => (v.srcObject as MediaStream).getVideoTracks()[0].id),
    ).toBe(before.track);
    await host.getByRole('button', { name: 'Чат', exact: true }).click();
    await host.getByLabel('Сообщение', { exact: true }).fill('Доставить после восстановления');
    await host.getByRole('button', { name: 'Отправить сообщение' }).click();
    blocked = false;
    await expect(guest.getByText(/Восстанавливаем чат и управление/)).toHaveCount(0, { timeout: 10000 });
    await guest.getByRole('button', { name: 'Чат', exact: true }).click();
    await expect(guest.getByText('Доставить после восстановления', { exact: true })).toBeVisible();
    for (const colorScheme of ['light', 'dark'] as const) {
      await guest.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      const audit = await new AxeBuilder({ page: guest })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze();
      expect(
        audit.violations.map((v) => ({
          id: v.id,
          theme: colorScheme,
          nodes: v.nodes.map((n) => ({ target: n.target, checks: n.any })),
        })),
      ).toEqual([]);
    }
    await host.getByRole('button', { name: 'Настройки и действия' }).click();
    await host.getByRole('menuitem', { name: 'Завершить для всех' }).click();
  } finally {
    await hostContext.close();
    await guestContext.close();
  }
});
