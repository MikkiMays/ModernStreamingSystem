// Снимки главной и избранного для ревью 1.0.3 (R65, R70, R71, R86) и меню камеры (R35, R36).
//
//   node scripts/home-shots.mjs --base https://cord.nikg.tech --tag before --out ../backlog/review-1.0.3/shots
//   CORD_STAND_DEV=127.0.0.1:5453 node scripts/stand-dev.mjs &        # невыкаченный веб под именем стенда
//   node scripts/home-shots.mjs --dev 127.0.0.1:5453 --tag after --out ../backlog/review-1.0.3/shots
//   node scripts/home-shots.mjs --dev 127.0.0.1:5453 --scenes camera --out ../backlog/review-1.0.3/shots
//
// Сцены главной — без встречи: избранное подставляется ответом ядра (`page.route`), комнаты, группы и
// коды выдуманы. home — главная целиком (R65); rows — список избранного, строка под указателем и на
// касании (R71, R86); menu — меню комнаты после щелчка по «Автоподключению» (R70).
//
// Сцена camera — одна встреча на оба снимка (стенд пускает десять новых встреч в час с адреса):
// выкаченный веб создаёт встречу и снимает подменю «Камера» (было), невыкаченный (`--dev`) входит в неё
// по приглашению и снимает то же подменю и плитку телефона (стало). Поддельная камера Chromium зума не
// умеет — для «стало» `getCapabilities` дополняется диапазоном зума 1…4, как у камеры телефона.
// Код встречи и ссылки — под маской.
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
const scenes = (args.scenes ?? 'home,desktop,low,rows,menu').split(',');
const height = (width) => (width < 768 ? 844 : 900);
mkdirSync(out, { recursive: true });

const launch = (dev) =>
  chromium.launch({
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      ...(dev
        ? [`--host-resolver-rules=MAP ${new URL(base).hostname}:443 ${dev}`, '--ignore-certificate-errors']
        : []),
    ],
  });
const browser = await launch(args.dev);
const report = [];

const GROUPS = [
  { id: '00000000-0000-4000-8000-0000000000a1', title: 'Семья' },
  { id: '00000000-0000-4000-8000-0000000000a2', title: 'Работа' },
];
/** Выдуманное избранное: закреплённая без группы, закреплённая из «Семьи» (R86), группы и общий список. */
const ROOMS = [
  ['Команда', null, true],
  ['Ужин по пятницам', GROUPS[0].id, true],
  ['Семейный чат', GROUPS[0].id, false],
  ['Дейли', GROUPS[1].id, false],
  ['Покер по средам', null, false],
].map(([title, groupId, pinned], index) => ({
  roomId: `00000000-0000-4000-8000-00000000000${index + 1}`,
  title,
  code: `00000000${index + 1}`,
  savedAt: 1,
  closed: false,
  canJoin: true,
  groupId,
  pinned,
  alias: null,
}));

async function person(browserToUse, width, extra = {}) {
  const phone = width < 768;
  const ctx = await browserToUse.newContext({
    viewport: { width, height: height(width) },
    deviceScaleFactor: phone ? 2 : 1,
    permissions: ['camera', 'microphone'],
    locale: 'ru-RU',
    ignoreHTTPSErrors: true,
    ...extra,
  });
  await ctx.addInitScript(() => {
    localStorage.setItem(
      'cord:onboarding:v1',
      JSON.stringify({ tour: true, meeting: true, integrations: true }),
    );
    localStorage.setItem('cord:name', 'Майя');
    localStorage.setItem('cord:autojoin:v1', '[]');
  });
  return ctx.newPage();
}

/** Ответы ядра про избранное — выдуманный список, изменения настроек принимаются молча. */
async function favorites(page) {
  await page.route('**/api/v1/favorites', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: ROOMS }) : route.fulfill({ status: 204 }),
  );
  await page.route('**/api/v1/favorites/groups', (route) => route.fulfill({ json: GROUPS }));
  await page.route('**/api/v1/favorites/*/settings', (route) => route.fulfill({ status: 204 }));
}

/** Снимок в каждой теме; код встречи и ссылки — под маской. */
async function shoot(page, name, { target, suffix = tag } = {}) {
  for (const theme of themes) {
    await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
    await page.waitForTimeout(500);
    const file = `${name}-${suffix}-${page.viewportSize().width}-${theme}.png`;
    const mask = [page.locator('.meeting-header__code'), page.locator('input[readonly]')];
    if (target) await target.screenshot({ path: path.join(out, file), mask });
    else await page.screenshot({ path: path.join(out, file), mask });
    const overflowX = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    report.push({ name, tag: suffix, width: page.viewportSize().width, theme, file, overflowX });
    console.log('shot', file, `overflowX=${overflowX}`);
  }
}

async function home(page) {
  await favorites(page);
  await page.goto(base);
  await page.getByRole('button', { name: /Новая встреча/ }).waitFor({ timeout: 30000 });
  await page.waitForTimeout(800);
}

/** Список избранного: на широком — панель слева, на телефоне — выдвижная панель под бургером. */
async function nav(page) {
  const burger = page.getByRole('button', { name: 'Открыть меню' });
  if (await burger.isVisible()) {
    await burger.click();
    await page.getByRole('dialog', { name: 'Меню' }).waitFor();
    await page.waitForTimeout(500);
  }
  const list = page.getByRole('navigation', { name: 'Избранное' });
  await list.getByRole('button', { name: /^Команда/ }).waitFor();
  return list;
}

try {
  for (const width of widths) {
    const phone = width < 768;
    // На телефоне — касание: кнопки строк видны всегда, меню открывается «…».
    const touch = phone ? { isMobile: true, hasTouch: true } : {};
    if (scenes.includes('home')) {
      const page = await person(browser, width, touch);
      await home(page);
      await shoot(page, 'r65-home');
      await page.context().close();
    }
    if (scenes.includes('rows')) {
      const page = await person(browser, width, touch);
      await home(page);
      const list = await nav(page);
      if (!phone) await list.getByRole('button', { name: /^Семейный чат/ }).hover();
      await page.waitForTimeout(400);
      const panel = phone ? page.getByRole('dialog', { name: 'Меню' }) : page.locator('.home-nav');
      await shoot(page, 'r71-rows', { target: panel });
      await page.mouse.move(width - 10, 10);
      await page.waitForTimeout(400);
      await shoot(page, 'r86-groups', { target: panel });
      await page.context().close();
    }
    if (scenes.includes('menu')) {
      const page = await person(browser, width, touch);
      await home(page);
      const list = await nav(page);
      const open = () => list.getByRole('button', { name: 'Действия с «Покер по средам»' }).click();
      await list.getByRole('button', { name: /^Покер по средам/ }).hover();
      await open();
      const item = page.getByRole('menuitemcheckbox', { name: 'Автоподключение' });
      await item.click();
      await page.waitForTimeout(400);
      // Было: меню закрывалось после щелчка — открываем снова, чтобы видеть состояние.
      if (!(await item.isVisible())) await open();
      await item.waitFor();
      await page.waitForTimeout(400);
      await shoot(page, 'r70-menu');
      await page.context().close();
    }
  }

  if (scenes.includes('desktop')) {
    // Клиент Windows (WinUI): вход без боковой панели, избранное — в его панели (`DesktopHome`).
    for (const [width, h] of [
      [1120, 740],
      [760, 620],
      [360, 430],
    ]) {
      const page = await person(browser, width);
      await page.setViewportSize({ width, height: h });
      await page.addInitScript(() => {
        window.chrome = {
          ...window.chrome,
          webview: { postMessage: () => {}, addEventListener: () => {}, removeEventListener: () => {} },
        };
      });
      await home(page);
      await shoot(page, `r65-desktop-${h}`);
      await page.context().close();
    }
  }
  if (scenes.includes('low')) {
    // Низкие окна клиента Windows на Electron и ноутбука: та же главная с панелью (R65).
    for (const [width, h] of [
      [720, 480],
      [1280, 600],
    ]) {
      const page = await person(browser, width);
      await page.setViewportSize({ width, height: h });
      await home(page);
      await shoot(page, `r65-low-${h}`);
      await page.context().close();
    }
  }

  if (scenes.includes('camera')) {
    if (!args.dev) throw new Error('сцена camera снимает «было» и «стало» сразу: нужен --dev');
    const deployed = await launch(undefined);
    const zoomed = await launch(args.dev);
    try {
      const host = await person(deployed, 1440);
      await host.goto(base);
      await host.getByRole('button', { name: /Новая встреча/ }).click();
      await host.getByLabel('Ваше имя').fill('Майя');
      await host.getByRole('button', { name: 'Начать встречу' }).click();
      await host
        .locator('[data-media-status="connected"]')
        .waitFor({ timeout: 45000 })
        .catch(async (error) => {
          // Отказ стенда (например, «Слишком много новых встреч за час») — словами, а не тайм-аутом.
          await host.screenshot({ path: path.join(out, 'camera-failed.png') });
          console.error((await host.locator('body').innerText()).slice(0, 600));
          throw error;
        });
      await host.getByRole('button', { name: 'Пригласить участников', exact: true }).click();
      const invitation = await host.getByRole('textbox', { name: 'Ссылка приглашения' }).inputValue();
      await host.getByRole('button', { name: 'Закрыть', exact: true }).click();

      const cameraOn = async (page) => {
        const button = page.getByRole('button', { name: 'Включить камеру', exact: true });
        if (await button.isVisible()) await button.click();
        await page.waitForTimeout(2500);
      };
      const submenu = async (page, name, suffix) => {
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: height(width) });
          await page.waitForTimeout(800);
          await page.mouse.move(20, 300);
          await page.getByRole('button', { name: 'Настройки и действия' }).click();
          await page.getByRole('menuitem', { name: 'Камера' }).hover();
          await page.waitForTimeout(900);
          await shoot(page, name, { suffix });
          await page.keyboard.press('Escape');
          await page.keyboard.press('Escape');
        }
      };
      await cameraOn(host);
      await submenu(host, 'r35-camera-menu', 'before');

      // Стало: тот же человек входит в ту же встречу невыкаченным вебом; у камеры есть зум 1…4.
      const zoom = () => {
        const capabilities = MediaStreamTrack.prototype.getCapabilities;
        const settings = MediaStreamTrack.prototype.getSettings;
        const apply = MediaStreamTrack.prototype.applyConstraints;
        const values = new WeakMap();
        MediaStreamTrack.prototype.getCapabilities = function () {
          const own = capabilities.call(this);
          return this.kind === 'video' && !/screen|window|tab/i.test(this.label)
            ? { ...own, zoom: { min: 1, max: 4, step: 0.1 } }
            : own;
        };
        MediaStreamTrack.prototype.getSettings = function () {
          const own = settings.call(this);
          return this.kind === 'video' ? { ...own, zoom: values.get(this) ?? 1 } : own;
        };
        MediaStreamTrack.prototype.applyConstraints = function (constraints) {
          const value = constraints?.advanced?.find((set) => 'zoom' in set)?.zoom;
          if (typeof value === 'number') values.set(this, value);
          return apply.call(this, { ...constraints, advanced: [] });
        };
      };
      const join = async (page, withZoom) => {
        if (withZoom) await page.addInitScript(zoom);
        await page.goto(invitation);
        await page.getByLabel('Ваше имя').fill('Майя');
        await page.getByRole('button', { name: 'Войти во встречу' }).click();
        await page.locator('[data-media-status="connected"]').waitFor({ timeout: 45000 });
        await cameraOn(page);
      };
      const desk = await person(zoomed, 1440);
      await join(desk, true);
      await submenu(desk, 'r35-r36-camera-menu', 'after');
      await desk.context().close();

      // Своя плитка на телефоне: было — без контрола (у поддельной камеры одна линза), стало — зум.
      for (const [browserToUse, suffix] of [
        [deployed, 'before'],
        [zoomed, 'after'],
      ]) {
        const phone = await person(browserToUse, 390, { isMobile: true, hasTouch: true });
        await join(phone, suffix === 'after');
        if (suffix === 'after') {
          const tile = phone.locator('.person-tile:has(.lens-switch)').first();
          await tile.waitFor({ timeout: 10000 });
          await tile.getByRole('radio', { name: '2×' }).click();
          await phone.waitForTimeout(600);
        }
        await shoot(phone, 'r36-tile', { suffix });
        await phone.context().close();
      }
      await host.context().close();
    } finally {
      await deployed.close();
      await zoomed.close();
    }
  }
} finally {
  writeFileSync(path.join(out, `home-shots-${tag}.json`), JSON.stringify(report, null, 2));
  await browser.close();
}
