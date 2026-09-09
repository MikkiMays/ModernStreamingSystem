import { expect, test } from '@playwright/test';

test('two synthetic screen sources traverse the real SFU; a third is rejected', async ({ browser }) => {
  test.setTimeout(90000);
  const contexts = await Promise.all(
    [0, 1, 2].map(() => browser.newContext({ viewport: { width: 1366, height: 900 } })),
  );
  for (const context of contexts)
    await context.addInitScript(() => {
      // New contexts first execute this script on an insecure about:blank page.
      if (!navigator.mediaDevices) return;
      navigator.mediaDevices.getDisplayMedia = async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 2560;
        canvas.height = 1440;
        const ctx = canvas.getContext('2d')!;
        let frame = 0;
        const paint = () => {
          ctx.fillStyle = '#153f73';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = '#fff';
          ctx.font = '72px sans-serif';
          ctx.fillText(`TEST SCREEN · ${frame++}`, 120, 240);
          ctx.fillRect((frame * 12) % 2400, 500, 100, 100);
        };
        paint();
        const timer = setInterval(paint, 1000 / 60);
        const stream = canvas.captureStream(60);
        stream.getVideoTracks()[0]!.addEventListener('ended', () => clearInterval(timer));
        return stream;
      };
    });
  const pages = await Promise.all(contexts.map((c) => c.newPage()));
  const [host, guest, third] = pages;
  try {
    await host!.goto('/');
    await host!.getByRole('button', { name: /Новая встреча/ }).click();
    await host!.getByLabel('Ваше имя').fill('Экран 1');
    await host!.getByRole('button', { name: 'Начать встречу' }).click();
    await expect(host!.getByText('В эфире', { exact: true })).toBeVisible();
    await host!.getByRole('button', { name: 'Пригласить участников' }).click();
    const invite = await host!.getByLabel('Ссылка приглашения').inputValue();
    await host!.getByRole('button', { name: 'Закрыть', exact: true }).click();
    for (const [i, page] of [guest!, third!].entries()) {
      await page.goto(invite);
      await page.getByLabel('Ваше имя').fill(`Экран ${i + 2}`);
      await page.getByRole('button', { name: 'Войти во встречу' }).click();
      await expect(page.getByText('В эфире', { exact: true })).toBeVisible();
    }
    await host!.getByRole('button', { name: 'Показать экран', exact: true }).click();
    await host!.getByRole('button', { name: 'Включить камеру', exact: true }).click();
    await host!.getByRole('button', { name: 'Включить микрофон', exact: true }).click();
    await expect(guest!.locator('video.screen-video')).toHaveCount(1, { timeout: 12000 });
    await expect
      .poll(() => guest!.locator('video.screen-video').evaluate((v: HTMLVideoElement) => v.videoWidth))
      .toBeGreaterThan(0);
    await expect(guest!.getByLabel('Лицо ведущего: Экран 1')).toBeVisible();
    await guest!.getByRole('button', { name: 'Показывать лицо рядом с экраном' }).click();
    await expect(guest!.locator('.screen-tile')).toHaveAttribute('data-face-layout', 'side');
    const localCaptureId = await host!
      .locator('.person-tile video')
      .evaluate((v: HTMLVideoElement) => (v.srcObject as MediaStream).getVideoTracks()[0]!.id);
    await guest!.getByRole('button', { name: 'Показать экран', exact: true }).click();
    await test.step('both screen streams deliver moving video to the third participant', async () => {
      const screens = third!.locator('video.screen-video');
      // Three browsers encode/decode 1440p canvas sources on the shared Windows runner.
      // A retained trace showed stream two arriving at 12.8s, after the old 12s deadline.
      await expect(screens).toHaveCount(2, { timeout: 30000 });
      await expect
        .poll(
          () =>
            screens.evaluateAll((videos) =>
              videos.every((element) => {
                const video = element as HTMLVideoElement;
                return video.videoWidth > 0 && video.getVideoPlaybackQuality().totalVideoFrames > 0;
              }),
            ),
          { timeout: 15000 },
        )
        .toBe(true);
      const initialFrames = await screens.evaluateAll((videos) =>
        videos.map((video) => (video as HTMLVideoElement).getVideoPlaybackQuality().totalVideoFrames),
      );
      await expect
        .poll(
          () =>
            screens.evaluateAll(
              (videos, initial) =>
                videos.length === 2 &&
                videos.every(
                  (video, index) =>
                    (video as HTMLVideoElement).getVideoPlaybackQuality().totalVideoFrames > initial[index]!,
                ),
              initialFrames,
            ),
          { timeout: 15000 },
        )
        .toBe(true);
    });
    await guest!.getByRole('button', { name: 'Закрепить экран: Экран 1', exact: true }).click();
    await guest!
      .locator('.person-tile')
      .getByRole('button', { name: 'Закрепить участника: Экран 1', exact: true })
      .click();
    await expect(guest!.locator('.person-tile[data-pinned="true"]')).toHaveCount(1);
    await expect(host!.locator('.person-tile[data-pinned="true"]')).toHaveCount(0);
    await expect(guest!.locator('.screen-tile:visible')).toHaveCount(1);
    expect(
      await host!
        .locator('.person-tile video')
        .evaluate((v: HTMLVideoElement) => (v.srcObject as MediaStream).getVideoTracks()[0]!.id),
    ).toBe(localCaptureId);
    await guest!.screenshot({ path: '../.local/pinned-screen-and-face.png' });
    await guest!.getByRole('button', { name: 'Настройки и действия' }).click();
    await guest!.getByRole('menuitem', { name: 'Вернуться в прямой эфир' }).click();
    await expect
      .poll(() =>
        guest!
          .locator('.screen-tile[data-focused="true"] video.screen-video')
          .evaluate((v: HTMLVideoElement) => v.videoWidth),
      )
      .toBeGreaterThan(0);
    await expect(guest!.getByText('В эфире', { exact: true })).toBeVisible();
    await expect(guest!.locator('audio')).toHaveCount(1);
    await third!.getByRole('button', { name: 'Показать экран', exact: true }).click();
    await expect(third!.getByRole('alert')).toContainText('Уже транслируются два экрана');
    await host!.screenshot({ path: '../.local/screens-desktop.png' });
    await host!.getByRole('button', { name: 'Остановить', exact: true }).click();
    await expect(third!.locator('video.screen-video')).toHaveCount(1);
    await expect(host!.getByText('В эфире', { exact: true })).toBeVisible();
    await host!.getByRole('button', { name: 'Настройки и действия' }).click();
    await host!.getByRole('menuitem', { name: 'Завершить для всех' }).click();
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});
