import { expect, test, type Page } from '@playwright/test';
import { inviteLink, joinMeeting, startMeeting } from './support/cinema';

/*
  Закрепление камеры (R83, R84) двумя браузерами через настоящий SFU: ведущий на мониторе 1280,
  гость — с телефона 390. Закрепить чужую и свою камеру, увидеть крупную плитку над лентой и
  «Открепить», открепить — и всё это без горизонтального переполнения на телефоне.
*/

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);

test('закрепить и открепить камеру — на 1280 и на телефоне 390', async ({ browser }) => {
  test.setTimeout(120000);
  const desk = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    permissions: ['camera', 'microphone'],
  });
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    permissions: ['camera', 'microphone'],
  });
  const host = await desk.newPage();
  const guest = await phone.newPage();
  try {
    await startMeeting(host, 'Хост');
    await host.getByRole('button', { name: 'Включить камеру', exact: true }).click();
    await joinMeeting(guest, await inviteLink(host), 'Гость');
    await expect(guest.locator('[data-media-status="connected"]')).toBeVisible({ timeout: 20000 });
    await expect(guest.locator('.person-tile')).toHaveCount(2);

    // Телефон: закрепить ведущего из меню «…» его плитки.
    const hostTile = guest.locator('.person-tile').filter({ hasText: 'Хост' });
    await hostTile.getByRole('button', { name: 'Действия: Хост' }).tap();
    await guest.getByRole('menuitem', { name: 'Закрепить камеру', exact: true }).tap();
    const big = guest.locator('.spotlight-main .person-tile[data-pinned="true"]');
    await expect(big).toContainText('Хост');
    await expect(big).toBeInViewport({ ratio: 1 });
    await expect(guest.locator('.spotlight-strip .person-tile')).toHaveCount(1);
    await expect(guest.locator('.spotlight-strip .person-tile')).toBeInViewport({ ratio: 1 });
    await expect(big.locator('video.camera-video')).toHaveCount(1);
    const unpin = guest.getByRole('button', { name: 'Открепить: Хост' });
    await expect(unpin).toBeInViewport({ ratio: 1 });
    expect((await unpin.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await overflow(guest)).toBe(0);
    await guest.screenshot({ path: '../.local/stage-pin-390.png' });
    await unpin.tap();
    await expect(guest.locator('.spotlight-main')).toHaveCount(0);
    await expect(guest.locator('.people-grid .person-tile')).toHaveCount(2);

    // «Говорящий» на телефоне — та же раскладка крупно над лентой.
    await guest.getByRole('button', { name: 'Настройки и действия' }).tap();
    await guest.getByRole('menuitem', { name: /^Говорящий/ }).tap();
    await expect(guest.locator('.stage[data-layout="speaker"][data-spotlight="true"]')).toHaveCount(1);
    await expect(guest.locator('.spotlight-main .person-tile')).toBeInViewport({ ratio: 1 });
    expect(await overflow(guest)).toBe(0);

    // Монитор: закрепить свою камеру.
    const ownTile = host.locator('.person-tile').filter({ hasText: 'Хост' });
    await ownTile.getByRole('button', { name: 'Действия: Хост' }).click();
    await host.getByRole('menuitem', { name: 'Закрепить камеру', exact: true }).click();
    await expect(host.locator('.spotlight-main .person-tile[data-pinned="true"]')).toContainText('Хост');
    await expect(host.locator('.spotlight-strip .person-tile')).toContainText('Гость');
    await ownTile.getByRole('button', { name: 'Действия: Хост' }).click();
    await expect(host.getByRole('menuitem', { name: 'Открепить камеру', exact: true })).toBeVisible();
    await host.keyboard.press('Escape');
    expect(await overflow(host)).toBe(0);
    await host.screenshot({ path: '../.local/stage-pin-1280.png' });
    await host.getByRole('button', { name: 'Открепить: Хост' }).click();
    await expect(host.locator('.person-tile[data-pinned="true"]')).toHaveCount(0);
    await expect(host.locator('.people-grid .person-tile')).toHaveCount(2);
  } finally {
    await desk.close();
    await phone.close();
  }
});
