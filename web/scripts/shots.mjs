// Скриншоты экранов Cord на нескольких ширинах и в обеих темах, плюс отчёт о переполнении.
//
//   node scripts/shots.mjs --base https://cord.nikg.tech --out ../backlog/screens/E00/before
//   node scripts/shots.mjs --screens home,settings --widths 390,1440 --themes dark
//
// Для каждого экрана, ширины и темы — PNG и строка в report.json: на сколько пикселей страница
// шире окна (`scrollWidth - clientWidth`) и какие элементы вылезают за правый край. Скрипт лежит
// внутри web/, потому что `@playwright/test` резолвится от файла, а не от рабочего каталога.
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
const widths = (args.widths ?? '320,390,768,1024,1280,1440,1920').split(',').map(Number);
const themes = (args.themes ?? 'light,dark').split(',');
const only = args.screens?.split(',');
const height = (width) => (width < 768 ? 844 : width < 1280 ? 900 : 1000);

/** Устойчивый признак, что медиа вышло в эфир: атрибут, а пока его нет — прежний бейдж. */
async function connected(page) {
  await page
    .locator('[data-media-status="connected"]')
    .or(page.getByText('В эфире', { exact: true }))
    .first()
    .waitFor({ timeout: 45000 });
}

async function home(page) {
  await page.goto(base);
  await page.getByRole('button', { name: /Новая встреча/ }).waitFor({ timeout: 30000 });
}

/** Экран → функция, которая открывает его и возвращает имя снимка (или список снимков). */
const SCREENS = {
  home: async (page) => {
    await home(page);
    return 'home';
  },
  download: async (page) => {
    await page.goto(new URL('/download', base).href);
    await page.getByRole('heading').first().waitFor();
    return 'download';
  },
  prejoin: async (page) => {
    await home(page);
    await page.getByRole('button', { name: /Новая встреча/ }).click();
    await page.getByLabel('Ваше имя').waitFor();
    return 'prejoin';
  },
  settings: async (page, shoot) => {
    await home(page);
    await page
      .getByRole('button', { name: /Настройки/ })
      .first()
      .click();
    const tabs = page.getByRole('tab');
    await tabs.first().waitFor();
    for (let i = 0; i < (await tabs.count()); i++) {
      const tab = tabs.nth(i);
      const name = (await tab.innerText()).trim().toLowerCase().replace(/\s+/g, '-');
      await tab.click();
      await page.waitForTimeout(250);
      await shoot(`settings-${i}-${name}`);
    }
    return null;
  },
  meeting: async (page) => {
    await home(page);
    await page.getByRole('button', { name: /Новая встреча/ }).click();
    await page.getByLabel('Ваше имя').fill('Снимок');
    await page.getByRole('button', { name: 'Начать встречу' }).click();
    await connected(page);
    await page.waitForTimeout(800);
    return 'meeting';
  },
};

async function overflow(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const width = doc.clientWidth;
    const offenders = [];
    for (const element of document.querySelectorAll('body *')) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.right <= width + 1) continue;
      const style = getComputedStyle(element);
      if (style.position === 'fixed' && box.left >= width) continue;
      offenders.push({
        element:
          element.tagName.toLowerCase() +
          (element.className && typeof element.className === 'string'
            ? '.' + element.className.trim().split(/\s+/).join('.')
            : ''),
        right: Math.round(box.right),
      });
      if (offenders.length >= 8) break;
    }
    return { overflowX: doc.scrollWidth - width, offenders };
  });
}

mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const report = [];
for (const [screen, open] of Object.entries(SCREENS)) {
  if (only && !only.includes(screen)) continue;
  for (const theme of themes) {
    for (const width of widths) {
      const context = await browser.newContext({
        viewport: { width, height: height(width) },
        deviceScaleFactor: width < 768 ? 2 : 1,
        hasTouch: width < 768,
        isMobile: width < 768,
        permissions: ['camera', 'microphone'],
      });
      await context.addInitScript((value) => localStorage.setItem('cord:theme', value), theme);
      const page = await context.newPage();
      const shoot = async (name) => {
        const file = path.join(out, `${name}-${width}-${theme}.png`);
        await page.screenshot({ path: file });
        report.push({
          screen: name,
          width,
          theme,
          file: path.relative(out, file),
          ...(await overflow(page)),
        });
      };
      try {
        const name = await open(page, shoot);
        if (name) await shoot(name);
      } catch (error) {
        report.push({ screen, width, theme, error: String(error).split('\n')[0] });
      }
      await context.close();
    }
  }
}
await browser.close();
writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
const bad = report.filter((row) => row.error || row.overflowX > 0);
for (const row of bad)
  console.log(
    row.error
      ? `ОШИБКА ${row.screen} ${row.width} ${row.theme}: ${row.error}`
      : `ПЕРЕПОЛНЕНИЕ ${row.screen} ${row.width} ${row.theme}: +${row.overflowX}px ${JSON.stringify(row.offenders)}`,
  );
console.log(`${report.length} снимков в ${out}; с переполнением или ошибкой: ${bad.length}`);
