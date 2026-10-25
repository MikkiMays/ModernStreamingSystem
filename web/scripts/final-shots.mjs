// Снимки финального прохода после R28 (единые размеры): столы покера, дурака, шахмат и Gartic, кинозал
// (каталог и плеер), плеер музыки, приглашение, поддержка — 1440 и 390, обе темы. Одна встреча на весь
// прогон (стенд пускает десять новых встреч в час с адреса): ширина и тема меняются у той же страницы.
//
//   node scripts/final-shots.mjs --base https://cord.nikg.tech --out ../backlog/review-1.0.3/shots --track /tmp/track.wav
//   node scripts/final-shots.mjs --dev 127.0.0.1:5443 --scenes chess,gartic           # невыкаченный веб
//
// Код встречи, ссылка и QR приглашения — под маской; имена выдуманные; камеры — тестовая картинка
// Chromium. Кинозал — настоящий Rutube (YouTube с сервера чаще просит капчу); сцена пропускается, если
// каталог не ответил. Рядом — final-shots.json: переполнение страницы по ширине на каждом снимке.
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]]);
    return pairs;
  }, []),
);
const base = args.base ?? process.env.PLAYWRIGHT_BASE_URL ?? 'https://cord.nikg.tech';
const out = path.resolve(args.out ?? 'shots');
const themes = (args.themes ?? 'dark,light').split(',');
const scenes = new Set((args.scenes ?? 'invite,chess,gartic,durak,poker,music,cinema,support').split(','));
const track = args.track ?? '';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    ...(args.dev
      ? [`--host-resolver-rules=MAP ${new URL(base).hostname}:443 ${args.dev}`, '--ignore-certificate-errors']
      : []),
  ],
});
const report = [];

async function person(width, height) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    permissions: ['camera', 'microphone'],
    locale: 'ru-RU',
    ignoreHTTPSErrors: !!args.dev,
  });
  await ctx.addInitScript(() =>
    localStorage.setItem(
      'cord:onboarding:v1',
      JSON.stringify({ tour: true, meeting: true, integrations: true }),
    ),
  );
  return ctx.newPage();
}
const connected = (page) => page.locator('[data-media-status="connected"]').waitFor({ timeout: 90000 });

/** Снимок в обеих темах; код встречи, ссылки и QR — под маской. */
async function shoot(page, name, target) {
  for (const theme of themes) {
    await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
    await page.waitForTimeout(600);
    const file = `final-${name}-${page.viewportSize().width}-${theme}.png`;
    const mask = [
      page.locator('.meeting-header__code'),
      page.locator('input[readonly]'),
      page.locator('.invite-code strong'),
      page.locator('.invite-qr'),
    ];
    const shot = target ? page.locator(target).first() : page;
    await shot.screenshot({ path: path.join(out, file), mask });
    const overflowX = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    report.push({ name, width: page.viewportSize().width, theme, file, overflowX });
    console.log('shot', file, `overflowX=${overflowX}`);
  }
}
/** Тот же экран на телефоне: ширина меняется у той же страницы. */
async function phone(page, name, target, fn) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(900);
  if (fn) await fn();
  await shoot(page, name, target);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(600);
}

const integrations = (page) => page.locator('.dock-toggle[aria-label="Интеграции"]');
async function openPanel(page) {
  if (!(await page.locator('.services-panel').isVisible())) await integrations(page).click();
  await page.locator('.services-panel').waitFor({ timeout: 10000 });
  // Из раскрытой музыки — назад к полке групп, иначе кнопок «Игры»/«Кинозал» не видно.
  const back = page.locator('.services-panel .music-panel__back');
  if (await back.count()) await back.first().click();
  await page.waitForTimeout(400);
}
async function closePanel(page) {
  if (await page.locator('.services-panel').isVisible()) await integrations(page).click();
}
async function openGame(page, game) {
  await openPanel(page);
  const group = page.getByRole('button', { name: /Игры/ });
  if (await group.isVisible()) await group.click();
  await page.getByRole('button', { name: game }).first().click();
  await page.getByRole('button', { name: /Открыть стол|Открыть доску|Открыть Gartic/ }).click();
}
/** Убрать текущий стол — у каждой игры свой путь: крестик с подтверждением (шахматы), крестик (Gartic),
 * «Настройки игры» → «Убрать стол из встречи» (дурак, покер). */
async function removeTable(page, root) {
  if (
    await page
      .locator('.chess')
      .isVisible()
      .catch(() => false)
  ) {
    await page.getByRole('button', { name: 'Закрыть шахматы', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Закрыть шахматы', exact: true }).click();
  } else if (
    await page
      .locator('.gartic')
      .isVisible()
      .catch(() => false)
  ) {
    await page.getByRole('button', { name: 'Закрыть Gartic', exact: true }).click();
  } else {
    await page.getByRole('button', { name: 'Настройки игры' }).click();
    await page
      .getByRole('button', { name: /Убрать стол из встречи/ })
      .first()
      .click();
  }
  const confirm = page.getByRole('dialog').getByRole('button', { name: /Убрать/ });
  if (await confirm.isVisible({ timeout: 1500 }).catch(() => false)) await confirm.click();
  await page.locator(root).waitFor({ state: 'detached', timeout: 15000 });
}
const pages = [];
async function scene(name, fn) {
  if (!scenes.has(name)) return;
  try {
    await fn();
  } catch (error) {
    console.log(`scene ${name} failed:`, String(error).split('\n')[0]);
    report.push({ name, failed: String(error).split('\n')[0] });
    // Состояние на момент сбоя — рядом с отчётом, и чистый стол для следующей сцены.
    for (const [i, page] of pages.entries()) {
      await page.screenshot({ path: path.join(out, `final-fail-${name}-${i}.png`) }).catch(() => {});
      await page.keyboard.press('Escape').catch(() => {});
    }
    const root = pages[0]?.locator('.chess, .gartic, .durak, .poker').first();
    if (root && (await root.isVisible().catch(() => false)))
      await removeTable(pages[0], '.chess, .gartic, .durak, .poker').catch(() => {});
  }
}

try {
  const host = await person(1440, 1000);
  pages.push(host);
  await host.goto(base);
  await host.getByRole('button', { name: /Новая встреча/ }).click({ timeout: 30000 });
  await host.getByLabel('Ваше имя').fill('Майя');
  await host.getByRole('button', { name: 'Начать встречу' }).click();
  await connected(host);
  await host.getByRole('button', { name: 'Пригласить участников', exact: true }).click();
  const invite = await host.getByRole('textbox', { name: 'Ссылка приглашения' }).inputValue();
  await scene('invite', async () => {
    await shoot(host, 'invite', '[role="dialog"]');
  });
  await host.getByRole('button', { name: 'Закрыть', exact: true }).click();
  const guest = await person(1280, 900);
  pages.push(guest);
  await guest.goto(invite);
  await guest.getByLabel('Ваше имя').fill('Алекс');
  await guest.getByRole('button', { name: 'Войти во встречу' }).click();
  await connected(guest);
  await scene('invite', async () => {
    await phone(guest, 'invite', '[role="dialog"]', async () => {
      await guest.getByRole('button', { name: 'Пригласить участников', exact: true }).click();
    });
    await guest.getByRole('button', { name: 'Закрыть', exact: true }).click();
  });

  // --- Шахматы: оба за доской ---------------------------------------------------------------
  await scene('chess', async () => {
    await openGame(host, /Шахматы/);
    await host.locator('.chess').waitFor({ timeout: 15000 });
    await guest.locator('.chess').waitFor({ timeout: 15000 });
    await host.locator('.chess-seat').first().click();
    await guest.locator('.chess-seat').last().click();
    await host
      .locator('.chess-player[data-active]')
      .first()
      .waitFor({ timeout: 15000 })
      .catch(() => console.log('chess: партия не началась сама — снимаем доску с двумя игроками'));
    await closePanel(host);
    await host.waitForTimeout(800);
    await shoot(host, 'chess', '.chess');
    await phone(guest, 'chess');
    await removeTable(host, '.chess');
  });

  // --- Gartic: лобби и холст --------------------------------------------------------------
  await scene('gartic', async () => {
    await openGame(host, /Gartic/);
    await host.locator('.gartic').waitFor({ timeout: 15000 });
    await guest.locator('.gartic').waitFor({ timeout: 15000 });
    for (const page of [host, guest]) {
      const join = page.locator('.gartic').getByRole('button', { name: 'Присоединиться', exact: true });
      if (await join.isVisible({ timeout: 3000 }).catch(() => false)) await join.click();
    }
    await closePanel(host);
    await host.waitForTimeout(800);
    await shoot(host, 'gartic-lobby', '.gartic');
    const start = host.locator('.gartic').getByRole('button', { name: 'Начать игру', exact: true });
    if (await start.isEnabled({ timeout: 3000 }).catch(() => false)) {
      await start.click();
      await host.locator('.gartic:not([data-phase="lobby"])').waitFor({ timeout: 15000 });
      await host.waitForTimeout(1200);
      await shoot(host, 'gartic-round', '.gartic');
      await phone(guest, 'gartic-round');
    } else await phone(guest, 'gartic-lobby');
    await removeTable(host, '.gartic');
  });

  // --- Дурак: бой ------------------------------------------------------------------------
  await scene('durak', async () => {
    await openGame(host, /Дурак/);
    await host.locator('.durak-felt').waitFor({ timeout: 15000 });
    await guest.locator('.durak-felt').waitFor({ timeout: 15000 });
    for (const page of [host, guest])
      await page.locator('.durak').getByRole('button', { name: 'Сесть за стол', exact: true }).click();
    await host.locator('.durak').getByRole('button', { name: 'Раздать', exact: true }).first().click();
    await host.locator('.durak[data-phase="bout"]').waitFor({ timeout: 15000 });
    await closePanel(host);
    await host.waitForTimeout(800);
    await shoot(host, 'durak', '.durak');
    await phone(guest, 'durak');
    await removeTable(host, '.durak');
  });

  // --- Покер: оба сели, стол готов --------------------------------------------------------
  await scene('poker', async () => {
    await openGame(host, /Покер/);
    await host.locator('.poker-felt').waitFor({ timeout: 15000 });
    await guest.locator('.poker-felt').waitFor({ timeout: 15000 });
    await host.locator('.game-seat-action').first().click();
    await guest.locator('.game-seat-action').first().click();
    await host.locator('.poker-bar [data-table-status="ready"]').waitFor({ timeout: 15000 });
    await closePanel(host);
    await host.waitForTimeout(800);
    await shoot(host, 'poker', '.poker');
    await phone(guest, 'poker');
    await removeTable(host, '.poker');
  });

  // --- Музыка: свой файл играет, плеер открыт ----------------------------------------------
  await scene('music', async () => {
    if (!track) throw new Error('--track не задан');
    await openPanel(host);
    await host.getByRole('button', { name: /^Музыка/ }).click({ timeout: 15000 });
    await host.getByRole('tab', { name: 'Свои файлы' }).click({ timeout: 30000 });
    await host.locator('input[type="file"]').waitFor({ state: 'attached', timeout: 60000 });
    await host.locator('input[type="file"]').setInputFiles(track);
    await host.locator('.music-mini[data-playing]').waitFor({ timeout: 90000 });
    await host.waitForTimeout(1500);
    await shoot(host, 'music-player');
    await closePanel(host);
    await host.waitForTimeout(800);
    await shoot(host, 'music-mini');
    await phone(guest, 'music-mini');
    await phone(guest, 'music-player', null, async () => {
      await guest.locator('.music-mini__track').click();
      await guest.waitForTimeout(1200);
    });
    // Убрать музыку из встречи — из виджета мини-плеера: бот из опустевшей комнаты сам не уходит.
    await host.locator('.music-mini__track').click();
    const remove = host.getByRole('button', { name: /Убрать музыку/ }).first();
    if (await remove.isVisible({ timeout: 5000 }).catch(() => false)) await remove.click();
    await host.keyboard.press('Escape');
  });

  // --- Кинозал: каталог Rutube и плеер ----------------------------------------------------
  await scene('cinema', async () => {
    await openPanel(host);
    await host.getByRole('button', { name: /Кинозал/ }).click();
    await host.getByRole('button', { name: /Rutube/ }).click();
    const browse = host.locator('.cinema-browser');
    await browse.waitFor({ timeout: 15000 });
    await browse.locator('.cinema-tile').first().waitFor({ timeout: 40000 });
    await closePanel(host);
    await host.waitForTimeout(800);
    await shoot(host, 'cinema-catalog');
    const tile = browse.locator('.cinema-tile:not(.cinema-tile-face)').first();
    await tile.locator('.cinema-open').click();
    await browse.locator('.cinema-detail').waitFor({ timeout: 40000 });
    await shoot(host, 'cinema-detail');
    await browse.getByRole('button', { name: /Смотреть вместе/ }).click();
    for (const page of [host, guest]) await page.locator('.watch-theater').waitFor({ timeout: 40000 });
    await host
      .locator('.watch-play[aria-label="Пауза для всех"]')
      .waitFor({ timeout: 40000 })
      .catch(() => {});
    await host.waitForTimeout(1500);
    await host.mouse.move(700, 400);
    await host.waitForTimeout(300);
    await shoot(host, 'cinema-player');
    await phone(guest, 'cinema-player', null, async () => {
      await guest.mouse.move(200, 300);
    });
    const stop = host.getByRole('button', { name: /Закрыть просмотр/ }).first();
    if (await stop.isVisible({ timeout: 3000 }).catch(() => false)) await stop.click();
  });

  // --- Поддержка: из диагностики во встрече и с главной ---------------------------------------
  await scene('support', async () => {
    await host.getByRole('button', { name: 'Настройки и действия' }).click();
    await host.getByRole('menuitem', { name: /^Диагностика/ }).click();
    const diagnostics = host.getByRole('dialog', { name: 'Диагностика' });
    await diagnostics.waitFor({ timeout: 10000 });
    await shoot(host, 'diagnostics', '[role="dialog"]');
    await diagnostics.getByRole('button', { name: 'Поддержка' }).click();
    const help = host.getByRole('dialog', { name: 'Поддержка' });
    await help.waitFor({ timeout: 10000 });
    await help.getByRole('tab', { name: 'Написать' }).click();
    await host.waitForTimeout(500);
    await shoot(host, 'support-meeting', '[role="dialog"]');
    await help.getByRole('button', { name: 'Закрыть' }).click();
    await phone(guest, 'support-meeting', '[role="dialog"]', async () => {
      await guest.getByRole('button', { name: 'Настройки и действия' }).click();
      await guest.getByRole('menuitem', { name: /^Диагностика/ }).click();
      await guest
        .getByRole('dialog', { name: 'Диагностика' })
        .getByRole('button', { name: 'Поддержка' })
        .click();
      await guest.getByRole('dialog', { name: 'Поддержка' }).waitFor({ timeout: 10000 });
    });
    const home = await person(1440, 900);
    await home.goto(base);
    await home.getByRole('button', { name: 'Поддержка' }).click({ timeout: 30000 });
    await home.getByRole('dialog', { name: 'Поддержка' }).waitFor({ timeout: 10000 });
    await shoot(home, 'support-home', '[role="dialog"]');
    await phone(home, 'support-home', '[role="dialog"]');
  });
} finally {
  writeFileSync(path.join(out, 'final-shots.json'), JSON.stringify(report, null, 2) + '\n');
  await browser.close();
}
