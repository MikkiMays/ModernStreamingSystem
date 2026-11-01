// Снимки звонка в обеих темах для выпуска 1.1.3 (R175, R181) — одна встреча на прогон, один человек.
//
//   node scripts/call-shots.mjs --base https://cord.nikg.tech --out ../backlog/screens/R175/before
//   CORD_STAND_DEV=127.0.0.1:5453 node scripts/stand-dev.mjs &        # невыкаченный веб под именем стенда
//   node scripts/call-shots.mjs --dev 127.0.0.1:5453 --out ../backlog/screens/R175/after
//
// Что снимается: пустой звонок и меню «…» пульта (светлая тема звонка — R175 в), панель интеграций с
// шагом «← Интеграции» (R175 д), стол дурака без игроков — шапка и колонка участников справа (R181, R175 г).
// Код встречи в шапке замазан (`mask`). Ширины — `--widths` (по умолчанию 1920×1040, 1440×900, 390×844).
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
const themes = (args.themes ?? 'light,dark').split(',');
const sizes = (args.widths ?? '1920x1040,1440x900,390x844').split(',').map((size) => {
  const [width, height] = size.split('x').map(Number);
  return { width, height: height || 900 };
});
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

const ctx = await browser.newContext({
  viewport: sizes[0],
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
const page = await ctx.newPage();

/** Тема страницы — как её ставит «Оформление»: атрибут на корне. */
const theme = (value) => page.evaluate((next) => (document.documentElement.dataset.theme = next), value);

async function shoot(name, target) {
  for (const value of themes) {
    await theme(value);
    await page.waitForTimeout(500);
    const { width } = page.viewportSize();
    const file = `${name}-${width}-${value}.png`;
    const mask = [page.locator('.meeting-header__code')];
    if (target)
      await page
        .locator(target)
        .first()
        .screenshot({ path: path.join(out, file), mask, timeout: 120000 });
    else await page.screenshot({ path: path.join(out, file), mask, timeout: 120000 });
    const overflowX = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    report.push({ name, width, theme: value, file, overflowX });
    console.log('shot', file, overflowX ? `overflowX=${overflowX}` : '');
  }
}

const integrations = () => page.locator('.dock-toggle[aria-label="Интеграции"]');
const panel = () => page.locator('.meeting-panel, [role="dialog"]').filter({ hasText: 'Интеграции' }).first();

try {
  await page.goto(base, { timeout: 240000, waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /Новая встреча/ }).click({ timeout: 240000 });
  await page.getByLabel('Ваше имя').fill('Майя');
  await page.getByRole('button', { name: 'Начать встречу' }).click();
  await page.locator('[data-media-status="connected"]').waitFor({ timeout: 240000 });
  await page.waitForTimeout(3500); // тост «ссылка скопирована» уходит

  for (const size of sizes) {
    await page.setViewportSize(size);
    await page.waitForTimeout(600);
    const phone = size.width < 768;
    await shoot('call');
    await page.getByRole('button', { name: 'Настройки и действия' }).click();
    await page.getByRole('menu').waitFor();
    await shoot('call-menu');
    await page.keyboard.press('Escape');
    if (!phone) {
      await integrations().click();
      await page.getByRole('button', { name: /Игры/ }).first().click();
      await page.waitForTimeout(400);
      await shoot('panel-games');
      await integrations().click();
    }
  }

  // Стол дурака: человек не садится — его лицо в колонке зрителей справа от стола.
  await page.setViewportSize(sizes[0]);
  await integrations().click();
  await page.getByRole('button', { name: /Игры/ }).first().click();
  await page.getByRole('button', { name: /Дурак/ }).first().click();
  await page.getByRole('button', { name: /Открыть стол/ }).click();
  await page.locator('.durak-felt').waitFor({ timeout: 15000 });
  await integrations().click();
  for (const size of sizes) {
    await page.setViewportSize(size);
    await page.waitForTimeout(800);
    await shoot('durak');
  }
} finally {
  writeFileSync(path.join(out, 'call-shots.json'), JSON.stringify(report, null, 2) + '\n');
  await browser.close();
}
