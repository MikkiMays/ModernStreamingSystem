import { expect, test, type Browser, type Page } from '@playwright/test';
import { fixture, inviteLink, joinMeeting, openCinema, routeCinema, startMeeting } from './support/cinema';

/*
  Выход из интеграции к участникам и возврат чёлкой (R121), двумя браузерами через настоящую встречу.

  Интеграция идёт для всех, а выбор вида — у каждого свой. Кинозал при уходе не перезагружается: тот же
  `<video>` (метка на элементе переживает уход и возврат), не на паузе, время у ушедшего и у оставшегося
  совпадает (±1 с). Стол дурака: ушедшему, чей ход, чёлка говорит «Ваш ход» и крутит кольцо хода; нажатие
  на чёлку — снова за столом.
*/

const RICK = fixture<{ items: { title: string }[] }>('youtube-search-never-gonna-give-you-up').items[0]!;

const context = (browser: Browser) =>
  browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1280, height: 800 } });

const player = (page: Page) =>
  page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('video.watch-video');
    return video
      ? {
          mark: video.dataset.r121 ?? null,
          paused: video.paused,
          ended: video.ended,
          time: video.currentTime,
        }
      : null;
  });

test('кинозал: «Все участники» — сетка и чёлка, фильм тот же и идёт в такт; G — назад', async ({ browser }) => {
  test.slow();
  const first = await context(browser);
  const second = await context(browser);
  const host = await first.newPage();
  const guest = await second.newPage();
  await routeCinema(host);
  await routeCinema(guest);
  try {
    await startMeeting(host, 'Майс');
    await joinMeeting(guest, await inviteLink(host), 'Алекс');

    const browse = await openCinema(host, 'YouTube');
    await browse.locator('.cinema-search input').fill('never gonna give you up');
    const tile = browse
      .locator('.cinema-tile')
      .filter({ has: host.getByRole('button', { name: `Подробнее: ${RICK.title}`, exact: true }) });
    await tile.hover();
    await tile.locator('.cinema-start').click();
    await expect(guest.locator('.watch-title b')).toHaveText(RICK.title, { timeout: 30000 });
    await expect.poll(async () => (await player(guest))?.paused, { timeout: 20000 }).toBe(false);

    // Метка на самом элементе: родись плеер заново — её бы не было.
    await guest.evaluate(() => {
      document.querySelector<HTMLVideoElement>('video.watch-video')!.dataset.r121 = 'same';
    });
    await guest.locator('.watch-theater').hover();
    await guest.getByRole('button', { name: 'Все участники', exact: true }).click();

    // У ушедшего — обычная встреча: оба блоками, а сверху чёлка с фильмом.
    await expect(guest.locator('.people-grid .person-tile')).toHaveCount(2);
    const notch = guest.locator('[data-stage-notch]');
    await expect(notch).toBeVisible();
    await expect(notch).toContainText(RICK.title);
    await expect(notch).toBeFocused();
    await expect(guest.locator('[data-stage-layer="cinema"]')).toHaveAttribute('data-away', 'true');
    // У оставшегося — плеер, как был.
    await expect(host.locator('[data-stage-layer="cinema"]')).not.toHaveAttribute('data-away');

    await guest.waitForTimeout(1500);
    const [away, there] = [await player(guest), await player(host)];
    expect(away?.mark).toBe('same');
    expect(away?.paused === false || away?.ended).toBe(true);
    expect(Math.abs((away?.time ?? 0) - (there?.time ?? 0))).toBeLessThan(1);

    // Клавиша G — назад; фокус на «Все участники», тот же плеер.
    await guest.keyboard.press('g');
    await expect(guest.locator('[data-stage-layer="cinema"]')).not.toHaveAttribute('data-away');
    await expect(notch).toHaveCount(0);
    await expect(guest.getByRole('button', { name: 'Все участники', exact: true })).toBeFocused();
    expect((await player(guest))?.mark).toBe('same');
  } finally {
    await first.close();
    await second.close();
  }
});

test('стол дурака: ушедшему, чей ход, чёлка говорит «Ваш ход»; нажатие — снова за столом', async ({
  browser,
}) => {
  test.slow();
  const first = await context(browser);
  const second = await context(browser);
  const host = await first.newPage();
  const guest = await second.newPage();
  try {
    await startMeeting(host, 'Майс');
    await joinMeeting(guest, await inviteLink(host), 'Алекс');
    await host.locator('.dock-toggle[aria-label="Интеграции"]').click();
    await host.locator('.service-group').filter({ hasText: /^Игры/ }).first().click();
    await host.getByRole('button', { name: /^Дурак/ }).click();
    await host.getByRole('button', { name: /Открыть стол/ }).click();
    await host.locator('.dock-toggle[aria-label="Интеграции"]').click();
    for (const page of [host, guest]) {
      await page.locator('.durak-felt').waitFor({ timeout: 15000 });
      await page.locator('.durak').getByRole('button', { name: 'Сесть за стол', exact: true }).click();
    }
    await host.locator('.durak').getByRole('button', { name: 'Раздать', exact: true }).first().click();
    await host.locator('.durak[data-phase="bout"]').waitFor({ timeout: 15000 });

    for (const page of [host, guest]) {
      await page.getByRole('button', { name: 'Все участники', exact: true }).click();
      await expect(page.locator('[data-stage-notch]')).toBeVisible();
      await expect(page.locator('.people-grid .person-tile')).toHaveCount(2);
    }
    // Ход у одного из двоих: его чёлка — «Ваш ход» с кольцом, у другого — сколько за столом.
    const turns = async () =>
      (await host.locator('[data-stage-notch][data-turn]').count()) +
      (await guest.locator('[data-stage-notch][data-turn]').count());
    await expect.poll(turns, { timeout: 15000 }).toBe(1);
    const mine = (await host.locator('[data-stage-notch][data-turn]').count()) ? host : guest;
    const other = mine === host ? guest : host;
    const notch = mine.locator('[data-stage-notch]');
    await expect(notch).toContainText('Ваш ход');
    await expect(notch.locator('.turn-ring')).toHaveCount(1);
    await expect(other.locator('[data-stage-notch]')).toContainText('2 за столом');

    await notch.click();
    await expect(mine.locator('[data-stage-layer="durak"]')).not.toHaveAttribute('data-away');
    await expect(mine.locator('.durak-felt')).toBeVisible();
    await expect(notch).toHaveCount(0);
  } finally {
    await first.close();
    await second.close();
  }
});
