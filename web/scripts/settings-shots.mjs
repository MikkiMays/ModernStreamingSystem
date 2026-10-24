// Снимки окон настроек, диагностики и помощи для ревью 1.0.3 (R114, R115, R50, R47–R49, R53–R56, X4).
//
//   node scripts/settings-shots.mjs --base https://cord.nikg.tech --tag before --out ../backlog/review-1.0.3/shots
//   CORD_STAND_DEV=127.0.0.1:5447 node scripts/stand-dev.mjs &        # невыкаченный веб под именем стенда
//   node scripts/settings-shots.mjs --dev 127.0.0.1:5447 --tag after --out ../backlog/review-1.0.3/shots
//   node scripts/settings-shots.mjs --scenes settings,about --widths 1440 --themes dark
//
// Сцены главной — без встречи: settings (дерево разделов, R114), spy (подсветка у дна и без прокрутки,
// R115), about («О программе», R50), prejoin (переключатель интеграций, X4), support (переключатель
// «Приложить диагностику», X4). Сцена meeting — одна встреча на весь прогон (стенд пускает десять новых
// встреч в час с адреса): диагностика (R47, R48), «Помощь» из неё (R49), настройки встречи (R53–R56).
// Ширина и тема меняются у той же страницы. Код встречи и ссылки — под маской, имена выдуманные.
import { chromium } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]]);
    return pairs;
  }, []),
);
const base = args.base ?? process.env.PLAYWRIGHT_BASE_URL ?? 'https://cord.nikg.tech';
const out = path.resolve(args.out ?? 'shots');
const tag = args.tag ?? 'after';
const widths = (args.widths ?? '1440,390').split(',').map(Number);
const themes = (args.themes ?? 'light,dark').split(',');
const scenes = (args.scenes ?? 'settings,spy,about,prejoin,support,meeting').split(',');
const height = (width) => (width < 768 ? 844 : 900);
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

async function person(width) {
  const phone = width < 768;
  const ctx = await browser.newContext({
    viewport: { width, height: height(width) },
    deviceScaleFactor: phone ? 2 : 1,
    permissions: ['camera', 'microphone'],
    locale: 'ru-RU',
    ignoreHTTPSErrors: !!args.dev,
  });
  await ctx.addInitScript(() => {
    localStorage.setItem(
      'cord:onboarding:v1',
      JSON.stringify({ tour: true, meeting: true, integrations: true }),
    );
    localStorage.setItem('cord:name', 'Майя');
  });
  return ctx.newPage();
}

/** Снимок в каждой теме; код встречи и ссылки — под маской. */
async function shoot(page, name) {
  for (const theme of themes) {
    await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
    await page.waitForTimeout(500);
    const file = `${name}-${tag}-${page.viewportSize().width}-${theme}.png`;
    const mask = [page.locator('.meeting-header__code'), page.locator('input[readonly]')];
    await page.screenshot({ path: path.join(out, file), mask });
    const overflowX = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    const dialogs = await page.getByRole('dialog').count();
    report.push({ name, tag, width: page.viewportSize().width, theme, file, overflowX, dialogs });
    console.log('shot', file, `overflowX=${overflowX}`, `dialogs=${dialogs}`);
  }
}

async function home(page) {
  await page.goto(base);
  await page.getByRole('button', { name: /Новая встреча/ }).waitFor({ timeout: 30000 });
}

async function openSettings(page) {
  await page
    .getByRole('button', { name: 'Открыть меню' })
    .click({ timeout: 1500 })
    .catch(() => {});
  await page
    .getByRole('button', { name: 'Настройки', exact: true })
    .filter({ visible: true })
    .first()
    .click();
  await page.getByRole('dialog', { name: 'Настройки' }).waitFor();
  await page.waitForTimeout(600);
}
const nav = (page) => page.getByRole('navigation', { name: 'Разделы настроек' });
const section = (page, name) => nav(page).getByRole('button', { name, exact: true }).first();

try {
  for (const width of widths) {
    const phone = width < 768;
    if (scenes.includes('settings')) {
      // R114: дерево разделов, раздел звука открыт (на телефоне — список разделов).
      const page = await person(width);
      await home(page);
      await openSettings(page);
      await shoot(page, 'r114-settings');
      await page.context().close();
    }
    if (scenes.includes('spy') && !phone) {
      // R115: низкое окно — «Видео» прокручено до дна; высокое — «Динамики» выбраны щелчком, колесо.
      const page = await person(width);
      await page.setViewportSize({ width, height: 560 });
      await home(page);
      await openSettings(page);
      await section(page, 'Видео').click();
      await page.locator('.settings-content').hover();
      await page.mouse.wheel(0, 2000);
      await page.waitForTimeout(900);
      await shoot(page, 'r115-bottom');
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(400);
      await nav(page)
        .getByRole('button', { name: /^(Звук|Микрофон)$/ })
        .first()
        .click();
      await nav(page)
        .getByRole('list', { name: /Подразделы/ })
        .getByRole('button', { name: 'Динамики' })
        .click();
      await page.locator('.settings-content').hover();
      await page.mouse.wheel(0, 600);
      await page.waitForTimeout(900);
      await shoot(page, 'r115-fits');
      await page.context().close();
    }
    if (scenes.includes('about')) {
      const page = await person(width);
      await home(page);
      await openSettings(page);
      await section(page, 'О программе').click();
      await page.waitForTimeout(1500);
      await shoot(page, 'r50-about');
      await page.context().close();
    }
    if (scenes.includes('prejoin')) {
      // X4: «Разрешить интеграции всем участникам» на предвходе (встреча не создаётся).
      const page = await person(width);
      await home(page);
      await page.getByRole('button', { name: /Новая встреча/ }).click();
      await page.getByLabel('Ваше имя').waitFor();
      await page.getByText('Разрешить интеграции всем участникам').scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
      await shoot(page, 'r55-prejoin');
      await page.context().close();
    }
    if (scenes.includes('support')) {
      // X4: «Приложить диагностику» в обращении — окно «Помощь» на главной.
      const page = await person(width);
      await home(page);
      await page.getByRole('button', { name: 'Помощь' }).filter({ visible: true }).first().click();
      const help = page.getByRole('dialog', { name: 'Помощь' });
      await help.getByText('Приложить диагностику').scrollIntoViewIfNeeded();
      await page.waitForTimeout(600);
      await shoot(page, 'r55-support');
      await page.context().close();
    }
  }

  if (scenes.includes('meeting')) {
    const desk = widths.find((width) => width >= 768) ?? 1440;
    const page = await person(desk);
    await home(page);
    await page.getByRole('button', { name: /Новая встреча/ }).click();
    await page.getByLabel('Ваше имя').fill('Майя');
    await page.getByRole('button', { name: 'Начать встречу' }).click();
    await page.locator('[data-media-status="connected"]').waitFor({ timeout: 45000 });
    // Микрофон и камера — поддельные Chromium: в «Подробностях» появятся свои дорожки.
    for (const name of ['Включить микрофон', 'Включить камеру']) {
      const button = page.getByRole('button', { name, exact: true });
      if (await button.isVisible()) await button.click();
    }
    await page.waitForTimeout(3000);
    const more = async () => {
      await page.mouse.move(20, 300);
      await page.getByRole('button', { name: 'Настройки и действия' }).click();
    };
    for (const width of widths) {
      await page.setViewportSize({ width, height: height(width) });
      await page.waitForTimeout(800);
      // R47, R48: диагностика сверху и у «Подробностей аудио и видео».
      await more();
      await page.getByRole('menuitem', { name: /^Диагностика/ }).click();
      const diagnostics = page.getByRole('dialog', { name: 'Диагностика' });
      await diagnostics.waitFor();
      await page.waitForTimeout(2500);
      await shoot(page, 'r47-diagnostics');
      await diagnostics.getByText('Подробности аудио и видео').scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
      await shoot(page, 'r48-details');
      // R49: «Помощь» из диагностики — до: под диагностикой; после: одна помощь, форма доступна.
      await diagnostics.getByRole('button', { name: 'Помощь' }).last().click();
      const help = page.getByRole('dialog', { name: 'Помощь' });
      await help.getByRole('textbox', { name: 'Что случилось' }).waitFor();
      await page.waitForTimeout(800);
      await shoot(page, 'r49-help');
      // До правки помощь лежала под диагностикой: закрыть обе, сколько бы их ни было.
      for (let tries = 0; tries < 3 && (await page.getByRole('dialog').count()); tries++) {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
      }
      // R53–R56: настройки встречи (организатор).
      await more();
      await page.getByRole('menuitem', { name: 'Настройки встречи' }).click();
      await page.getByRole('dialog', { name: 'Настройки встречи' }).waitFor();
      await page.waitForTimeout(600);
      await shoot(page, 'r53-meeting-settings');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
    }
    await page
      .getByRole('button', { name: 'Выйти из встречи' })
      .click()
      .catch(() => {});
    await page.context().close();
  }
} finally {
  // Отчёт дописывается: сцены главной и встреча снимаются разными прогонами (встреч в час мало).
  const file = path.join(out, `settings-shots-${tag}.json`);
  const earlier = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  const fresh = new Set(report.map((shot) => shot.file));
  writeFileSync(
    file,
    JSON.stringify([...earlier.filter((shot) => !fresh.has(shot.file)), ...report], null, 2),
  );
  await browser.close();
}
