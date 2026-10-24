// Снимки игровых столов для ревью 1.0.3 (R108–R111, R45, R46, R27) — одна встреча на весь прогон.
//
//   node scripts/stand-dev.mjs &                                   # невыкаченный веб под именем стенда
//   node scripts/game-shots.mjs --dev 127.0.0.1:5443 --out ../backlog/review-1.0.3/shots
//   node scripts/game-shots.mjs --base https://cord.nikg.tech --out shots   # выкаченный веб
//
// Дурак: двое за столом, идёт бой — у того, чей ход, жёлтое кольцо хода снаружи лица, у говорящего
// (поддельный микрофон Chromium пищит) — зелёное у самого лица. Покер: шапка между раздачами
// («Ждём игроков · 1 из 2», «Можно раздавать») и зритель без строки подсказок под столом.
// Код встречи в шапке замазан (`mask`), имена — выдуманные, камеры — тестовая картинка Chromium.
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
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
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

const connected = (page) => page.locator('[data-media-status="connected"]').waitFor({ timeout: 45000 });

/** Снимок страницы в обеих темах; код встречи и ссылки — под маской. */
async function shoot(page, name, target) {
  for (const theme of themes) {
    await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
    await page.waitForTimeout(600);
    const file = `${name}-${page.viewportSize().width}-${theme}.png`;
    const mask = [page.locator('.meeting-header__code'), page.locator('input[readonly]')];
    if (target)
      await page
        .locator(target)
        .first()
        .screenshot({ path: path.join(out, file), mask });
    else await page.screenshot({ path: path.join(out, file), mask });
    const overflowX = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    report.push({ name, width: page.viewportSize().width, theme, file, overflowX });
    console.log('shot', file, `overflowX=${overflowX}`);
  }
}

const integrations = (page) => page.locator('.dock-toggle[aria-label="Интеграции"]');

/** Микрофон включён: зелёное кольцо голоса загорается от поддельного писка Chromium. */
async function unmute(page) {
  const mic = page.getByRole('button', { name: 'Включить микрофон', exact: true });
  if (await mic.isVisible()) await mic.click();
}

async function openGame(page, game, mode) {
  await integrations(page).click();
  await page.getByRole('button', { name: /Игры/ }).click();
  await page.getByRole('button', { name: game }).click();
  if (mode) await page.getByRole('button', { name: mode }).click();
  await page.getByRole('button', { name: /Открыть стол/ }).click();
}

try {
  const host = await person(1440, 1000);
  await host.goto(base);
  await host.getByRole('button', { name: /Новая встреча/ }).click({ timeout: 30000 });
  await host.getByLabel('Ваше имя').fill('Майя');
  await host.getByRole('button', { name: 'Начать встречу' }).click();
  await connected(host);
  await host.getByRole('button', { name: 'Пригласить участников', exact: true }).click();
  const invite = await host.getByRole('textbox', { name: 'Ссылка приглашения' }).inputValue();
  await host.getByRole('button', { name: 'Закрыть', exact: true }).click();
  const guest = await person(1280, 900);
  await guest.goto(invite);
  await guest.getByLabel('Ваше имя').fill('Алекс');
  await guest.getByRole('button', { name: 'Войти во встречу' }).click();
  await connected(guest);
  await unmute(host);
  await unmute(guest);

  // --- Дурак: кольцо хода и кольцо голоса ------------------------------------------------------
  await openGame(host, /Дурак/);
  await host.locator('.durak-felt').waitFor({ timeout: 15000 });
  await guest.locator('.durak-felt').waitFor({ timeout: 15000 });
  for (const page of [host, guest])
    await page.locator('.durak').getByRole('button', { name: 'Сесть за стол', exact: true }).click();
  await host.locator('.durak').getByRole('button', { name: 'Раздать', exact: true }).first().click();
  await host.locator('.durak[data-phase="bout"]').waitFor({ timeout: 15000 });
  await host.locator('.durak-seat .turn-ring').first().waitFor({ timeout: 15000 });
  // Поддельный микрофон пищит раз в секунду: ждём, пока у кого-то загорится голос.
  await host
    .locator('.durak-seat[data-speaking]')
    .first()
    .waitFor({ timeout: 25000 })
    .catch(() => console.log('speaking ring not caught at 1440'));
  await integrations(host).click();
  await host.waitForTimeout(800);
  await shoot(host, 'durak-rings', '.durak');
  await guest.setViewportSize({ width: 390, height: 844 });
  await guest.waitForTimeout(800);
  await shoot(guest, 'durak-rings');
  await guest.setViewportSize({ width: 1280, height: 900 });

  // --- Покер: шапка говорит состояние, у зрителя нет строки под столом --------------------------
  await host.getByRole('button', { name: 'Настройки игры' }).click();
  await host.getByRole('button', { name: /Убрать стол из встречи/ }).click();
  await host.locator('.durak').waitFor({ state: 'detached', timeout: 15000 });
  await openGame(host, /Покер/);
  await host.locator('.poker-felt').waitFor({ timeout: 15000 });
  await host.locator('.game-seat-action').first().click();
  await host.locator('.poker-bar [data-table-status="waiting"]').waitFor({ timeout: 15000 });
  await integrations(host).click();
  await host.waitForTimeout(800);
  await shoot(host, 'poker-bar-waiting', '.poker');
  await guest.locator('.poker-felt').waitFor({ timeout: 15000 });
  await shoot(guest, 'poker-spectator', '.poker');
  await guest.setViewportSize({ width: 390, height: 844 });
  await guest.waitForTimeout(800);
  await shoot(guest, 'poker-spectator');
  await guest.setViewportSize({ width: 1280, height: 900 });
  await guest.locator('.game-seat-action').first().click();
  await host.locator('.poker-bar [data-table-status="ready"]').waitFor({ timeout: 15000 });
  await shoot(host, 'poker-bar-ready', '.poker');
} finally {
  writeFileSync(path.join(out, 'game-shots.json'), JSON.stringify(report, null, 2) + '\n');
  await browser.close();
}
