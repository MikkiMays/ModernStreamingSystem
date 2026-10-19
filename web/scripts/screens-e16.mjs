#!/usr/bin/env node
/**
 * Кадры макетов направления E16 (`backlog/screens/E16/*.html`) и витрины `/kit`.
 *
 *   node scripts/screens-e16.mjs            — макеты: три варианта, выбранный в обеих темах
 *   node scripts/screens-e16.mjs --kit URL  — витрина набора по адресу dev-сервера, обе темы
 *
 * Запускается из `web/`: `@playwright/test` стоит только здесь.
 */
import { chromium } from '@playwright/test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const out = join(fileURLToPath(import.meta.url), '..', '..', '..', 'backlog', 'screens', 'E16');
const chosen = 'a';
const variants = ['a', 'b', 'c'];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
// Машина сборки медленная и с чужой нагрузкой: 30 с по умолчанию не хватает даже на кадр.
page.setDefaultTimeout(240_000);

const kitUrl = process.argv.includes('--kit') ? process.argv[process.argv.indexOf('--kit') + 1] : null;
if (kitUrl) {
  for (const theme of ['light', 'dark']) {
    await page.goto(kitUrl, { waitUntil: 'networkidle' });
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
    }, theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(out, `kit-${theme}.png`), fullPage: true });
    console.log(`kit-${theme}.png`);
  }
} else {
  for (const screen of ['meeting', 'settings']) {
    await page.goto(pathToFileURL(join(out, `${screen}.html`)).href);
    await page.evaluate(() => document.fonts.ready);
    for (const variant of variants) {
      for (const theme of variant === chosen ? ['dark', 'light'] : ['dark']) {
        await page.evaluate(
          ([v, t]) => {
            document.documentElement.dataset.variant = v;
            document.documentElement.dataset.theme = t;
            for (const el of document.querySelectorAll('[data-only]'))
              el.style.display = el.dataset.only === v ? '' : 'none';
          },
          [variant, theme],
        );
        await page.waitForTimeout(100);
        const name = `${screen}-${variant}-${theme}.png`;
        await page.screenshot({ path: join(out, name) });
        console.log(name);
      }
    }
  }
}
await browser.close();
