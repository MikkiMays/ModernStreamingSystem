// Снимки макетов. Запуск из каталога `web/` (там Playwright): node ../backlog/review-1.0.3/mockups/shoot.mjs [страница ...]
import { createRequire } from 'node:module';
import path from 'node:path';
const { chromium } = createRequire(path.join(process.cwd(), 'package.json'))('playwright');
const here = path.dirname(new URL(import.meta.url).pathname);
const base = 'file://' + here + '/';
const out = path.join(here, 'shots') + '/';
const all = ['settings', 'settings?pane=video', 'settings?pane=overlay', 'settings?pane=accounts', 'settings?pane=about', 'home', 'prejoin', 'meeting', 'player', 'support', 'support?tab=write', 'support?tab=check', 'overlay', 'share-picker', 'mini-overlay'];
const pages = process.argv.slice(2).length ? process.argv.slice(2) : all;
const browser = await chromium.launch();
for (const name of pages) {
  const [file, extra] = name.split('?');
  for (const theme of ['dark', 'light']) {
    for (const [w, h, tag] of [[1440, 900, '1440'], [390, 844, '390']]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, colorScheme: theme });
      const page = await ctx.newPage();
      const errs = [];
      page.on('pageerror', (e) => errs.push(e.message));
      await page.goto(`${base}${file}.html?theme=${theme}${extra ? '&' + extra : ''}`);
      await page.waitForTimeout(400);
      const fn = `${file}${extra ? '-' + extra.replace(/[^a-z0-9]+/gi, '_') : ''}-${tag}-${theme}.png`;
      await page.screenshot({ path: out + fn });
      if (errs.length) console.log(fn, 'ERRORS', errs);
      await ctx.close();
    }
  }
  console.log('done', name);
}
await browser.close();
