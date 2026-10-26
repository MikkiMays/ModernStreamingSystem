// Снимки музыки, витрины и аккаунтов для ревью 1.0.3 (W4: R31–R33, R39–R44, R112 музыки).
//
//   node scripts/music-shots.mjs --base https://cord.nikg.tech --tag before --out ../backlog/review-1.0.3/shots
//   CORD_STAND_DEV=127.0.0.1:5443 node scripts/stand-dev.mjs &        # невыкаченный веб под именем стенда
//   node scripts/music-shots.mjs --dev 127.0.0.1:5443 --tag after --out ../backlog/review-1.0.3/shots
//   node scripts/music-shots.mjs --scenes kit,accounts --widths 1440 --themes dark
//
// Сцены без встречи: kit — витрина и музыка на образцах страницы набора `/kit` (обложки подставные),
// accounts — «Аккаунты» в настройках главной с раскрытым входом Яндекс Музыки (R39). Сцена meeting —
// одна встреча на весь прогон (стенд пускает десять новых встреч в час с адреса): панель интеграций
// (R32, R33), музыка в панели (R44), игра под музыку с мини-плеером (R31). Музыку сцена включает
// настоящую и в конце убирает: бот из опустевшей комнаты с пустой очередью сам не уходит. Код встречи и
// ссылки — под маской, имена выдуманные.
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
const tag = args.tag ?? 'after';
const widths = (args.widths ?? '1440,390').split(',').map(Number);
const themes = (args.themes ?? 'light,dark').split(',');
const scenes = (args.scenes ?? 'kit,accounts').split(',');
const height = (width) => (width < 768 ? 844 : 900);
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

function cover(url) {
  const hue = [...url].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 80% 60%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360} 70% 30%)"/></linearGradient></defs><rect width="320" height="320" fill="url(#g)"/><circle cx="220" cy="110" r="70" fill="hsl(${(hue + 180) % 360} 90% 70% / 0.6)"/></svg>`;
}

async function person(width, theme = 'light') {
  const phone = width < 768;
  const ctx = await browser.newContext({
    viewport: { width, height: height(width) },
    deviceScaleFactor: phone ? 2 : 1,
    permissions: ['camera', 'microphone'],
    locale: 'ru-RU',
    ignoreHTTPSErrors: !!args.dev,
  });
  await ctx.addInitScript((value) => {
    localStorage.setItem(
      'cord:onboarding:v1',
      JSON.stringify({ tour: true, meeting: true, integrations: true }),
    );
    localStorage.setItem('cord:name', 'Майя');
    localStorage.setItem('cord:theme', value);
  }, theme);
  return ctx.newPage();
}

/** Снимок в каждой теме (или одной — у набора тема задаёт колонку); код встречи и ссылки — под маской. */
async function shoot(page, name, { target, only } = {}) {
  for (const theme of only ? [only] : themes) {
    if (!only) {
      await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
      await page.waitForTimeout(500);
    }
    const file = `${name}-${tag}-${page.viewportSize().width}-${theme}.png`;
    const mask = [page.locator('.meeting-header__code'), page.locator('input[readonly]')];
    await (target ?? page).screenshot({ path: path.join(out, file), mask });
    const overflowX = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    report.push({ name, tag, width: page.viewportSize().width, theme, file, overflowX });
    console.log('shot', file, `overflowX=${overflowX}`);
  }
}

async function home(page) {
  // Невыкаченный веб (`--dev`) в первый раз собирается на лету — дольше, чем отвечает стенд.
  await page.goto(base, { timeout: 180000 });
  await page.getByRole('button', { name: /Новая встреча/ }).waitFor({ timeout: 120000 });
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

/** Витрина и музыка набора: одна колонка темы страницы, рамки 320 и 400 px. */
async function kit(width) {
  for (const theme of themes) {
    const page = await person(width, theme);
    await page.route('**/api/v1/services/music/covers/**', (route) =>
      route.fulfill({ contentType: 'image/svg+xml', body: cover(route.request().url()) }),
    );
    await page.goto(new URL('/kit', base).href, { timeout: 180000 });
    const section = page.locator(`.kit__pane[data-theme='${theme}'] .kit-integrations`);
    await section.waitFor({ timeout: 120000 });
    await page.addStyleTag({ content: '.kit__bar { position: static !important; }' });
    await page.evaluate(() => document.fonts.ready);
    await section.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await shoot(page, 'r44-kit', { target: section, only: theme });
    // Зона своих файлов (R43): вкладка «Свои файлы» у плеера набора.
    const files = section.getByRole('tab', { name: 'Свои файлы' });
    if (await files.count()) {
      await files.first().click();
      await page.waitForTimeout(300);
      const zone = section.locator('.music-drop').first();
      await zone.scrollIntoViewIfNeeded();
      await shoot(page, 'r43-files', { target: zone.locator('xpath=..'), only: theme });
    }
    await page.context().close();
  }
}

/** «Аккаунты» в настройках главной, вход Яндекс Музыки раскрыт (R39, R33). */
async function accounts(width) {
  const page = await person(width);
  // Вход по QR-коду (R39) просит у службы код устройства: в снимке — подставной, Яндекс не трогаем.
  await page.route('**/api/v1/services/yandex/device**', (route) =>
    route.request().method() === 'DELETE'
      ? route.fulfill({ json: { cancelled: true } })
      : route.fulfill({
          json: {
            id: 'shot-device',
            userCode: 'K7QF-2M9D',
            verificationUrl: 'https://ya.ru/device',
            expiresAt: Date.now() + 300000,
            interval: 60,
            status: 'pending',
          },
        }),
  );
  await home(page);
  await openSettings(page);
  const nav = page.getByRole('navigation', { name: 'Разделы настроек' });
  await nav.getByRole('button', { name: 'Аккаунты', exact: true }).first().click();
  await page.waitForTimeout(600);
  await shoot(page, 'r39-accounts');
  await page
    .getByRole('button', { name: /^Подключить/ })
    .first()
    .click();
  await page.waitForTimeout(900);
  await shoot(page, 'r39-accounts-open');
  const token = page.getByRole('tab', { name: 'Токеном' });
  if (await token.count()) {
    await token.click();
    await page.getByText('Где взять токен').click();
    await page.waitForTimeout(400);
    await shoot(page, 'r39-accounts-token');
  }
  await page.context().close();
}

/** Шаг сцены встречи: упал — в отчёт и дальше, встреча на стенде одна на прогон. */
async function step(name, work) {
  try {
    await work();
  } catch (error) {
    console.log('step failed', name, String(error).split('\n')[0]);
    report.push({ name, tag, failed: String(error).split('\n')[0] });
  }
}

// Короткие ролики, которые площадка отдаёт анонимно: трек для «Сейчас играет» и второй — для очереди.
const TRACKS = ['https://www.youtube.com/watch?v=jNQXAC9IVRw', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'];

async function openPanel(page) {
  if (await page.locator('.services-panel').count()) return;
  const direct = page.getByRole('button', { name: 'Интеграции', exact: true });
  if (await direct.isVisible()) await direct.click();
  else {
    await page.getByRole('button', { name: 'Настройки и действия' }).click();
    await page.getByRole('menuitem', { name: /Интеграции/ }).click();
  }
  await page.locator('.services-panel').waitFor();
  await page.waitForTimeout(500);
}

async function closePanel(page) {
  // Крестик панели — последняя кнопка её заголовка.
  const close = page.locator('.side-panel .panel-heading button');
  if (await close.count()) await close.last().click();
  await page.waitForTimeout(800);
}

async function shelf(page) {
  const back = page.locator('.services-panel .music-panel__back, .services-panel .platform-picker__back');
  if (await back.count()) await back.first().click();
  await page.waitForTimeout(400);
}

/** Одна встреча: панель (R32, R33), музыка в панели (R44), игра под музыку (R31), предложение музыки. */
async function meeting() {
  const desk = widths.find((width) => width >= 768) ?? 1440;
  const phone = widths.find((width) => width < 768);
  const page = await person(desk);
  await home(page);
  await page.getByRole('button', { name: /Новая встреча/ }).click();
  await page.getByLabel('Ваше имя').fill('Майя');
  await page.getByRole('button', { name: 'Начать встречу' }).click();
  await page.locator('[data-media-status="connected"]').waitFor({ timeout: 90000 });
  await page.waitForTimeout(1500);
  try {
    await step('panel', async () => {
      await openPanel(page);
      await shoot(page, 'r32-panel');
    });
    await step('music-entry', async () => {
      await page
        .locator('.service-group')
        .filter({ has: page.locator('b', { hasText: /^Музыка$/ }) })
        .click();
      await page.waitForTimeout(800);
      await shoot(page, 'r44-entry');
    });
    await step('music-on', async () => {
      // Прежняя сборка сначала просит площадку.
      const tile = page.locator('.music-picker .service-tile').filter({ hasText: 'YouTube' });
      if (await tile.count()) await tile.click();
      await page.getByRole('button', { name: 'Добавить во встречу' }).click();
      await page.getByRole('searchbox').waitFor({ timeout: 90000 });
      for (const url of TRACKS) {
        const field = page.getByRole('searchbox');
        await field.fill(url);
        await field.press('Enter');
        await page.locator('.music-search__notice').waitFor({ timeout: 120000 });
      }
      await page.getByRole('button', { name: 'Повторять очередь' }).click();
      await page.waitForTimeout(4000);
      await shoot(page, 'r44-player');
    });
    await step('game', async () => {
      await shelf(page);
      await page
        .locator('.service-group')
        .filter({ has: page.locator('b', { hasText: /^Игры$/ }) })
        .click();
      await page
        .getByRole('button', { name: /^Покер/ })
        .first()
        .click();
      await page.getByRole('button', { name: 'Открыть стол' }).click();
      await page.waitForTimeout(2500);
      await closePanel(page);
      await page.waitForTimeout(1500);
      await shoot(page, 'r31-game');
    });
    await step('widget', async () => {
      // Виджет открывает сам трек мини-плеера (R128), шеврона больше нет.
      const open = page.locator('.music-mini__track');
      if (!(await open.count())) return;
      await open.click();
      await page.getByRole('dialog', { name: 'Музыка' }).waitFor();
      await page.waitForTimeout(800);
      await shoot(page, 'r31-widget');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    });
    if (phone)
      await step('phone', async () => {
        await page.setViewportSize({ width: phone, height: height(phone) });
        await page.waitForTimeout(1200);
        await shoot(page, 'r31-game');
        const open = page.locator('.music-mini__track');
        if (await open.count()) {
          await open.click();
          await page.getByRole('dialog', { name: 'Музыка' }).waitFor();
          await page.waitForTimeout(1000);
          await shoot(page, 'r31-widget');
          await page.keyboard.press('Escape');
          await page.waitForTimeout(600);
        }
        await openPanel(page);
        await page
          .locator('.service-group')
          .filter({ has: page.locator('b', { hasText: /^Музыка$/ }) })
          .click();
        await page.waitForTimeout(800);
        await shoot(page, 'r44-player');
        await shelf(page);
        await closePanel(page);
        await page.setViewportSize({ width: desk, height: height(desk) });
        await page.waitForTimeout(800);
      });
  } finally {
    await step('cleanup', async () => {
      // Бот музыки из опустевшей комнаты с очередью сам не уходит — убираем его до выхода.
      await openPanel(page);
      await page
        .locator('.service-group')
        .filter({ has: page.locator('b', { hasText: /^Музыка$/ }) })
        .click();
      await page.getByRole('button', { name: 'Ещё действия с музыкой' }).click();
      await page.getByRole('menuitem', { name: 'Убрать музыку из встречи' }).click();
      await page.waitForTimeout(3000);
      await shelf(page);
      await closePanel(page);
      await page.waitForTimeout(1500);
      // Игра идёт, музыки нет — предложение её включить (R31).
      await shoot(page, 'r31-offer');
    });
    await step('leave', async () => {
      await page.getByRole('button', { name: 'Выйти из встречи' }).click();
      await page.waitForTimeout(1500);
    });
    await page.context().close();
  }
}

try {
  for (const width of widths) {
    if (scenes.includes('kit')) await kit(width);
    if (scenes.includes('accounts')) await accounts(width);
  }
  if (scenes.includes('meeting')) await meeting();
} finally {
  writeFileSync(path.join(out, `music-shots-${tag}.json`), JSON.stringify(report, null, 2));
  await browser.close();
}
