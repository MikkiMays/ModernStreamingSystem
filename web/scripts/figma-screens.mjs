#!/usr/bin/env node
// Снимки «как есть» для Figma (E15-A, T57): каждый экран и состояние Cord на 360 / 1024 / 1440 в
// обеих темах — PNG и manifest.json с размером кадра, по которому строятся фреймы в Figma.
//
//   node scripts/figma-screens.mjs                       — всё в ../backlog/screens/figma
//   node scripts/figma-screens.mjs --only home,connect-password --widths 360 --themes dark
//   node scripts/figma-screens.mjs --list                — перечень состояний и групп
//   node scripts/figma-screens.mjs --tree [--tree-only]   — ещё и структура страницы в <id>-<ширина>-<тема>.json
//
// Одиночные состояния открываются в своём контексте на каждую ширину и тему. Сценарии со многими
// участниками (сетка, демонстрация, кинозал, игры) собирают встречу один раз: настольный зритель
// снимается на 1024 и 1440 сменой окна, телефонный — отдельным контекстом с касанием; тема
// меняется атрибутом `data-theme` без перезагрузки — так её держит само приложение.
// Данных, которых нет на стенде (десять комнат в избранном), подставляет `page.route`: интерфейс
// при этом настоящий. Скрипт лежит в web/, потому что `@playwright/test` резолвится от файла.
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeCamera } from './fake-camera.mjs';
import { domToSvg, auditPage } from './dom-svg.mjs';

/** Чужие картинки без CORS страница в SVG не впишет — их скачивает Node и вставляет data-URL. */
async function inlineRemoteImages(page, svg) {
  // Картинка-SVG (знак в оболочке, значки в /assets) — векторной группой, а не растром: Figma
  // вложенный SVG в <image> не раскрывает.
  const vectors = [
    ...svg.matchAll(
      /<image id="([^"]*)" x="([\d.-]+)" y="([\d.-]+)" width="([\d.]+)" height="([\d.]+)" preserveAspectRatio="[^"]*" href="((?:file|https?):[^"]+?\.svg(?:\?[^"]*)?)"\/>/g,
    ),
  ];
  for (const [tag, name, x, y, w, h, href] of vectors) {
    try {
      const text = href.startsWith('file:')
        ? readFileSync(new URL(href), 'utf8')
        : await (await page.request.get(href.replace(/&amp;/g, '&'), { timeout: 10000 })).text();
      const vb = /viewBox="([\d.\s-]+)"/.exec(text)?.[1].trim().split(/\s+/).map(Number) ?? [
        0,
        0,
        Number(w),
        Number(h),
      ];
      const inner = text.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
      const s = Math.min(Number(w) / vb[2], Number(h) / vb[3]);
      const tx = Number(x) + (Number(w) - vb[2] * s) / 2 - vb[0] * s;
      const ty = Number(y) + (Number(h) - vb[3] * s) / 2 - vb[1] * s;
      svg = svg.split(tag).join(`<g id="${name}" transform="matrix(${s} 0 0 ${s} ${tx} ${ty})">${inner}</g>`);
    } catch {
      /* останется ссылкой */
    }
  }
  const urls = [
    ...new Set([...svg.matchAll(/href="(https?:[^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'))),
  ];
  for (const url of urls) {
    try {
      const response = await page.request.get(url, { timeout: 10000 });
      if (!response.ok()) continue;
      const type = response.headers()['content-type']?.split(';')[0] || 'image/png';
      if (!type.startsWith('image/')) continue;
      const data = `data:${type};base64,${(await response.body()).toString('base64')}`;
      svg = svg.split(`href="${url.replace(/&/g, '&amp;')}"`).join(`href="${data}"`);
    } catch {
      /* картинка останется ссылкой — Figma покажет пустой прямоугольник */
    }
  }
  return svg;
}

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (value.startsWith('--'))
      pairs.push([
        value.slice(2),
        all[index + 1] && !all[index + 1].startsWith('--') ? all[index + 1] : 'true',
      ]);
    return pairs;
  }, []),
);
const base = args.base ?? process.env.PLAYWRIGHT_BASE_URL ?? 'https://cord.nikg.tech';
const out = path.resolve(args.out ?? '../backlog/screens/figma');
const WIDTHS = (args.widths ?? '360,1024,1440').split(',').map(Number);
const THEMES = (args.themes ?? 'light,dark').split(',');
const only = args.only?.split(',');
const VIEW = { 360: 780, 1024: 768, 1440: 900 };
const mobile = (width) => width < 768;
const api = (p) => new URL(`/api/v1${p}`, base).href;

// ---------------------------------------------------------------------------------------------
// Манифест: одна строка на снимок, перезапуск части состояний обновляет только их строки.

const manifestFile = path.join(out, 'manifest.json');
mkdirSync(out, { recursive: true });
const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : [];
function record(entry) {
  const at = manifest.findIndex(
    (e) => e.id === entry.id && e.width === entry.width && e.theme === entry.theme,
  );
  if (at >= 0) manifest[at] = entry;
  else manifest.push(entry);
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 1));
}

// ---------------------------------------------------------------------------------------------
// Браузер и контексты.

// Камера — спокойный силуэт (`fake-camera.mjs`), а не зелёная таблица Chromium; `--camera off` — таблица.
const camera = args.camera ?? path.join(os.tmpdir(), 'cord-camera.y4m');
if (camera !== 'off' && !existsSync(camera)) await writeCamera(camera);
const browser = await chromium.launch({
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--auto-select-desktop-capture-source=Entire screen',
    '--autoplay-policy=no-user-gesture-required',
    ...(camera !== 'off' ? [`--use-file-for-fake-video-capture=${camera}`] : []),
  ],
});

async function newContext(
  width,
  theme,
  { name = 'Ника', storage, userAgent, height, desktop, permissions } = {},
) {
  // `desktop` — окно оболочки (Electron) узкой ширины: без касания и мобильного масштаба.
  const phone = mobile(width) && !desktop;
  const context = await browser.newContext({
    viewport: { width, height: height ?? VIEW[width] ?? 900 },
    deviceScaleFactor: phone ? 2 : 1,
    hasTouch: phone,
    isMobile: phone,
    ...(userAgent ? { userAgent } : {}),
    colorScheme: theme,
    locale: 'ru-RU',
    permissions: permissions ?? ['camera', 'microphone', 'clipboard-read', 'clipboard-write'],
    // Рабочий sw.js отдаёт /assets/ и навигации сам — подмены `page.route` его бы не видели.
    serviceWorkers: 'block',
  });
  await context.addInitScript(
    ([t, n, s]) => {
      try {
        if (!localStorage.getItem('cord:theme')) localStorage.setItem('cord:theme', t);
        if (n && !localStorage.getItem('cord:name')) localStorage.setItem('cord:name', n);
        if (s)
          for (const [k, v] of Object.entries(s)) if (!localStorage.getItem(k)) localStorage.setItem(k, v);
      } catch {
        /* хранилище недоступно — приложение возьмёт умолчания */
      }
    },
    [theme, name, storage ?? null],
  );
  context.setDefaultTimeout(60000);
  return context;
}

/** Тема без перезагрузки: приложение держит её атрибутом `data-theme` на `<html>`. */
async function setTheme(page, theme) {
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
    try {
      localStorage.setItem('cord:theme', t);
    } catch {
      /* только вид */
    }
  }, theme);
  await page.emulateMedia({ colorScheme: theme });
  await page.waitForTimeout(300);
}

/**
 * Структура страницы для будущих слоёв (E15 этап A2 → B): дерево видимых элементов с рамкой,
 * вычисленными стилями, текстом и разметкой значков. Плагин или `use_figma` строит из него
 * настоящие фреймы вместо картинки.
 */
function pageTree() {
  const PICK = [
    'display',
    'position',
    'flexDirection',
    'flexWrap',
    'alignItems',
    'justifyContent',
    'gap',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'backgroundColor',
    'backgroundImage',
    'color',
    'fontFamily',
    'fontSize',
    'fontWeight',
    'lineHeight',
    'letterSpacing',
    'textAlign',
    'textTransform',
    'borderTopLeftRadius',
    'borderTopRightRadius',
    'borderBottomLeftRadius',
    'borderBottomRightRadius',
    'borderTopWidth',
    'borderTopColor',
    'borderBottomWidth',
    'borderBottomColor',
    'boxShadow',
    'opacity',
    'zIndex',
    'overflow',
    'objectFit',
  ];
  const DEFAULT = new Set([
    'none',
    'normal',
    '0px',
    'rgba(0, 0, 0, 0)',
    'auto',
    'static',
    'visible',
    'start',
    'nowrap',
    '1',
    'row',
  ]);
  let count = 0;
  const walk = (el) => {
    if (count >= 5000) return null;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 1 && r.height < 1 && !el.children.length) return null;
    count++;
    const node = {
      tag: el.tagName.toLowerCase(),
      box: [r.x + scrollX, r.y + scrollY, r.width, r.height].map((v) => Math.round(v)),
    };
    if (typeof el.className === 'string' && el.className.trim()) node.cls = el.className.trim();
    for (const a of ['role', 'aria-label', 'data-theme', 'data-layout'])
      if (el.getAttribute(a)) (node.attr ??= {})[a] = el.getAttribute(a);
    const style = {};
    for (const k of PICK) if (cs[k] && !DEFAULT.has(cs[k])) style[k] = cs[k];
    node.style = style;
    const text = [...el.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim())
      .filter(Boolean)
      .join(' ');
    if (text) node.text = text;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') node.value = el.value || el.placeholder || '';
    if (el.tagName === 'IMG') node.src = (el.currentSrc || el.src || '').slice(0, 300);
    if (el.tagName.toLowerCase() === 'svg') {
      node.svg = el.outerHTML.slice(0, 6000);
      return node;
    }
    if (['VIDEO', 'CANVAS', 'IFRAME'].includes(el.tagName)) return node;
    const kids = [...el.children].map(walk).filter(Boolean);
    if (kids.length) node.children = kids;
    return node;
  };
  const root = walk(document.body);
  return {
    url: location.pathname,
    viewport: [innerWidth, innerHeight],
    theme: document.documentElement.dataset.theme,
    count,
    root,
  };
}

async function shoot(page, id, width, theme, { fullPage = true } = {}) {
  const file = `${id}-${width}-${theme}.png`;
  // `fonts.ready` на медленной машине иногда висит — не дольше полутора секунд.
  await page.evaluate(() => Promise.race([document.fonts?.ready, new Promise((r) => setTimeout(r, 1500))]));
  if (args.tree) {
    // --tree: рядом с кадром — структура страницы; --tree-only — только она, PNG и манифест не трогаются.
    const tree = await page.evaluate(pageTree);
    const treeFile = `${id}-${width}-${theme}.json`;
    writeFileSync(path.join(out, treeFile), JSON.stringify(tree));
    console.log(`  ✓ ${treeFile} (${tree.count} узлов)`);
    if (args['tree-only']) return;
  }
  // Окно или меню поверх страницы снимаются в пределах экрана: при снимке «во всю страницу»
  // фиксированная подложка покрывает только исходную высоту окна и кадр врёт.
  const overlay = fullPage
    ? await page
        .locator('[role="dialog"]:visible, [role="alertdialog"]:visible, [role="menu"]:visible')
        .count()
        .catch(() => 0)
    : 1;
  const size = await page.evaluate(
    (full) => ({
      w: document.documentElement.clientWidth,
      h: full ? Math.max(document.documentElement.scrollHeight, window.innerHeight) : window.innerHeight,
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }),
    overlay === 0,
  );
  // --svg (E15-B): тот же кадр слоями — `<id>-<ширина>-<тема>.svg` для импорта в Figma, и аудит чёткости.
  let svgInfo = null;
  if (args.svg) {
    try {
      const audit = await page.evaluate(auditPage);
      const result = await page.evaluate(domToSvg, { fullPage: overlay === 0 });
      const svgFile = `${id}-${width}-${theme}.svg`;
      const svg = await inlineRemoteImages(page, result.svg);
      writeFileSync(path.join(out, svgFile), svg);
      svgInfo = { svgFile, svgNodes: result.nodes, svgBytes: svg.length, audit };
      console.log(
        `  ✓ ${svgFile} ${result.w}×${result.h} ${result.nodes} узлов ${Math.round(svg.length / 1024)} КиБ`,
      );
    } catch (error) {
      console.log(`  ✗ ${id}-${width}-${theme}.svg: ${String(error).split('\n')[0]}`);
    }
  }
  await page.screenshot({ path: path.join(out, file), fullPage: overlay === 0, caret: 'hide' });
  // Размер кадра — по самому PNG (ширина и высота в заголовке IHDR), а не по окну: у страницы шире
  // окна телефон уменьшает масштаб, и `innerHeight` перестаёт совпадать со снимком.
  const png = readFileSync(path.join(out, file));
  const scale = await page.evaluate(() => devicePixelRatio);
  size.w = png.readUInt32BE(16) / scale;
  size.h = png.readUInt32BE(20) / scale;
  record({
    id,
    width,
    theme,
    file,
    cssWidth: size.w,
    cssHeight: size.h,
    overflowX: size.overflowX,
    ...svgInfo,
  });
  console.log(
    `  ✓ ${file} ${size.w}×${size.h}${size.overflowX > 0 ? ` (шире окна на ${size.overflowX})` : ''}`,
  );
}

async function home(page) {
  await page.goto(base);
  await page
    .getByRole('button', { name: /Новая встреча/ })
    .first()
    .waitFor({ timeout: 60000 });
  await page.waitForTimeout(600);
}

/** Окно «Поддержка» с главной (R37): на телефоне кнопка — в выдвижной панели. */
async function openSupport(page) {
  await home(page);
  const burger = page.getByRole('button', { name: 'Открыть меню' });
  if (await burger.isVisible()) await burger.click();
  await page.getByRole('button', { name: 'Поддержка' }).first().click();
  await page.locator('.help-center').first().waitFor({ timeout: 10000 });
  await page.waitForTimeout(600);
}

async function connected(page) {
  await page
    .locator('[data-media-status="connected"]')
    .or(page.getByText('В эфире', { exact: true }))
    .first()
    .waitFor({ timeout: 90000 });
}

/** Снимок ответа API — интерфейс рисует его как настоящий. */
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

// ---------------------------------------------------------------------------------------------
// Подставные данные: десять комнат в избранном по разделам (закреплённые, две группы, без группы).

const now = Date.now();
const GROUPS = [
  { id: '00000000-0000-4000-8000-0000000000a1', title: 'Работа' },
  { id: '00000000-0000-4000-8000-0000000000a2', title: 'Друзья' },
];
const FAVORITES = [
  ['Планёрка', true, null, false],
  ['Покер по пятницам', true, null, true],
  ['Дизайн-ревью', false, 0, false],
  ['Созвон с командой', false, 0, true],
  ['Ретро спринта', false, 0, true],
  ['Собеседование', false, 0, true],
  ['Кино в субботу', false, 1, true],
  ['Дурак', false, 1, false],
  ['Шахматный клуб', false, 1, true],
  ['Без повода', false, null, true],
].map(([title, pinned, group, closed], i) => ({
  roomId: `00000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`,
  code: String(318204650 + i * 7351).slice(0, 9),
  title,
  alias: null,
  pinned,
  groupId: group === null ? null : GROUPS[group].id,
  closed,
  canJoin: true,
  savedAt: now - i * 3600_000,
}));

async function fakeFavorites(context, rooms = FAVORITES, groups = GROUPS) {
  await context.route(/\/api\/v1\/favorites(\?.*)?$/, (route) =>
    route.request().method() === 'GET' ? json(route, rooms) : route.continue(),
  );
  await context.route(/\/api\/v1\/favorites\/groups(\?.*)?$/, (route) =>
    route.request().method() === 'GET' ? json(route, groups) : route.continue(),
  );
}

/** Окно клиента Windows: `window.chrome.webview` с почтой оболочки (как e2e/desktop.spec.ts). */
function webview() {
  const listeners = new Set();
  window.addEventListener('test:host', (event) =>
    listeners.forEach((listener) => listener(new MessageEvent('message', { data: event.detail }))),
  );
  window.chrome = {
    ...window.chrome,
    webview: {
      postMessage() {},
      addEventListener: (_, listener) => listeners.add(listener),
      removeEventListener: (_, listener) => listeners.delete(listener),
    },
  };
}

/** Встреча с подтверждением входа: гости ждут у двери (одна на весь прогон). */
let gate = null;
async function sharedGate() {
  if (gate) return gate;
  const context = await newContext(1024, 'dark', { name: 'Ника' });
  const page = await context.newPage();
  await createMeeting(page, { camera: false, approval: true });
  gate = { context, page, code: await meetingCode(page) };
  return gate;
}

/**
 * Встреча, которую держит «другое окно» того же профиля (для 409): одна на весь прогон.
 * Возвращает секрет профиля — его кладут в хранилище контекста, который пробует войти ещё куда-то.
 */
let host = null;
async function sharedHost() {
  if (host) return host;
  const context = await newContext(1024, 'dark', { name: 'Ника' });
  const page = await context.newPage();
  await createMeeting(page, { camera: false });
  const profile = await page.evaluate(() => localStorage.getItem('cord:profile:v1'));
  host = { context, page, profile };
  return host;
}

// ---------------------------------------------------------------------------------------------
// Одиночные состояния: (page, ctx) → открыть; ctx = { width, theme, context }.

const SINGLE = {
  // --- Загрузка и подключение ---------------------------------------------------------------
  loader: {
    group: 'Вход и главная',
    title: 'Загрузка (index.html)',
    src: 'web/index.html (#cord-boot), ui/loader/boot.ts, ui/loader/BootGate.tsx',
    async open(page, { context }) {
      // Бандл не приходит — статичная сцена `#cord-boot` остаётся на экране, как на медленной сети.
      await context.route(/\/assets\/.*\.js$/, (route) => route.abort());
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await page.locator('#cord-boot').waitFor();
      await page.waitForTimeout(1200);
    },
  },
  'connect-searching': {
    group: 'Вход и главная',
    title: 'Подключение — ищем сервер',
    src: 'ui/Connect.tsx',
    async open(page, { context }) {
      await context.route(/\/api\/v1\/capabilities/, () => {
        /* без ответа: «Ищем сервер…» */
      });
      await page.goto(base);
      await page.getByRole('heading', { name: 'Ищем сервер…' }).waitFor();
      await page
        .locator('#cord-boot')
        .waitFor({ state: 'detached', timeout: 8000 })
        .catch(() => {});
      await page.waitForTimeout(400);
    },
  },
  'connect-manual': {
    group: 'Вход и главная',
    title: 'Подключение — без автоподключения',
    src: 'ui/Connect.tsx, core/servers.ts',
    async open(page, { context }) {
      await context.addInitScript((url) => {
        localStorage.setItem(
          'cord:servers:v1',
          JSON.stringify({ url, name: '', password: '', autoConnect: false }),
        );
      }, new URL('/', base).href);
      await page.goto(base);
      await page.getByRole('button', { name: 'Подключиться' }).waitFor();
      await page.waitForTimeout(500);
    },
  },
  'connect-password': {
    group: 'Вход и главная',
    title: 'Подключение — нужен пароль сервера',
    src: 'ui/Connect.tsx',
    async open(page, { context }) {
      await context.route(/\/api\/v1\/capabilities/, async (route) => {
        const response = await route.fetch();
        json(route, { ...(await response.json()), passwordRequired: true });
      });
      await page.goto(base);
      await page.getByLabel('Пароль сервера').waitFor();
      await page.waitForTimeout(400);
    },
  },
  'connect-failed': {
    group: 'Вход и главная',
    title: 'Подключение — сервер не отвечает',
    src: 'ui/Connect.tsx, core/session.ts',
    async open(page, { context }) {
      await context.route(/\/api\/v1\/capabilities/, (route) =>
        route.fulfill({ status: 502, body: 'Bad gateway' }),
      );
      await page.goto(base);
      const status = page.locator('details.connection-status.failed');
      await status.waitFor();
      await status.locator('summary').click();
      await page.waitForTimeout(300);
    },
  },

  'connect-wrong-password': {
    group: 'Вход и главная',
    title: 'Подключение — пароль не подошёл',
    src: 'ui/Connect.tsx, core/session.ts (describeFailure)',
    async open(page, { context }) {
      await context.route(/\/api\/v1\/capabilities/, async (route) => {
        const response = await route.fetch();
        json(route, { ...(await response.json()), passwordRequired: true });
      });
      await context.route(/\/api\/v1\/session$/, (route) =>
        json(route, { status: 401, code: 'SERVER_PASSWORD_INVALID', detail: 'Неверный пароль' }, 401),
      );
      await page.goto(base);
      await page.getByLabel('Пароль сервера').fill('неверный');
      await page.getByRole('button', { name: 'Подключиться' }).click();
      const status = page.locator('details.connection-status.failed');
      await status.waitFor();
      await status.locator('summary').click();
      await page.waitForTimeout(300);
    },
  },
  'loader-start': {
    // Загрузка лежит слоем поверх длинной витрины — снимается экран, а не вся страница.
    fullPage: false,
    group: 'Вход и главная',
    title: 'Полноэкранная загрузка «Открываем Cord» (FullscreenLoader)',
    src: 'ui/loader/FullscreenLoader.tsx, ui/loader/scenes.tsx, ui/loader/loader.css',
    note: 'Компонент живёт в витрине /kit («Показать старт»); в приложении старт рисует index.html.',
    async open(page) {
      await page.goto(new URL('/kit', base).href);
      await page.getByRole('button', { name: 'Показать старт' }).first().click();
      await page.waitForTimeout(900);
    },
  },
  'loader-cards': {
    // Загрузка лежит слоем поверх длинной витрины — снимается экран, а не вся страница.
    fullPage: false,
    group: 'Вход и главная',
    title: 'Загрузка игры «Раздаём карты» (сцена карт)',
    src: 'ui/loader/FullscreenLoader.tsx, ui/loader/scenes.tsx',
    async open(page) {
      await page.goto(new URL('/kit', base).href);
      await page.getByRole('button', { name: 'Показать карты' }).first().click();
      await page.waitForTimeout(900);
    },
  },
  'loader-slow': {
    // Загрузка лежит слоем поверх длинной витрины — снимается экран, а не вся страница.
    fullPage: false,
    group: 'Вход и главная',
    title: 'Загрузка — «Сеть медленная» и «Повторить» (через 1,5 с)',
    src: 'ui/loader/FullscreenLoader.tsx',
    async open(page) {
      await page.goto(new URL('/kit', base).href);
      await page.getByRole('button', { name: 'Показать старт' }).first().click();
      await page
        .getByText(/Сеть медленная/)
        .first()
        .waitFor({ timeout: 20000 });
      await page.waitForTimeout(500);
    },
  },

  // --- Главная -------------------------------------------------------------------------------
  home: {
    group: 'Вход и главная',
    title: 'Главная — пустое избранное',
    src: 'ui/home/HomeShell.tsx, ui/HomeEntry.tsx, ui/home/FavoritesNav.tsx, ui/InstallHint.tsx',
    async open(page, { context }) {
      await fakeFavorites(context, [], []);
      await home(page);
    },
  },
  'home-favorites': {
    group: 'Вход и главная',
    title: 'Главная — избранное 10 из 10 (закреплённые, группы)',
    src: 'ui/home/FavoritesNav.tsx, ui/home/RoomRow.tsx, ui/useFavoriteShelf.ts',
    // Уже 960 px панель под бургером — телефон снят в `home-drawer`.
    widths: [1024, 1440],
    async open(page, { context }) {
      await fakeFavorites(context);
      await home(page);
      await page.getByText('Планёрка').first().waitFor();
    },
  },
  'home-drawer': {
    group: 'Вход и главная',
    title: 'Главная — меню под бургером (уже 960 px)',
    src: 'ui/home/HomeShell.tsx, ui/home/home.css',
    widths: [360],
    async open(page, { context }) {
      await fakeFavorites(context);
      await home(page);
      await page.getByRole('button', { name: 'Открыть меню' }).click();
      await page.getByRole('dialog', { name: 'Меню' }).waitFor();
      await page.waitForTimeout(500);
    },
  },
  'home-room-menu': {
    group: 'Вход и главная',
    title: 'Главная — меню комнаты в избранном',
    src: 'ui/home/RoomRow.tsx, ui/kit/Menu.tsx',
    widths: [1024, 1440],
    async open(page, { context }) {
      await fakeFavorites(context);
      await home(page);
      await page.getByText('Дизайн-ревью').first().click({ button: 'right' });
      await page.getByRole('menu').first().waitFor();
      await page.waitForTimeout(400);
    },
  },
  'home-remove-confirm': {
    group: 'Диалоги и прочее',
    title: 'Окно «Убрать из избранного?»',
    src: 'ui/home/FavoritesNav.tsx, ui/home/RoomRow.tsx',
    async open(page, { context, width }) {
      await fakeFavorites(context);
      await home(page);
      if (mobile(width)) {
        await page.getByRole('button', { name: 'Открыть меню' }).click();
        await page.getByRole('button', { name: 'Действия с «Дизайн-ревью»' }).click();
      } else await page.getByText('Дизайн-ревью').first().click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Убрать из избранного' }).click();
      await page.getByRole('dialog').filter({ hasText: 'из избранного?' }).waitFor();
      await page.waitForTimeout(500);
    },
  },
  'home-active-elsewhere': {
    group: 'Вход и главная',
    title: 'Главная — встреча идёт в соседней вкладке (T52), «Вернуться»',
    src: 'ui/home/ActiveMeetingNotice.tsx, core/active-meeting.ts',
    note: 'Соседняя вкладка подставлена ответом в BroadcastChannel «cord:active-meeting».',
    async open(page, { context }) {
      await fakeFavorites(context);
      await context.addInitScript((roomId) => {
        const channel = new BroadcastChannel('cord:active-meeting');
        channel.onmessage = (event) => {
          if (event.data?.type === 'who')
            channel.postMessage({
              type: 'here',
              meeting: { tab: 'fake', roomId, title: 'Планёрка', code: '318204650' },
            });
        };
      }, FAVORITES[0].roomId);
      await home(page);
      await page
        .getByRole('region', { name: 'Вы во встрече в другой вкладке' })
        .or(page.getByText('Вернуться'))
        .first()
        .waitFor({ timeout: 15000 });
      await page.waitForTimeout(500);
    },
  },
  'home-favorites-error': {
    group: 'Вход и главная',
    title: 'Главная — избранное не загрузилось',
    src: 'ui/home/FavoritesNav.tsx',
    widths: [1024, 1440],
    async open(page, { context }) {
      await context.route(/\/api\/v1\/favorites(\/groups)?(\?.*)?$/, (route) =>
        route.fulfill({ status: 500, body: '{}' }),
      );
      await home(page);
      await page
        .getByText(/Не удалось загрузить избранное/)
        .first()
        .waitFor({ timeout: 30000 });
      await page.waitForTimeout(300);
    },
  },
  'room-not-found': {
    group: 'Вход и главная',
    title: 'Ссылка на встречу без сохранённого входа — «Сессия не найдена»',
    src: 'App.tsx (global-error)',
    note: 'В свежей вкладке без сессии сервера баннер стирает рукопожатие экрана подключения (App.tsx:299, onConnected → setError("")): человек видит главную без объяснения. Снято с уже открытой сессией сервера.',
    async open(page, { context }) {
      // Сессия сервера уже есть (вкладка, где Cord был открыт): иначе баннер стирает подключение.
      await context.addInitScript(() =>
        sessionStorage.setItem(
          'cord:session:v1',
          JSON.stringify({
            token: 'snapshot',
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
            name: '',
            passwordRequired: false,
          }),
        ),
      );
      await page.goto(new URL('/room/00000000-0000-4000-8000-000000000000', base).href);
      await page.locator('.global-error').first().waitFor({ timeout: 45000 });
      await page.waitForTimeout(800);
    },
  },
  'download-unavailable': {
    group: 'Вход и главная',
    title: 'Скачать Cord — сборка недоступна',
    src: 'ui/Download.tsx, core/download.ts',
    async open(page, { context }) {
      await context.route(/\/downloads\/windows\/download\.json/, (route) =>
        route.fulfill({ status: 404, body: '' }),
      );
      await page.goto(new URL('/download', base).href);
      await page
        .getByText(/сейчас недоступна/)
        .first()
        .waitFor();
      await page.waitForTimeout(400);
    },
  },
  'desktop-home': {
    group: 'Вход и главная',
    title: 'Главная в клиенте Windows (DesktopHome, WebView2)',
    src: 'ui/DesktopHome.tsx, desktop-home.css',
    note: 'Окно клиента подставлено: window.chrome.webview, как в e2e/desktop.spec.ts. Боковую панель рисует сам клиент.',
    widths: [1024, 1440],
    async open(page, { context }) {
      await fakeFavorites(context);
      await context.addInitScript(webview);
      await home(page);
    },
  },
  'desktop-favorite-settings': {
    group: 'Диалоги и прочее',
    title: 'Окно настроек избранной комнаты (клиент Windows)',
    src: 'ui/FavoriteSettings.tsx, App.tsx (favorite.settings)',
    widths: [1024, 1440],
    async open(page, { context }) {
      await fakeFavorites(context);
      await context.addInitScript(webview);
      await home(page);
      await page.evaluate(
        (roomId) =>
          dispatchEvent(
            new CustomEvent('test:host', { detail: { version: 1, type: 'favorite.settings', roomId } }),
          ),
        FAVORITES[2].roomId,
      );
      await page.getByRole('dialog').waitFor();
      await page.waitForTimeout(500);
    },
  },
  download: {
    group: 'Вход и главная',
    title: 'Скачать Cord (/download)',
    src: 'ui/Download.tsx, core/download.ts',
    async open(page) {
      await page.goto(new URL('/download', base).href);
      await page.getByRole('heading').first().waitFor();
      await page.waitForTimeout(600);
    },
  },

  // --- Прихожая ------------------------------------------------------------------------------
  'prejoin-create': {
    group: 'Прихожая',
    title: 'Прихожая — новая встреча',
    src: 'ui/Prejoin.tsx',
    async open(page) {
      await home(page);
      await page
        .getByRole('button', { name: /Новая встреча/ })
        .first()
        .click();
      await page.getByLabel('Ваше имя').waitFor();
      await page.waitForTimeout(2500);
    },
  },
  'prejoin-join': {
    group: 'Прихожая',
    title: 'Прихожая — вход по коду или ссылке',
    src: 'ui/Prejoin.tsx, core/invitation.ts',
    async open(page) {
      const { code } = await sharedGate();
      await page.goto(new URL(`/join/${code}`, base).href);
      await page.getByRole('button', { name: 'Войти во встречу' }).waitFor({ timeout: 60000 });
      await page.waitForTimeout(2000);
    },
  },
  'prejoin-settings': {
    group: 'Прихожая',
    title: 'Прихожая — окно «Перед разговором» (устройства)',
    src: 'ui/Prejoin.tsx',
    async open(page) {
      await home(page);
      await page
        .getByRole('button', { name: /Новая встреча/ })
        .first()
        .click();
      await page.getByRole('button', { name: 'Включить камеру', exact: true }).click();
      await page.getByRole('button', { name: 'Настройки предпросмотра' }).click();
      await page.getByRole('dialog').waitFor();
      await page.waitForTimeout(1500);
    },
  },
  'meeting-waiting': {
    group: 'Прихожая',
    title: 'Ожидание допуска — «Организатор скоро впустит вас»',
    src: 'ui/MeetingView.tsx (ожидание), ui/MeetingHeader.tsx (TEXT.waiting)',
    note: 'Встреча создана с «Только с вашего подтверждения»; гость вошёл по коду.',
    async open(page) {
      const { code } = await sharedGate();
      await joinByCode(page, code, { wait: false });
      await page
        .getByText(/Организатор скоро впустит вас/)
        .first()
        .waitFor({ timeout: 60000 });
      await page.waitForTimeout(1500);
    },
  },
  'prejoin-denied': {
    group: 'Прихожая',
    title: 'Прихожая — камера и микрофон запрещены',
    src: 'ui/Prejoin.tsx',
    async open(page, { context }) {
      await context.clearPermissions();
      await context.addInitScript(() => {
        const denied = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
        if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = denied;
        const query = navigator.permissions?.query?.bind(navigator.permissions);
        if (query)
          navigator.permissions.query = (d) =>
            d && (d.name === 'camera' || d.name === 'microphone')
              ? Promise.resolve({
                  state: 'denied',
                  onchange: null,
                  addEventListener() {},
                  removeEventListener() {},
                })
              : query(d);
      });
      await home(page);
      await page
        .getByRole('button', { name: /Новая встреча/ })
        .first()
        .click();
      await page.getByLabel('Ваше имя').waitFor();
      // Камера в прихожей выключена до нажатия — отказ браузера виден, когда её включают.
      await page.getByRole('button', { name: 'Включить камеру' }).click();
      await page.waitForTimeout(2500);
    },
  },

  // --- Настройки -----------------------------------------------------------------------------
  settings: {
    group: 'Настройки',
    title: 'Настройки — разделы',
    src: 'ui/settings/*, ui/settings/sections.ts',
    multi: true,
    async open(page, { width, shootAs }) {
      await home(page);
      // Уже 960 px «Настройки» главной — в выдвижном меню под бургером (E02).
      const burger = page.getByRole('button', { name: 'Открыть меню' });
      if (await burger.isVisible()) await burger.click();
      await page
        .getByRole('button', { name: /^Настройки$/ })
        .first()
        .click();
      const nav = page.getByRole('navigation', { name: 'Разделы настроек' });
      const items = nav.locator('.settings-nav__item');
      await items.first().waitFor();
      await page.waitForTimeout(600);
      const back = page.getByRole('button', { name: 'К разделам' });
      if (mobile(width)) await shootAs('settings-list', 'Настройки — список разделов (телефон)');
      const count = await items.count();
      for (let i = 0; i < count; i++) {
        if (await back.isVisible().catch(() => false)) {
          await back.click();
          await page.waitForTimeout(300);
        }
        const item = items.nth(i);
        const name = (await item.innerText()).trim().split('\n')[0];
        await item.click();
        await page.waitForTimeout(700);
        const slug = `settings-${String(i + 1).padStart(2, '0')}`;
        await shootAs(slug, `Настройки — ${name}`);
        // Длинный раздел: второй кадр — прокрученный до конца.
        const scroller = page.locator('.settings-content, .settings-section, [data-settings-scroll]').first();
        const scrollable = await scroller
          .evaluate((el) => el.scrollHeight > el.clientHeight + 40)
          .catch(() => false);
        if (scrollable) {
          await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
          await page.waitForTimeout(400);
          await shootAs(`${slug}b`, `Настройки — ${name}, прокручено вниз`);
          await scroller.evaluate((el) => el.scrollTo({ top: 0 }));
        }
      }
      // Поиск по настройкам.
      if (await back.isVisible().catch(() => false)) await back.click();
      const search = page.getByRole('searchbox').or(page.getByPlaceholder(/Поиск/)).first();
      if (await search.isVisible().catch(() => false)) {
        await search.fill('звук');
        await page.waitForTimeout(600);
        await shootAs('settings-search', 'Настройки — поиск «звук»');
      }
    },
  },

  'avatar-cropper': {
    group: 'Диалоги и прочее',
    title: 'Окно «Что будет в кружке» (картинка профиля)',
    src: 'ui/AvatarCropper.tsx, ui/settings/* (Профиль)',
    async open(page) {
      await home(page);
      const burger = page.getByRole('button', { name: 'Открыть меню' });
      if (await burger.isVisible()) await burger.click();
      await page
        .getByRole('button', { name: /^Настройки$/ })
        .first()
        .click();
      const nav = page.getByRole('navigation', { name: 'Разделы настроек' });
      await nav
        .getByRole('button', { name: /^Профиль/ })
        .first()
        .click();
      await page
        .locator('input[type=file][aria-label="Выбрать картинку профиля"]')
        .setInputFiles(path.resolve('e2e/fixtures/poster.png'));
      await page.getByRole('dialog', { name: /Что будет в кружке/ }).waitFor();
      await page.waitForTimeout(800);
    },
  },

  // --- Встреча: телефон в одиночку и окна правил -------------------------------------------
  'meeting-solo': {
    group: 'Встреча',
    title: 'Встреча — один участник',
    src: 'ui/MeetingView.tsx, ui/Stage.tsx, ui/CallDock.tsx, ui/MeetingHeader.tsx',
    // настольные ширины снимает сценарий meeting до прихода остальных
    widths: [360],
    async open(page) {
      await createMeeting(page, { camera: true });
    },
  },
  'dialog-favorites-full': {
    group: 'Диалоги и прочее',
    title: 'Избранное заполнено — подсказка звезды «В избранном уже 10 комнат»',
    src: 'ui/MeetingHeader.tsx (TEXT.full), ui/useFavorites.ts',
    note: 'Звезда на пределе aria-disabled; «В избранном уже 10 комнат. Уберите одну, чтобы добавить эту» — системная подсказка (атрибут title), на снимке её не видно.',
    async open(page, { context, width }) {
      await fakeFavorites(context);
      await createMeeting(page, { camera: false });
      const star = page.locator('.meeting-header__favorite');
      // На пределе звезда `aria-disabled`: подсказка — ответ «почему не добавляется».
      if (mobile(width)) {
        await star.focus();
        await star.tap({ force: true }).catch(() => {});
      } else await star.hover();
      await page
        .getByText(/В избранном уже 10 комнат/)
        .first()
        .waitFor({ timeout: 10000 })
        .catch(() => {});
      await page.waitForTimeout(600);
    },
  },
  'dialog-favorites-refused': {
    group: 'Диалоги и прочее',
    title: 'Избранное заполнено — отказ ядра FAVORITES_FULL при нажатии звезды',
    src: 'ui/MeetingHeader.tsx, room/FavoriteService.java (FAVORITES_FULL)',
    note: 'Список избранного успел устареть (9 из 10), ядро отвечает 409 FAVORITES_FULL — текст отказа тот же, что у подсказки звезды.',
    async open(page, { context }) {
      await fakeFavorites(context, FAVORITES.slice(0, 9));
      await context.route(/\/api\/v1\/favorites\/[0-9a-f-]{36}$/, (route) =>
        route.request().method() === 'PUT'
          ? json(
              route,
              {
                status: 409,
                code: 'FAVORITES_FULL',
                detail: 'В избранном уже 10 комнат. Уберите одну, чтобы добавить эту',
                max: 10,
              },
              409,
            )
          : route.continue(),
      );
      await createMeeting(page, { camera: false });
      await page.locator('.meeting-header__favorite').click();
      await page
        .getByText(/В избранном уже 10 комнат/)
        .first()
        .waitFor({ timeout: 15000 });
      await page.waitForTimeout(600);
    },
  },
  'dialog-409': {
    group: 'Диалоги и прочее',
    title: '409 «Вы уже во встрече» (T52) — тот же профиль в другом окне',
    src: 'ui/MeetingElsewhere.tsx, core/identity.ts, ui/Prejoin.tsx',
    note: 'Профиль устройства уже держит место во встрече в другом окне; ядро отвечает 409 ALREADY_IN_MEETING, браузер показывает выбор.',
    async open(page, { context }) {
      const host = await sharedHost();
      await context.addInitScript((secret) => localStorage.setItem('cord:profile:v1', secret), host.profile);
      await home(page);
      await page
        .getByRole('button', { name: /Новая встреча/ })
        .first()
        .click();
      await page.getByLabel('Ваше имя').waitFor();
      await page.getByRole('button', { name: 'Начать встречу' }).click();
      await page.getByRole('dialog').filter({ hasText: 'Вы уже во встрече' }).waitFor({ timeout: 30000 });
      await page.waitForTimeout(800);
    },
  },

  // --- Набор (витрина /kit) -----------------------------------------------------------------
  kit: {
    group: 'Диалоги и прочее',
    title: 'Витрина набора /kit (E16)',
    src: 'ui/kit/Showcase.tsx, ui/kit/*',
    widths: [1440],
    async open(page) {
      await page.goto(new URL('/kit', base).href);
      await page.getByRole('heading').first().waitFor();
      await page.waitForTimeout(800);
    },
  },
};

// ---------------------------------------------------------------------------------------------
// E15-B: то, что вышло после E15-A — выбор площадки (T59), предупреждения антибота (E11-B), фон на
// телефоне (E12), язык (E14-A), Telegram Mini App (E09), клиент на Electron (E01-B).

const SHELL = process.env.CORD_SHELL ?? '/opt/ModernStreamingSystem.Windows/desktop/src/shell';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';

/** Шаг многокадрового рецепта: сбой одного состояния не губит остальные. */
async function step(name, job) {
  try {
    await job();
  } catch (error) {
    console.log(`  ✗ ${name}: ${String(error).split('\n')[0]}`);
  }
}

/** Встреча, созданная на главной, и её приглашение из ответа ядра (`inviteUrl`). */
async function createWithInvite(page, options) {
  const answer = page.waitForResponse(
    (r) => /\/api\/v1\/rooms$/.test(r.url()) && r.request().method() === 'POST',
  );
  await createMeeting(page, options);
  const body = await (await answer).json().catch(() => ({}));
  return body.inviteUrl ?? null;
}

/** Окружение Telegram без Telegram: параметры запуска в hash и мост WebView, отвечающий на запросы. */
function telegramUrl(theme, { platform = 'android' } = {}) {
  const user = {
    id: 7,
    first_name: 'Ника',
    last_name: 'Петрова',
    language_code: 'ru',
    allows_write_to_pm: true,
  };
  const initData = new URLSearchParams({
    user: JSON.stringify(user),
    chat_instance: '-4402981',
    chat_type: 'group',
    start_param: '4821',
    auth_date: String(Math.floor(Date.now() / 1000)),
    signature: 'c2lnbmF0dXJl',
    hash: 'a'.repeat(64),
  }).toString();
  const params =
    theme === 'dark'
      ? {
          bg_color: '#17212b',
          text_color: '#f5f5f5',
          hint_color: '#708499',
          link_color: '#6ab3f3',
          button_color: '#5288c1',
          button_text_color: '#ffffff',
          secondary_bg_color: '#232e3c',
          header_bg_color: '#17212b',
          bottom_bar_bg_color: '#17212b',
          section_bg_color: '#17212b',
          accent_text_color: '#6ab2f2',
          destructive_text_color: '#ec3942',
          subtitle_text_color: '#708499',
          section_header_text_color: '#6ab3f3',
        }
      : {
          bg_color: '#ffffff',
          text_color: '#000000',
          hint_color: '#999999',
          link_color: '#2481cc',
          button_color: '#2481cc',
          button_text_color: '#ffffff',
          secondary_bg_color: '#efeff3',
          header_bg_color: '#ffffff',
          bottom_bar_bg_color: '#ffffff',
          section_bg_color: '#ffffff',
          accent_text_color: '#2481cc',
          destructive_text_color: '#e53935',
          subtitle_text_color: '#999999',
          section_header_text_color: '#6d6d72',
        };
  const hash = new URLSearchParams({
    tgWebAppData: initData,
    tgWebAppVersion: '8.0',
    tgWebAppPlatform: platform,
    tgWebAppThemeParams: JSON.stringify(params),
  }).toString();
  return { url: new URL(`/tg#${hash}`, base).href, params };
}
function telegramBridge(params) {
  const send = (type, data) =>
    setTimeout(() => {
      try {
        window.Telegram?.WebView?.receiveEvent?.(type, data);
      } catch {
        /* нет приёмника — живём без ответа */
      }
    }, 20);
  window.TelegramWebviewProxy = {
    postEvent(type) {
      if (type === 'web_app_request_viewport')
        send('viewport_changed', {
          height: innerHeight,
          width: innerWidth,
          is_expanded: true,
          is_state_stable: true,
        });
      if (type === 'web_app_request_safe_area')
        send('safe_area_changed', { top: 44, bottom: 20, left: 0, right: 0 });
      if (type === 'web_app_request_content_safe_area')
        send('content_safe_area_changed', { top: 46, bottom: 0, left: 0, right: 0 });
      if (type === 'web_app_request_fullscreen') send('fullscreen_changed', { is_fullscreen: true });
      if (type === 'web_app_request_theme') send('theme_changed', { theme_params: params });
    },
  };
}
async function openTelegram(page, context, theme, enter) {
  const { url, params } = telegramUrl(theme);
  await context.addInitScript(telegramBridge, params);
  if (enter)
    await context.route(/\/api\/v1\/services\/telegram\/webapp\/enter/, (route) =>
      enter.status ? json(route, enter.body, enter.status) : json(route, enter),
    );
  await page.goto(url);
}

/** Мост клиента на Electron (ADR 0001, протокол 2) — без оболочки. */
function electronBridge() {
  window.cordDesktop = {
    protocol: { major: 2, minor: 0 },
    features: [
      'hotkeys',
      'capture',
      'capture.system-audio',
      'overlay',
      'notify',
      'thumbar',
      'badge',
      'progress',
      'attention',
      'deeplink',
      'servers',
      'update',
      'power',
      'app.settings',
      'tray',
      'sleep',
      'autostart',
    ],
    app: { version: '1.0.0', arch: 'x64' },
    bootstrap: { profile: '', theme: 'system', showPing: false, notificationSounds: true, autoConnect: true },
    send() {},
    invoke: () => Promise.resolve(null),
    on: () => () => {},
  };
}

/** Страница оболочки (`desktop/src/shell/*.html`) с подставным `window.cordShell`. */
function shellStub(answers) {
  const handlers = {};
  window.__emit = (type, data) => handlers[type]?.(data);
  window.cordShell = {
    on(type, handler) {
      handlers[type] = handler;
      if (answers.events?.[type]) setTimeout(() => handler(answers.events[type]), 0);
      return () => {};
    },
    emit() {},
    call(name, payload) {
      const value = answers.calls?.[name];
      if (name === 'servers.ping') return Promise.resolve(answers.pings?.[payload?.url] ?? null);
      if (name === 'capture.sources') return Promise.resolve(window.__sources?.() ?? value ?? null);
      return Promise.resolve(value ?? null);
    },
  };
}
function thumbnails() {
  const draw = (w, h, paint) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    paint(c.getContext('2d'), w, h);
    return c.toDataURL('image/png');
  };
  const desk = (title, hue) =>
    draw(320, 180, (g, w, h) => {
      const grad = g.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, `hsl(${hue} 45% 32%)`);
      grad.addColorStop(1, `hsl(${hue + 40} 45% 18%)`);
      g.fillStyle = grad;
      g.fillRect(0, 0, w, h);
      g.fillStyle = 'rgba(255,255,255,.92)';
      g.fillRect(36, 30, 170, 104);
      g.fillStyle = '#3564f3';
      g.fillRect(36, 30, 170, 14);
      g.fillStyle = 'rgba(0,0,0,.45)';
      g.fillRect(0, h - 14, w, 14);
      g.fillStyle = '#1b1f27';
      g.font = '600 12px sans-serif';
      g.fillText(title, 46, 66);
    });
  const icon = (color) =>
    draw(24, 24, (g) => {
      g.fillStyle = color;
      g.beginPath();
      g.roundRect(2, 2, 20, 20, 5);
      g.fill();
    });
  window.__sources = () => ({
    systemAudio: true,
    sources: [
      { id: 's1', kind: 'screen', name: 'Экран 1', thumbnail: desk('План на неделю', 215) },
      { id: 's2', kind: 'screen', name: 'Экран 2', thumbnail: desk('Таблица продаж', 150) },
      {
        id: 'w1',
        kind: 'window',
        name: 'План на неделю — Документы',
        thumbnail: desk('План на неделю', 215),
        icon: icon('#2b7de9'),
      },
      {
        id: 'w2',
        kind: 'window',
        name: 'Figma — Cord · карта продукта',
        thumbnail: desk('Cord', 265),
        icon: icon('#a259ff'),
      },
      {
        id: 'w3',
        kind: 'window',
        name: 'Терминал',
        thumbnail: desk('$ npm run build', 200),
        icon: icon('#2c3340'),
      },
    ],
  });
}

Object.assign(SINGLE, {
  // --- Интеграции: выбор площадки (T59) и музыка -----------------------------------------------
  // --- Предупреждения антибота во встрече (E11-B) --------------------------------------------
  // --- Язык интерфейса (E14-A) -----------------------------------------------------------------
  'settings-language': {
    group: 'Настройки',
    title: 'Настройки — «Оформление», язык интерфейса English (E14-A)',
    src: 'ui/settings/AppearanceSection.tsx, i18n/languages.ts, i18n/index.ts',
    widths: [360, 1440],
    async open(page) {
      await home(page);
      const burger = page.getByRole('button', { name: 'Открыть меню' });
      if (await burger.isVisible()) await burger.click();
      await page
        .getByRole('button', { name: /^Настройки$/ })
        .first()
        .click();
      await page.locator('.settings-nav__item').filter({ hasText: 'Оформление' }).first().click();
      await page.waitForTimeout(500);
      const select = page
        .locator('#appearance-language select, select')
        .filter({ has: page.locator('option[value="en"]') })
        .first();
      await select.selectOption('en');
      await page.waitForTimeout(800);
      await select.scrollIntoViewIfNeeded();
    },
  },

  // --- Телефон: разговор в фоне (E12) ------------------------------------------------------------
  'install-hint-ios': {
    group: 'Телефон',
    title: 'Телефон — главная на iPhone: «Cord на экране „Домой“» (InstallHint)',
    src: 'ui/InstallHint.tsx, ui/home/HomeShell.tsx',
    widths: [360],
    context: { userAgent: IPHONE },
    async open(page) {
      await home(page);
      await page.waitForTimeout(800);
    },
  },

  // --- Telegram Mini App (E09) ---------------------------------------------------------------
  'tg-outside': {
    group: 'Telegram',
    title: 'Mini App вне Telegram — «Откройте из Telegram»',
    src: 'web/tg.html, telegram/main.tsx, telegram/TelegramApp.tsx (Outside)',
    widths: [360, 1024],
    async open(page) {
      await page.goto(new URL('/tg', base).href);
      await page.locator('.tg-screen').waitFor({ timeout: 30000 });
      await page.waitForTimeout(500);
    },
  },
  'tg-loading': {
    group: 'Telegram',
    title: 'Mini App — статичная загрузка tg.html',
    src: 'web/tg.html',
    widths: [360],
    reload: true,
    async open(page, { context, theme }) {
      await context.route(/\/assets\/.*\.js$/, (route) => route.abort());
      const { url, params } = telegramUrl(theme);
      await context.addInitScript(telegramBridge, params);
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
    },
  },
  'tg-failed': {
    group: 'Telegram',
    title: 'Mini App — отказ: «Вы не состоите в чате…» (TELEGRAM_NOT_MEMBER)',
    src: 'telegram/TelegramApp.tsx (failed), services/cord_services/webapp.py',
    widths: [360],
    reload: true,
    async open(page, { context, theme }) {
      await openTelegram(page, context, theme, {
        status: 403,
        body: {
          status: 403,
          code: 'TELEGRAM_NOT_MEMBER',
          detail: 'Вы не состоите в чате, к которому привязана встреча',
        },
      });
      await page.locator('.tg-screen').waitFor({ timeout: 30000 });
      await page.waitForTimeout(600);
    },
  },
  'tg-media': {
    group: 'Telegram',
    title: 'Mini App — нет доступа к микрофону',
    src: 'telegram/TelegramApp.tsx (media), telegram/media-probe.ts',
    widths: [360],
    reload: true,
    context: { userAgent: ANDROID, permissions: [] },
    async open(page, { context, theme }) {
      await context.addInitScript(() => {
        navigator.mediaDevices.getUserMedia = () =>
          Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
      });
      await openTelegram(page, context, theme, {
        roomId: '00000000-0000-4000-8000-000000000001',
        title: 'Планёрка',
        name: 'Ника Петрова',
        inviteUrl: new URL('/i/x', base).href,
      });
      await page.locator('.tg-screen').waitFor({ timeout: 30000 });
      await page.waitForTimeout(600);
    },
  },
  // --- Клиент Windows на Electron (E01-B) -----------------------------------------------------
  'electron-splash': {
    multi: true,
    group: 'Клиент Windows',
    title: 'Заставка обновления (Electron): проверка, загрузка, установка, сбой',
    src: 'desktop/src/shell/splash.html, splash.js, main/windows/splash.ts, update/splash-flow.ts',
    sizes: [[300, 360]],
    themes: ['dark'],
    context: { desktop: true },
    async open(page, { context }) {
      await context.addInitScript(shellStub, { events: { 'splash.state': { stage: 'checking' } } });
      await page.goto(`file://${SHELL}/splash.html`);
      await page.waitForTimeout(400);
      const states = [
        ['electron-splash-checking', { stage: 'checking' }],
        ['electron-splash-downloading', { stage: 'downloading', progress: 0.42 }],
        ['electron-splash-installing', { stage: 'installing' }],
        [
          'electron-splash-failed',
          { stage: 'failed', problem: 'Не удалось загрузить обновление: сервер не ответил.' },
        ],
      ];
      for (const [as, state] of states) {
        await page.evaluate((s) => window.__emit('splash.state', s), state);
        await page.addStyleTag({
          content: '.bar.busy > i { animation: none !important; left: 30% !important; }',
        });
        await page.waitForTimeout(300);
        await shoot(page, as, 300, 'dark', { fullPage: false });
      }
    },
  },
  'electron-loading': {
    group: 'Клиент Windows',
    title: 'Загрузка интерфейса в окне клиента (Electron, T55)',
    src: 'desktop/src/shell/loading.html, main/windows/main.ts (showLoading)',
    sizes: [[1180, 760]],
    themes: ['dark'],
    async open(page, { context }) {
      await context.addInitScript(shellStub, {});
      await page.goto(`file://${SHELL}/loading.html`);
      await page.addStyleTag({ content: '.mark { animation: none !important; }' });
      await page.waitForTimeout(300);
    },
  },
  'electron-offline': {
    group: 'Клиент Windows',
    title: 'Нет связи с сервером (Electron)',
    src: 'desktop/src/shell/offline.html, offline.js',
    sizes: [[1180, 760]],
    themes: ['dark'],
    async open(page, { context }) {
      await context.addInitScript(shellStub, {});
      await page.goto(`file://${SHELL}/offline.html?server=${encodeURIComponent('https://cord.nikg.tech/')}`);
      await page.waitForTimeout(300);
    },
  },
  'electron-servers': {
    group: 'Клиент Windows',
    title: 'Серверы (Electron, T05): флаг, имя, пинг',
    src: 'desktop/src/shell/servers.html, servers.js, main/catalog.ts',
    sizes: [[440, 520]],
    themes: ['dark'],
    context: { desktop: true },
    async open(page, { context }) {
      await context.addInitScript(shellStub, {
        calls: {
          'servers.list': [
            {
              name: { ru: 'Нидерланды', en: 'Netherlands' },
              url: 'https://cord.nikg.tech/',
              country: 'NL',
              current: true,
            },
            {
              name: { ru: 'Германия', en: 'Germany' },
              url: 'https://de.cord.example/',
              country: 'DE',
              current: false,
            },
            {
              name: { ru: 'Финляндия', en: 'Finland' },
              url: 'https://fi.cord.example/',
              country: 'FI',
              current: false,
            },
            {
              name: { ru: 'Казахстан', en: 'Kazakhstan' },
              url: 'https://kz.cord.example/',
              country: 'KZ',
              current: false,
            },
          ],
        },
        pings: {
          'https://cord.nikg.tech/': 38,
          'https://de.cord.example/': 52,
          'https://fi.cord.example/': 96,
          'https://kz.cord.example/': 214,
        },
      });
      await page.goto(`file://${SHELL}/servers.html`);
      await page.waitForTimeout(500);
    },
  },
  'electron-overlay': {
    group: 'Клиент Windows',
    title: 'Оверлей поверх игры (Electron, T23): кто говорит',
    src: 'desktop/src/shell/overlay.html, overlay.js, main/windows/overlay.ts',
    sizes: [[320, 360]],
    themes: ['dark'],
    context: { desktop: true },
    async open(page, { context }) {
      await context.addInitScript(shellStub, {
        events: {
          'overlay.state': {
            participants: [
              { name: 'Ника', tier: 4, speaking: true },
              { name: 'Марк', tier: 2, speaking: true },
              { name: 'Аня', tier: 0, speaking: false },
              { name: 'Борис Константинопольский', tier: 1, speaking: false },
            ],
          },
        },
      });
      await page.goto(`file://${SHELL}/overlay.html`);
      // Окно прозрачное, под ним игра — здесь вместо игры тёмная картинка.
      await page.addStyleTag({
        content: 'html { background: linear-gradient(140deg, #3b4a2a, #1f2a3a 55%, #3a2a2a) !important; }',
      });
      await page.waitForTimeout(300);
    },
  },
  'electron-home': {
    group: 'Клиент Windows',
    title: 'Главная в клиенте на Electron (веб целиком, мост v2)',
    src: 'ui/Home.tsx, ui/home/HomeShell.tsx, core/desktop.ts',
    widths: [1024, 1440],
    async open(page, { context }) {
      await context.addInitScript(electronBridge);
      await home(page);
    },
  },
});

// ---------------------------------------------------------------------------------------------
// E15-B, невыкаченное на стенд (на 21.10 стенд без E13, E14-B, E01-B2): снимается dev-сервером
// ветки с прокси к стенду (`scripts/stand-proxy.mjs`, скилл verify):
//   node … figma-screens.mjs --base http://127.0.0.1:5199 --only tour,help-center,…
const SEEN = { 'cord:onboarding:v1': JSON.stringify({ tour: true, meeting: true, integrations: true }) };

Object.assign(SINGLE, {
  tour: {
    multi: true,
    group: 'Главная',
    title: 'Знакомство на главной (E13, T34)',
    src: 'ui/onboarding/Onboarding.tsx, ui/kit/Coachmark.tsx, core/onboarding.ts',
    widths: [360, 1440],
    async open(page, { width, shootAs }) {
      await home(page);
      const next = page.getByRole('button', { name: /^(Далее|Готово|Понятно)$/ }).first();
      await next.waitFor({ timeout: 15000 });
      await page.waitForTimeout(700);
      const steps = mobile(width)
        ? ['tour-create', 'tour-join', 'tour-menu']
        : ['tour-create', 'tour-join', 'tour-favorites', 'tour-settings', 'tour-help'];
      for (const [i, id] of steps.entries()) {
        await shootAs(id, `Знакомство — шаг ${i + 1}`);
        if (i === steps.length - 1) break;
        await next.click();
        await page.waitForTimeout(700);
      }
    },
  },
  'help-center': {
    group: 'Главная',
    title: 'Поддержка — вкладки «Частые вопросы · Проверить · Написать» (R37, T36)',
    src: 'ui/support/HelpHost.tsx, ui/support/HelpButton.tsx, ui/support/HelpCenter.tsx',
    widths: [360, 1440],
    context: { storage: SEEN },
    async open(page) {
      await openSupport(page);
    },
  },
  'help-report': {
    group: 'Главная',
    title: '«Сообщить о проблеме» во вкладке «Написать» (R79)',
    src: 'ui/support/ReportForm.tsx, ui/support/Chips.tsx',
    widths: [360, 1440],
    context: { storage: SEEN },
    async open(page) {
      await openSupport(page);
      await page.getByRole('tab', { name: 'Написать' }).click();
      await page.getByRole('radio', { name: 'Сообщить о проблеме' }).click();
      await page.waitForTimeout(600);
    },
  },
  'support-page': {
    group: 'Главная',
    title: '/support — обращение в поддержку (E13, T36)',
    src: 'ui/support/SupportPage.tsx, ui/support/SupportForm.tsx',
    widths: [360, 1440],
    context: { storage: SEEN },
    async open(page) {
      await page.goto(new URL('/support', base).href);
      await page.locator('form, .support-page').first().waitFor({ timeout: 20000 });
      await page.waitForTimeout(800);
    },
  },
  'home-en': {
    group: 'Главная',
    title: 'Главная по-английски (E14-B, T03)',
    src: 'i18n/locales/en.json, i18n/index.ts',
    widths: [360, 1440],
    context: { storage: { ...SEEN, 'cord:preferences:v1': JSON.stringify({ language: 'en' }) } },
    async open(page) {
      await page.goto(base);
      await page
        .getByRole('button', { name: /New meeting/i })
        .first()
        .waitFor({ timeout: 60000 });
      await page.waitForTimeout(600);
    },
  },
  'home-zh': {
    group: 'Главная',
    title: 'Главная по-китайски (E14-B, T03)',
    src: 'i18n/locales/zh-Hans.json',
    widths: [360, 1440],
    context: { storage: { ...SEEN, 'cord:preferences:v1': JSON.stringify({ language: 'zh-Hans' }) } },
    async open(page) {
      await page.goto(base);
      await page.locator('.home-entry, main').first().waitFor({ timeout: 60000 });
      await page.waitForTimeout(1500);
    },
  },
  'settings-overlay': {
    group: 'Клиент Windows',
    title: 'Настройки — раздел «Оверлей» в клиенте (R62, R63, R104)',
    src: 'ui/settings/OverlaySection.tsx, core/desktop-games.ts, core/desktop-settings.ts',
    widths: [1024, 1440],
    context: { storage: SEEN },
    async open(page, { context }) {
      await context.addInitScript(electronBridge);
      await home(page);
      await page
        .getByRole('button', { name: /^Настройки$/ })
        .first()
        .click();
      await page.locator('.settings-nav__item').filter({ hasText: 'Оверлей' }).first().click();
      await page.waitForTimeout(800);
    },
  },
  'settings-desktop': {
    group: 'Клиент Windows',
    title: 'Настройки — раздел «Windows» в клиенте (E01-B2)',
    src: 'ui/settings/DesktopSection.tsx, ui/settings/sections.ts, core/desktop.ts',
    widths: [1024, 1440],
    context: { storage: SEEN },
    async open(page, { context }) {
      await context.addInitScript(electronBridge);
      await home(page);
      await page
        .getByRole('button', { name: /^Настройки$/ })
        .first()
        .click();
      await page.locator('.settings-nav__item').filter({ hasText: 'Windows' }).first().click();
      await page.waitForTimeout(800);
    },
  },
  'activity-login': {
    group: 'Главная',
    title: '«Активность» — вход владельца (E10-B)',
    src: 'ui/activity/Activity.tsx',
    widths: [360, 1440],
    context: { storage: SEEN },
    async open(page) {
      await page.goto(new URL('/activity', base).href);
      await page
        .getByRole('button', { name: /Войти/ })
        .first()
        .waitFor({ timeout: 20000 })
        .catch(() => {});
      await page.waitForTimeout(800);
    },
  },
});

/** Мост Electron с окном выбора источника (E01-B2): `capture.sources` отдаёт экраны и окна. */
function electronCaptureBridge() {
  const ids = {
    s1: 'screen:1:0',
    s2: 'screen:2:0',
    w1: 'window:101:0',
    w2: 'window:102:0',
    w3: 'window:103:0',
  };
  window.cordDesktop = {
    protocol: { major: 2, minor: 0 },
    features: [
      'hotkeys',
      'capture',
      'capture.system-audio',
      'overlay',
      'notify',
      'thumbar',
      'badge',
      'progress',
      'attention',
      'deeplink',
      'servers',
      'update',
      'power',
      'app.settings',
      'tray',
      'sleep',
      'autostart',
    ],
    app: { version: '1.0.0', arch: 'x64' },
    bootstrap: { profile: '', theme: 'system', showPing: false, notificationSounds: true, autoConnect: true },
    send() {},
    invoke(method) {
      if (method === 'capture.sources') {
        const answer = window.__sources();
        return Promise.resolve({
          ...answer,
          sources: answer.sources.map((s) => ({ ...s, id: ids[s.id], icon: s.icon ?? '' })),
        });
      }
      return Promise.resolve(null);
    },
    on: () => () => {},
  };
}

Object.assign(SINGLE, {
  'capture-picker': {
    multi: true,
    group: 'Клиент Windows',
    title: 'Окно показа в клиенте Windows — веб, единственное с 1.0.6 (R60)',
    src: 'ui/CapturePicker.tsx, core/desktop-capture.ts, ui/CallDock.tsx',
    widths: [1440],
    context: { storage: SEEN },
    async open(page, { context, shootAs }) {
      await context.addInitScript(thumbnails);
      await context.addInitScript(electronCaptureBridge);
      await home(page);
      await page
        .getByRole('button', { name: /Новая встреча/ })
        .first()
        .click();
      await page.getByLabel('Ваше имя').waitFor();
      await page.getByRole('button', { name: 'Начать встречу' }).click();
      // Медиа через dev-сервер не поднимется — окну выбора оно и не нужно.
      const share = page.getByRole('button', { name: /Показать экран/ }).first();
      await share.waitFor({ timeout: 30000 });
      await share.click();
      await page.locator('.capture-picker__grid').first().waitFor({ timeout: 10000 });
      await page
        .getByRole('tab', { name: 'Весь экран' })
        .click()
        .catch(() => {});
      await page
        .locator('.capture-picker__grid button')
        .first()
        .click()
        .catch(() => {});
      await page.waitForTimeout(600);
      await shootAs('capture-picker-screen', 'Окно показа — весь экран (R60)');
      await page
        .getByRole('tab', { name: 'Приложения' })
        .click()
        .catch(() => {});
      await page.waitForTimeout(500);
      await page
        .locator('.capture-picker__grid button')
        .nth(1)
        .click()
        .catch(() => {});
      await page.waitForTimeout(400);
      await shootAs('capture-picker-window', 'Окно показа — приложения (R60)');
    },
  },
});

// ---------------------------------------------------------------------------------------------
// Сценарии со встречей. Каждый — функция (stage) → список шагов { id, title, group, prepare };
// stage даёт настольную страницу (D), телефонную (M) и хелперов.

const SCENARIOS = {};

/** Создать встречу с главной; камера включается в прихожей. */
async function createMeeting(page, { camera = true, approval = false } = {}) {
  await home(page);
  await page
    .getByRole('button', { name: /Новая встреча/ })
    .first()
    .click();
  await page.getByLabel('Ваше имя').waitFor();
  if (approval) await page.getByText('Только с вашего подтверждения').click();
  if (camera)
    await page
      .getByRole('button', { name: 'Включить камеру', exact: true })
      .click()
      .catch(() => {});
  await page.getByRole('button', { name: 'Начать встречу' }).click();
  await connected(page);
  await page.waitForTimeout(1500);
}

/** Войти по коду: `/join/<9 цифр>` → прихожая → «Войти во встречу». */
async function joinByCode(page, code, { camera = false, wait = true } = {}) {
  await page.goto(new URL(`/join/${code}`, base).href);
  await page.getByRole('button', { name: 'Войти во встречу' }).waitFor({ timeout: 60000 });
  if (camera)
    await page
      .getByRole('button', { name: 'Включить камеру', exact: true })
      .click()
      .catch(() => {});
  await page.getByRole('button', { name: 'Войти во встречу' }).click();
  if (wait) {
    await connected(page);
    await page.waitForTimeout(1000);
  }
}

async function meetingCode(page) {
  const text = await page.getByRole('button', { name: 'Код встречи' }).innerText();
  return text.replace(/\D/g, '');
}

/**
 * Показ экрана без системного окна: холст с «рабочим столом» вместо getDisplayMedia (как
 * `e2e/screens.spec.ts`) — снимок одинаковый на любой машине.
 */
function fakeScreen() {
  if (!navigator.mediaDevices) return;
  navigator.mediaDevices.getDisplayMedia = async () => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 1920, height: 1080 });
    const g = canvas.getContext('2d');
    let t = 0;
    const draw = () => {
      t++;
      const sky = g.createLinearGradient(0, 0, 1920, 1080);
      sky.addColorStop(0, '#1e3a8a');
      sky.addColorStop(1, '#0f766e');
      g.fillStyle = sky;
      g.fillRect(0, 0, 1920, 1080);
      g.fillStyle = '#f8fafc';
      g.fillRect(240, 120, 1440, 820);
      g.fillStyle = '#e2e8f0';
      g.fillRect(240, 120, 1440, 56);
      ['#ef4444', '#f59e0b', '#22c55e'].forEach((c, i) => {
        g.fillStyle = c;
        g.beginPath();
        g.arc(276 + i * 30, 148, 9, 0, 7);
        g.fill();
      });
      g.fillStyle = '#0f172a';
      g.font = 'bold 64px sans-serif';
      g.fillText('План на неделю', 320, 290);
      g.font = '36px sans-serif';
      g.fillStyle = '#334155';
      ['1. Дизайн-ревью экранов встречи', '2. Кинозал: каталог и плеер', '3. Игры: турнир в пятницу'].forEach(
        (line, i) => g.fillText(line, 320, 390 + i * 70),
      );
      [220, 340, 280, 420, 380].forEach((h, i) => {
        g.fillStyle = i === 3 ? '#3564f3' : '#94a3b8';
        g.fillRect(1120 + i * 96, 880 - h, 60, h);
      });
      g.fillStyle = '#3564f3';
      g.fillRect(320, 720, 40 + ((t * 6) % 560), 14);
    };
    draw();
    setInterval(draw, 100);
    return canvas.captureStream(10);
  };
}

/** Участник-помощник: маленькое окно, чтобы машина тянула четверых. */
async function helper(code, name, { camera = false } = {}) {
  const context = await browser.newContext({
    viewport: { width: 800, height: 600 },
    colorScheme: 'dark',
    locale: 'ru-RU',
    permissions: ['camera', 'microphone'],
    serviceWorkers: 'block',
  });
  await context.addInitScript((n) => {
    localStorage.setItem('cord:name', n);
    localStorage.setItem('cord:theme', 'dark');
  }, name);
  await context.addInitScript(fakeScreen);
  context.setDefaultTimeout(60000);
  const page = await context.newPage();
  await routeCinemaIfAny(page);
  await joinByCode(page, code, { camera });
  return { context, page, name };
}

/**
 * Обрыв по требованию: WebSocket идёт через Playwright, `block()` рвёт его кодом 1013 и не даёт
 * подняться снова, `unblock()` пускает (как `e2e/recovery.spec.ts`, `e2e/control.spec.ts`).
 */
async function guardSockets(context, pattern, { reject = false } = {}) {
  const live = new Set();
  const buffered = [];
  let blocked = false;
  await context.routeWebSocket(pattern, (ws) => {
    // Канал событий: пока «обрыв», новые соединения закрываются. Медиа: соединение держится,
    // но ответы сервера копятся — так клиент видит тишину и ждёт, как при настоящем обрыве.
    if (blocked && reject) {
      ws.close({ code: 1013 }).catch(() => {});
      return;
    }
    live.add(ws);
    const server = ws.connectToServer();
    server.onMessage((message) => {
      if (blocked) buffered.push({ ws, message });
      else ws.send(message);
    });
  });
  return {
    async block() {
      blocked = true;
      for (const ws of live) await ws.close({ code: 1013, reason: 'Снимок обрыва' }).catch(() => {});
      live.clear();
    },
    unblock() {
      blocked = false;
      for (const { ws, message } of buffered.splice(0)) ws.send(message);
    },
  };
}

/** Записанные ответы кинозала из e2e (каталог, 12 с HLS) — если модуль подключился. */
let cinema = null;
try {
  cinema = await import('../e2e/support/cinema.ts');
} catch {
  cinema = null;
}
async function routeCinemaIfAny(page) {
  if (cinema) await cinema.routeCinema(page);
}

/**
 * Снять состояние у обоих зрителей: настольного на 1024 и 1440 (смена окна), телефонного на 360.
 * Тема — атрибутом, без перезагрузки.
 */
async function shootBoth(stage, id, { desk = true, phone = true } = {}) {
  for (const theme of THEMES) {
    if (stage.D && desk) {
      await setTheme(stage.D, theme);
      for (const width of WIDTHS.filter((w) => w >= 768)) {
        await stage.D.setViewportSize({ width, height: VIEW[width] });
        await stage.D.waitForTimeout(600);
        await shoot(stage.D, id, width, theme);
      }
    }
    if (stage.M && phone && WIDTHS.includes(360)) {
      await setTheme(stage.M, theme);
      await shoot(stage.M, id, 360, theme);
    }
  }
}

async function closeOverlays(page) {
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(120);
  }
}

/** Пункт меню «Настройки и действия» (на телефоне туда уходят панели и раскладка). */
async function moreItem(page, name) {
  await page.getByRole('button', { name: 'Настройки и действия' }).click();
  await page.getByRole('menuitem', { name }).first().click();
}

const panelOpen = (page) =>
  page
    .locator('aside.side-panel')
    .isVisible()
    .catch(() => false);

async function openPanel(page, name, mobileName = name) {
  const direct = page.getByRole('button', { name, exact: true });
  if (await direct.isVisible().catch(() => false)) await direct.click();
  else await moreItem(page, mobileName);
  await page.waitForTimeout(800);
}

async function closePanel(page) {
  const close = page.getByRole('button', { name: 'Закрыть панель' });
  if (await close.isVisible().catch(() => false)) await close.click();
  await page.waitForTimeout(400);
}

/** Раскрыть строку игры в группе «Игры» панели интеграций. */
async function openGameRow(page, game) {
  if (!(await panelOpen(page))) await openPanel(page, 'Интеграции');
  const tab = page.getByRole('tab', { name: 'Интеграции' });
  if (await tab.isVisible().catch(() => false)) await tab.click();
  const group = page.getByRole('button', { name: /^Игры/ }).first();
  const row = page.locator('.games-group button[aria-expanded]').filter({ hasText: game }).first();
  if (!(await row.isVisible().catch(() => false))) await group.click();
  if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click();
  await page.waitForTimeout(400);
}

/** Убрать игру со сцены: кнопка группы, при подтверждении — та же кнопка в окне. */
async function closeGame(page, game) {
  await openGameRow(page, game);
  const button = page
    .getByRole('button', { name: /Убрать стол из встречи|Закрыть игру|Закрыть шахматы|Закрыть Gartic/ })
    .first();
  await button.click();
  const dialog = page.getByRole('dialog');
  if (await dialog.isVisible().catch(() => false))
    await dialog
      .getByRole('button', { name: /Убрать|Закрыть/ })
      .last()
      .click();
  await page.waitForTimeout(1500);
}

async function seatEveryone(stage, seatSelector) {
  for (const page of [stage.D, stage.M, ...stage.people.map((p) => p.page)]) {
    const seat = page.locator(seatSelector).first();
    await seat.waitFor({ timeout: 20000 }).catch(() => {});
    if (await seat.isVisible().catch(() => false)) await seat.click().catch(() => {});
    await page.waitForTimeout(300);
  }
}

/**
 * Встреча на четверых: настольный зритель «Ника» (создатель), телефонный «Марк», помощники «Аня»
 * (камера, показ экрана) и «Борис». `--only meeting --steps a,b` снимает только названные шаги
 * после общей подготовки.
 */
SCENARIOS.meeting = async ({ titles }) => {
  const want = args.steps?.split(',');
  const needs = (id) => !want || want.includes(id);
  for (const s of SCENARIO_STEPS) titles[s.id] = { group: s.group, title: s.title, src: s.src, note: s.note };
  titles['meeting-solo'] = {
    group: 'Встреча',
    title: 'Встреча — один участник',
    src: 'ui/MeetingView.tsx, ui/Stage.tsx, ui/CallDock.tsx, ui/MeetingHeader.tsx',
  };
  const stage = {};
  const desk = await newContext(1440, THEMES[0], { name: 'Ника' });
  stage.guardD = {
    // Обрывы ставятся только когда шаги их снимают: прокси Playwright на канале событий — лишнее звено.
    rtc: needs('meeting-recovering') ? await guardSockets(desk, /\/rtc/) : null,
    events: needs('meeting-control-lost')
      ? await guardSockets(desk, /\/api\/v1\/events/, { reject: true })
      : null,
  };
  stage.D = await desk.newPage();
  await routeCinemaIfAny(stage.D);
  await createMeeting(stage.D, { camera: true });
  const code = await meetingCode(stage.D);
  console.log(`  встреча ${code}`);

  // «Один участник» — до того, как придут остальные (телефон — одиночным рецептом meeting-solo).
  if (!want || want.includes('meeting-solo')) await shootBoth({ D: stage.D }, 'meeting-solo');
  stage.people = [await helper(code, 'Аня', { camera: true }), await helper(code, 'Борис')];
  const phone = await newContext(360, THEMES[0], { name: 'Марк' });
  stage.guardM = {
    // Обрывы ставятся только когда шаги их снимают: прокси Playwright на канале событий — лишнее звено.
    rtc: needs('meeting-recovering') ? await guardSockets(phone, /\/rtc/) : null,
    events: needs('meeting-control-lost')
      ? await guardSockets(phone, /\/api\/v1\/events/, { reject: true })
      : null,
  };
  stage.M = await phone.newPage();
  await routeCinemaIfAny(stage.M);
  await joinByCode(stage.M, code);
  await stage.D.waitForTimeout(2500);

  for (const s of SCENARIO_STEPS) {
    if (want && !want.includes(s.id) && !s.always) continue;
    console.log(` шаг ${s.id}`);
    try {
      const shot = await s.run(stage);
      if (shot !== false) await shootBoth(stage, s.id, s.shoot ?? {});
    } catch (error) {
      console.log(`  ✗ ${s.id}: ${String(error).split('\n')[0]}`);
      await stage.D.screenshot({ path: path.join(out, `_fail-${s.id}-D.png`) }).catch(() => {});
      await stage.M.screenshot({ path: path.join(out, `_fail-${s.id}-M.png`) }).catch(() => {});
    } finally {
      if (s.after)
        await s.after(stage).catch((e) => console.log(`  ! после ${s.id}: ${String(e).split('\n')[0]}`));
      for (const p of [stage.D, stage.M]) await closeOverlays(p).catch(() => {});
      await stage.D.setViewportSize({ width: 1440, height: VIEW[1440] }).catch(() => {});
    }
  }
  for (const p of stage.people) await p.context.close();
  await phone.close();
  await desk.close();
};

/**
 * E15-B: всё новое во встрече одной встречей — сервер считает созданные встречи с адреса (E11-B:
 * 10 в час), а входы по коду и приглашению — нет. Создатель «Ника» (стол 1440/1024), телефон «Марк»
 * (Android), дальше на минуту заходят: телефоны iPhone/Android для подсказок о фоне, зрители с
 * «встреча завершится в …», Mini App Telegram. `--steps` — как у meeting.
 */
SCENARIOS['meeting-b'] = async ({ titles }) => {
  const want = args.steps?.split(',');
  const needs = (id) => !want || want.includes(id);
  const desk = await newContext(1440, THEMES[0], { name: 'Ника' });
  const D = await desk.newPage();
  const inviteUrl = await createWithInvite(D, { camera: true });
  const code = await meetingCode(D);
  console.log(`  встреча ${code}`);
  const phone = await newContext(360, THEMES[0], {
    name: 'Марк',
    userAgent: ANDROID,
    storage: { 'cord:background-note:android': '1' },
  });
  const M = await phone.newPage();
  await joinByCode(M, code);
  await D.waitForTimeout(1500);
  const stage = { D, M };
  const both = async (fn) => {
    await fn(D);
    await fn(M);
  };
  const run = async (id, title, src, job, opts) => {
    if (!needs(id)) return;
    titles[id] = { group: 'E15-B', title, src };
    console.log(` шаг ${id}`);
    await step(id, async () => {
      if ((await job()) !== false) await shootBoth(stage, id, opts ?? {});
    });
  };
  /** Отдельный зритель: снять в обеих темах на своей ширине (стол — 1024 и 1440). */
  const shootViewer = async (page, id, width) => {
    for (const theme of THEMES) {
      await setTheme(page, theme);
      if (width < 768) await shoot(page, id, 360, theme);
      else
        for (const w of WIDTHS.filter((x) => x >= 768)) {
          await page.setViewportSize({ width: w, height: VIEW[w] });
          await page.waitForTimeout(500);
          await shoot(page, id, w, theme);
        }
    }
  };
  const group = (page, name) =>
    page
      .locator('.services-panel .service-group')
      .filter({ has: page.getByText(name, { exact: true }) })
      .first();

  // --- Музыка (R44, E06-B) и выбор площадки кинозала (T59) ---
  // Экрана выбора площадки у музыки нет (R44): «Музыка» открывает плеер. Пока музыки во встрече нет —
  // одно действие «Добавить во встречу»; вкладки, поиск и очередь — после него. В конце музыку убирают:
  // бот держит комнату на стенде открытой.
  await run('music-intro', 'Музыка — ещё не во встрече (R44)', 'ui/music/MusicWidget.tsx', () =>
    both(async (p) => {
      await openPanel(p, 'Интеграции');
      await group(p, 'Музыка').click();
      await p.locator('.music-intro').first().waitFor({ timeout: 15000 });
      await p.waitForTimeout(500);
    }),
  );
  await run(
    'music-youtube',
    'Музыка — плеер, YouTube (R44)',
    'ui/music/MusicWidget.tsx, ui/integrations.css',
    async () => {
      await D.locator('.music-intro').getByRole('button', { name: 'Добавить во встречу' }).click();
      await both(async (p) => {
        await p.locator('.platform-tab').first().waitFor({ timeout: 30000 });
        await p.locator('.platform-tab').filter({ hasText: 'YouTube' }).first().click();
        await p.waitForTimeout(600);
      });
    },
  );
  await run(
    'music-search',
    'Музыка — найденные треки YouTube',
    'ui/Services.tsx, services/cord_services/sources.py',
    () =>
      both(async (p) => {
        const field = p
          .locator(
            '.services-panel input[type="search"], .services-panel input[type="text"], .services-panel input:not([type])',
          )
          .first();
        await field.fill('lofi hip hop');
        await field.press('Enter');
        await p.waitForTimeout(6000);
      }),
  );
  await run('music-files', 'Музыка — «Свои файлы»', 'ui/MusicUpload.tsx', () =>
    both(async (p) => {
      await p.getByRole('tab', { name: 'Свои файлы' }).first().click();
      await p.waitForTimeout(700);
    }),
  );
  await run('music-yandex', 'Музыка — Яндекс Музыка', 'ui/YandexIntegration.tsx', () =>
    both(async (p) => {
      const tab = p.getByRole('tab', { name: 'Яндекс Музыка' }).first();
      if (await tab.isVisible().catch(() => false)) await tab.click();
      await p.waitForTimeout(700);
    }),
  );
  // «Убрать музыку» — пункт меню «⋯» у трека (R128).
  await D.getByRole('button', { name: 'Ещё действия с музыкой' })
    .first()
    .click()
    .then(() => D.getByRole('menuitem', { name: /Убрать музыку/ }).click())
    .catch(() => {});
  await run(
    'cinema-picker',
    'Кинозал — «Выберите площадку» (T59)',
    'ui/PlatformPicker.tsx, ui/cinema/CinemaGroup.tsx',
    () =>
      both(async (p) => {
        const back = p.getByRole('button', { name: /Интеграции/ }).first();
        await back.click().catch(() => {});
        await p.waitForTimeout(600);
        if (
          !(await p
            .locator('.services-panel')
            .isVisible()
            .catch(() => false))
        )
          await openPanel(p, 'Интеграции');
        await group(p, 'Кинозал').click();
        await p.locator('.platform-picker').first().waitFor({ timeout: 15000 });
        await p.waitForTimeout(600);
      }),
  );
  for (const p of [D, M]) {
    await closeOverlays(p);
    await closePanel(p).catch(() => {});
  }

  // --- Чат: файл-программа и переход по ссылке (E11-B) ---
  await run(
    'chat-executable',
    'Чат — файл может запустить программу (E11-B)',
    'ui/abuse/Notices.tsx, ui/Sidebar.tsx',
    async () => {
      await both((p) => openPanel(p, 'Чат', 'Чат и файлы'));
      await D.locator('input[type=file][aria-label="Прикрепить файл"]').setInputFiles({
        name: 'Установщик.exe',
        mimeType: 'application/x-msdownload',
        buffer: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(4096, 1)]),
      });
      await both((p) => p.getByText('Установщик.exe').first().waitFor({ timeout: 30000 }));
      await D.waitForTimeout(1500);
    },
  );
  await run('chat-link-dialog', 'Чат — «Переход по ссылке» (E11-B)', 'ui/abuse/ChatText.tsx', async () => {
    if (
      !(await D.locator('.composer__input')
        .isVisible()
        .catch(() => false))
    )
      await both((p) => openPanel(p, 'Чат', 'Чат и файлы'));
    const input = D.locator('.composer__input').first();
    await input.fill('План на неделю: https://example.org/plan');
    await input.press('Enter');
    await both(async (p) => {
      const link = p.locator('.messages a').filter({ hasText: 'example.org' }).last();
      await link.waitFor({ timeout: 10000 });
      await link.click();
      await p.getByRole('dialog').waitFor({ timeout: 5000 });
      await p.waitForTimeout(400);
    });
  });
  for (const p of [D, M]) {
    await closeOverlays(p);
    await closePanel(p).catch(() => {});
  }

  // --- Телефон: «Свернуть в окно» (E12) ---
  if (needs('meeting-more-phone')) {
    titles['meeting-more-phone'] = {
      group: 'E15-B',
      title: 'Телефон — меню пульта с «Свернуть в окно»',
      src: 'ui/CallDock.tsx, media/pip.ts',
    };
    await step('meeting-more-phone', async () => {
      await M.getByRole('button', { name: 'Настройки и действия' }).click();
      await M.getByRole('menuitem').first().waitFor({ timeout: 5000 });
      await M.waitForTimeout(400);
      for (const theme of THEMES) {
        await setTheme(M, theme);
        await shoot(M, 'meeting-more-phone', 360, theme);
      }
      await closeOverlays(M);
    });
  }

  // --- «Встреча завершится в …» (E11-B): endsAt вписан в ответ входа зрителя ---
  if (needs('meeting-ceiling')) {
    titles['meeting-ceiling'] = {
      group: 'E15-B',
      title: 'Встреча — «Встреча завершится в …»',
      src: 'ui/abuse/Notices.tsx',
    };
    for (const [width, name] of [
      [1440, 'Борис'],
      [360, 'Аня'],
    ]) {
      const ctx = await newContext(width, THEMES[0], {
        name,
        userAgent: width < 768 ? ANDROID : undefined,
        storage: { 'cord:background-note:android': '1' },
      });
      // Снимки встречи приходят и каналом событий — в каждый вписывается тот же endsAt.
      let endsAt = null;
      const mark = (value) => {
        if (!value || typeof value !== 'object') return;
        if ('serverTime' in value && 'participants' in value)
          value.endsAt = endsAt ?? (endsAt = value.serverTime + 14 * 60_000);
        for (const v of Object.values(value)) mark(v);
      };
      await ctx.routeWebSocket(/\/api\/v1\/events/, (ws) => {
        const server = ws.connectToServer();
        server.onMessage((message) => {
          try {
            const data = JSON.parse(String(message));
            mark(data);
            ws.send(JSON.stringify(data));
          } catch {
            ws.send(message);
          }
        });
        ws.onMessage((message) => server.send(message));
      });
      await ctx.route(/\/api\/v1\/rooms\/(join-by-code|[^/]+\/join)$/, async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        const response = await route.fetch();
        const body = await response.json().catch(() => null);
        if (body) mark(body);
        await route.fulfill({ response, json: body });
      });
      const page = await ctx.newPage();
      await step(`meeting-ceiling-${width}`, async () => {
        await joinByCode(page, code);
        await page.locator('.abuse-notice').first().waitFor({ timeout: 10000 });
        await shootViewer(page, 'meeting-ceiling', width);
      });
      await ctx.close();
    }
  }

  // --- Подсказки о фоне на телефоне (E12) ---
  const notes = [
    ['background-android', ANDROID, null],
    ['background-ios', IPHONE, null],
    ['background-ios-home', IPHONE, 'standalone'],
    ['background-no-mic', ANDROID, 'nomic'],
  ];
  for (const [id, userAgent, mode] of notes) {
    if (!needs(id)) continue;
    console.log(` шаг ${id}`);
    const ctx = await newContext(360, THEMES[0], { name: 'Лена', userAgent });
    if (mode === 'standalone')
      await ctx.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
    if (mode === 'nomic')
      await ctx.addInitScript(() => {
        const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = (c) =>
          c && c.audio ? Promise.reject(new DOMException('Permission denied', 'NotAllowedError')) : real(c);
      });
    const page = await ctx.newPage();
    await step(id, async () => {
      await joinByCode(page, code);
      await page.locator('.background-note').waitFor({ timeout: 15000 });
      await page.waitForTimeout(300);
      await shootViewer(page, id, 360);
    });
    await ctx.close();
  }

  // --- Mini App Telegram во встрече (E09): вход по приглашению этой встречи ---
  if (needs('tg-meeting') && inviteUrl) {
    for (const theme of THEMES) {
      const ctx = await newContext(360, theme, { name: 'Ника', userAgent: ANDROID });
      const page = await ctx.newPage();
      await step(`tg-meeting-${theme}`, async () => {
        await openTelegram(page, ctx, theme, {
          roomId: 'x',
          title: 'Наша встреча',
          name: 'Ника Петрова',
          inviteUrl,
        });
        await connected(page);
        await page
          .locator('.background-note')
          .waitFor({ timeout: 12000 })
          .catch(() => {});
        await page.waitForTimeout(500);
        await shoot(page, 'tg-meeting-note', 360, theme);
        await page
          .getByRole('button', { name: 'Скрыть подсказку' })
          .click()
          .catch(() => {});
        await page.waitForTimeout(500);
        await shoot(page, 'tg-meeting', 360, theme);
      });
      await ctx.close();
    }
  }

  // --- Интеграции → Telegram у создателя (E09, T30): каталог службы с включённым Mini App ---
  if (needs('integrations-telegram')) {
    console.log(' шаг integrations-telegram');
    await step('integrations-telegram', async () => {
      await desk.route(/\/api\/v1\/services\/catalog/, async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        body.telegram = { username: 'cord_meet_bot', connected: true, webapp: true };
        await route.fulfill({ response, json: body });
      });
      await desk.route(/\/telegram\/link$/, (route) =>
        json(route, {
          command: '/bind 482913',
          expiresAt: Date.now() + 600_000,
          startgroupUrl: 'https://t.me/cord_meet_bot?startgroup=482913',
        }),
      );
      await desk.route(/\/telegram$/, (route) =>
        route.request().method() === 'GET'
          ? json(route, {
              links: [
                { id: 'l1', chatTitle: 'Команда дизайна', since: Date.now() - 3 * 86_400_000, pinned: true },
              ],
            })
          : route.continue(),
      );
      await D.reload();
      await connected(D);
      await D.waitForTimeout(1500);
      await openPanel(D, 'Интеграции');
      await D.locator('.services-panel .service-group').filter({ hasText: 'Telegram' }).first().click();
      await D.waitForTimeout(1500);
      await shootViewer(D, 'integrations-telegram', 1440);
    });
  }

  await phone.close();
  await desk.close();
};

/** Шаги встречи по порядку; `run` готовит D и M и возвращает false, если снимок не нужен. */
const SCENARIO_STEPS = [
  {
    id: 'meeting-grid',
    group: 'Встреча',
    title: 'Встреча — сетка, четверо',
    src: 'ui/Stage.tsx, ui/grid.ts, ui/stage.css, ui/CallDock.tsx',
    async run() {},
  },
  {
    id: 'meeting-speaker',
    group: 'Встреча',
    title: 'Встреча — раскладка «Говорящий»',
    src: 'ui/LayoutMenu.tsx, ui/Stage.tsx',
    async run({ D, M }) {
      await D.getByRole('button', { name: 'Расположение участников' }).click();
      await D.getByRole('menuitem', { name: /Говорящий/ }).click();
      await M.getByRole('button', { name: 'Настройки и действия' }).click();
      // На телефоне раскладка — пункт меню «ещё»; меню появляется с анимацией, ждать пункт.
      await M.getByRole('menuitem', { name: /Говорящий/ }).click({ timeout: 10000 });
      await D.waitForTimeout(1500);
    },
    async after({ D, M }) {
      await closeOverlays(D);
      await D.getByRole('button', { name: 'Расположение участников' }).click();
      await D.getByRole('menuitem', { name: /Сетка/ }).click();
      await closeOverlays(M);
      await M.getByRole('button', { name: 'Настройки и действия' }).click();
      await M.getByRole('menuitem', { name: /Сетка/ }).click({ timeout: 10000 });
    },
  },
  {
    id: 'meeting-chat',
    group: 'Встреча',
    title: 'Встреча — панель «Чат и файлы»',
    src: 'ui/Sidebar.tsx, ui/chat.ts, ui/meeting-panel.css',
    async run({ D, M, people }) {
      const anya = people[0].page;
      await openPanel(anya, 'Чат', 'Чат и файлы');
      for (const line of [
        'Всем привет! Начинаем через минуту',
        'Скинула план на неделю — посмотрите до пятницы',
      ]) {
        await anya.getByRole('textbox', { name: 'Сообщение' }).fill(line);
        await anya.keyboard.press('Enter');
        await anya.waitForTimeout(500);
      }
      await closePanel(anya);
      await openPanel(D, 'Чат', 'Чат и файлы');
      await D.getByRole('textbox', { name: 'Сообщение' }).fill('Привет! Я тут, слышно хорошо');
      await D.keyboard.press('Enter');
      await openPanel(M, 'Чат', 'Чат и файлы');
      await M.waitForTimeout(1000);
    },
    async after({ D, M }) {
      await closePanel(D);
      await closePanel(M);
    },
  },
  {
    id: 'meeting-people',
    group: 'Встреча',
    title: 'Встреча — панель «Участники»',
    src: 'ui/Sidebar.tsx',
    async run({ D, M }) {
      await openPanel(D, 'Участники');
      await openPanel(M, 'Участники');
    },
    async after({ D, M }) {
      await closePanel(D);
      await closePanel(M);
    },
  },
  {
    id: 'meeting-participant-menu',
    group: 'Встреча',
    title: 'Встреча — меню участника (громкость, закрепить, удалить)',
    src: 'ui/ParticipantMenu.tsx',
    async run({ D, M }) {
      await D.locator('.person-tile').filter({ hasText: 'Аня' }).first().click({ button: 'right' });
      await D.getByRole('menu').first().waitFor();
      await openPanel(M, 'Участники');
      await M.getByRole('button', { name: /Действия: Аня/ })
        .first()
        .click();
      await M.waitForTimeout(600);
    },
    async after({ M }) {
      await closeOverlays(M);
      await closePanel(M);
    },
  },
  {
    id: 'meeting-integrations',
    group: 'Встреча',
    title: 'Встреча — панель «Интеграции»',
    src: 'ui/Services.tsx, ui/ServiceRoster.tsx, ui/cinema/CinemaGroup.tsx, ui/GamesGroup.tsx',
    async run({ D, M }) {
      await openPanel(D, 'Интеграции');
      await openPanel(M, 'Интеграции');
    },
    async after({ D, M }) {
      await closePanel(D);
      await closePanel(M);
    },
  },
  {
    id: 'meeting-more',
    group: 'Встреча',
    title: 'Встреча — меню «Настройки и действия»',
    src: 'ui/CallDock.tsx',
    async run({ D, M }) {
      await D.getByRole('button', { name: 'Настройки и действия' }).click();
      await M.getByRole('button', { name: 'Настройки и действия' }).click();
      await D.waitForTimeout(500);
    },
  },
  {
    id: 'meeting-diagnostics',
    group: 'Диалоги и прочее',
    title: 'Окно «Диагностика»',
    src: 'ui/Diagnostics.tsx, ui/DeviceCheck.tsx',
    async run({ D, M }) {
      await moreItem(D, 'Диагностика');
      await moreItem(M, 'Диагностика');
      await D.waitForTimeout(1500);
    },
  },
  {
    id: 'meeting-invite',
    group: 'Диалоги и прочее',
    title: 'Окно «Пригласить во встречу»',
    src: 'ui/Invite.tsx',
    async run({ D, M }) {
      await D.getByRole('button', { name: 'Пригласить участников', exact: true }).click();
      await M.getByRole('button', { name: 'Пригласить участников', exact: true }).click();
      await D.getByRole('dialog').waitFor();
      await D.waitForTimeout(800);
    },
  },
  {
    id: 'meeting-settings',
    group: 'Настройки',
    title: 'Настройки поверх встречи',
    src: 'ui/settings/SettingsWindow.tsx, ui/CallDock.tsx',
    async run({ D, M }) {
      await moreItem(D, /^Настройки$/);
      await moreItem(M, /^Настройки$/);
      await D.waitForTimeout(900);
    },
  },
  {
    id: 'meeting-room-settings',
    group: 'Встреча',
    title: 'Окно «Настройки встречи» (создатель)',
    src: 'ui/MeetingSettings.tsx',
    shoot: { phone: false },
    async run({ D }) {
      await moreItem(D, 'Настройки встречи');
      await D.getByRole('dialog').waitFor();
      await D.waitForTimeout(800);
    },
  },
  {
    id: 'meeting-screen-tile',
    group: 'Встреча',
    title: 'Демонстрация — Аня показывает экран, у зрителей «Смотреть стрим»',
    src: 'ui/Stage.tsx, media/session.ts',
    async run({ D, people }) {
      const anya = people[0].page;
      await closeOverlays(anya);
      await anya.getByRole('button', { name: 'Показать экран' }).click();
      await anya.getByRole('button', { name: 'Остановить показ' }).waitFor({ timeout: 30000 });
      await D.waitForTimeout(6000);
    },
  },
  {
    id: 'meeting-screen',
    group: 'Встреча',
    title: 'Демонстрация — экран на сцене',
    src: 'ui/Stage.tsx, ui/stage.css',
    async run({ D, M }) {
      for (const page of [D, M]) {
        const watch = page.getByRole('button', { name: /Смотреть стрим/ }).first();
        await watch.waitFor({ timeout: 20000 });
        await watch.click();
        await page.locator('video.screen-video').first().waitFor({ timeout: 20000 });
      }
      await D.waitForTimeout(3000);
    },
    async after({ D, M, people }) {
      for (const page of [D, M]) {
        const back = page.getByRole('button', { name: /Вернуться в разговор/ }).first();
        if (await back.isVisible().catch(() => false)) await back.click();
      }
      const anya = people[0].page;
      await anya.getByRole('button', { name: 'Остановить показ' }).click();
      await D.waitForTimeout(1500);
    },
  },
  {
    id: 'cinema-catalog',
    group: 'Кинозал',
    title: 'Кинозал — каталог YouTube (поиск)',
    src: 'ui/cinema/CinemaGroup.tsx, ui/cinema/catalog/*, ui/cinema/cinema.css',
    note: 'Ответы службы кинозала — записанные (e2e/support/cinema.ts), как в e2e: живые площадки просят подтверждения «не бот».',
    async run({ D, M }) {
      if (!cinema) throw new Error('нет e2e/support/cinema.ts');
      const browse = await cinema.openCinema(D, 'YouTube');
      await browse.locator('.cinema-search input').fill('never gonna give you up');
      await D.waitForTimeout(2500);
      const mobileBrowse = await cinema.openCinema(M, 'YouTube');
      await mobileBrowse.locator('.cinema-search input').fill('never gonna give you up');
      await M.waitForTimeout(2500);
    },
  },
  {
    id: 'cinema-detail',
    group: 'Кинозал',
    title: 'Кинозал — карточка ролика',
    src: 'ui/cinema/catalog/*',
    async run({ D, M }) {
      const video = cinema.fixture('youtube-search-never-gonna-give-you-up').items[0];
      for (const page of [D, M]) {
        await page
          .locator('.cinema-browser')
          .getByRole('button', { name: `Подробнее: ${video.title}`, exact: true })
          .click({ force: true });
        await page.locator('.cinema-detail').waitFor();
      }
      await D.waitForTimeout(1500);
    },
  },
  {
    id: 'cinema-player',
    group: 'Кинозал',
    title: 'Кинозал — плеер «Смотреть вместе», люди лентой',
    src: 'ui/cinema/theater/*, ui/cinema/theater.css',
    async run({ D, M }) {
      await D.locator('.cinema-browser')
        .getByRole('button', { name: /Смотреть вместе/ })
        .click({ force: true });
      // Каталог личный: у телефона он остался открытым поверх плеера — закрыть его.
      const back = M.getByRole('button', { name: /Вернуться к просмотру|Закрыть каталог/ }).first();
      await back.waitFor({ timeout: 15000 }).catch(() => {});
      if (await back.isVisible().catch(() => false)) await back.click();
      for (const page of [D, M]) await page.locator('.watch-theater').waitFor({ timeout: 30000 });
      await M.waitForTimeout(4000);
      for (const page of [D, M])
        await page
          .locator('.watch-theater')
          .hover()
          .catch(() => {});
    },
    async after({ D }) {
      await D.locator('.watch-theater')
        .hover()
        .catch(() => {});
      const close = D.getByRole('button', { name: /Закрыть просмотр для всех|Закрыть для всех/ }).first();
      if (await close.isVisible().catch(() => false)) await close.click();
      await D.waitForTimeout(2000);
      await closePanel(D);
    },
  },
  {
    id: 'games-panel',
    group: 'Игры',
    title: 'Игры — группа в панели интеграций',
    src: 'ui/GamesGroup.tsx',
    shoot: { phone: true },
    async run({ D, M }) {
      await openGameRow(D, /Покер/);
      await openPanel(M, 'Интеграции');
      const group = M.getByRole('button', { name: /^Игры/ }).first();
      await group.click().catch(() => {});
      await M.waitForTimeout(800);
    },
    async after({ M }) {
      await closePanel(M);
    },
  },
  {
    id: 'game-poker',
    group: 'Игры',
    title: 'Покер — раздача на четверых',
    src: 'ui/PokerTable.tsx, poker.css, ui/GamesGroup.tsx',
    async run(stage) {
      const { D } = stage;
      await openGameRow(D, /Покер/);
      await D.getByRole('button', { name: /Открыть стол/ })
        .first()
        .click();
      await D.locator('.poker-felt').waitFor({ timeout: 30000 });
      await seatEveryone(stage, '.game-seat-action');
      await D.locator('.games-group').getByRole('button', { name: 'Раздать', exact: true }).click();
      await D.locator('.poker-mine-cards .playing-card').first().waitFor({ timeout: 30000 });
      await closePanel(D);
      await D.waitForTimeout(3500);
    },
    async after({ D }) {
      await closeGame(D, /Покер/);
      await closePanel(D);
    },
  },
  {
    id: 'game-durak',
    group: 'Игры',
    title: 'Дурак — раздача на четверых',
    src: 'ui/DurakTable.tsx, ui/DurakMotion.tsx, durak.css, ui/durak-motion.css',
    async run(stage) {
      const { D } = stage;
      await openGameRow(D, /Дурак/);
      await D.getByRole('button', { name: /Открыть стол/ })
        .first()
        .click();
      await D.locator('.durak-felt').waitFor({ timeout: 30000 });
      await seatEveryone(stage, '.durak >> role=button[name="Сесть за стол"]');
      await D.locator('.games-group').getByRole('button', { name: 'Раздать', exact: true }).click();
      await closePanel(D);
      await D.waitForTimeout(5000);
    },
    async after({ D }) {
      await closeGame(D, /Дурак/);
      await closePanel(D);
    },
  },
  {
    id: 'game-chess',
    group: 'Игры',
    title: 'Шахматы — партия: Ника белыми, Аня чёрными',
    src: 'ui/ChessTable.tsx, chess.css',
    async run({ D, M, people }) {
      await openGameRow(D, /Шахматы/);
      await D.getByRole('button', { name: /Открыть доску/ })
        .first()
        .click();
      // Кто открыл доску, тот уже за белыми; кнопка «Играть белыми» есть, только если места нет.
      const white = D.getByRole('button', { name: /Играть белыми/ }).first();
      if (
        await white.waitFor({ timeout: 4000 }).then(
          () => true,
          () => false,
        )
      )
        await white.click();
      // Чёрными — первый, у кого получилось: окно помощника маленькое, у телефона доска своя.
      let black = false;
      for (const page of [...people.map((p) => p.page), M]) {
        const button = page.getByRole('button', { name: /Играть чёрными/ }).first();
        try {
          // Кнопка места чёрных у верхнего края доски уходит под липкую шапку встречи — нажатие
          // мышью до неё не доходит; событие отдаётся кнопке напрямую.
          await button.waitFor({ timeout: 8000 });
          await button.dispatchEvent('click');
          await D.waitForFunction(
            () =>
              [...document.querySelectorAll('button')].some(
                (b) => /Начать партию/.test(b.textContent) && !b.disabled,
              ),
            null,
            { timeout: 8000 },
          );
          black = true;
          break;
        } catch {
          /* следующий */
        }
      }
      // Не сел второй — снимок остаётся честным: доска открыта, Ника за белыми ждёт соперника.
      if (black)
        await D.getByRole('button', { name: /Начать партию/ })
          .first()
          .click({ timeout: 30000 });
      else console.log('  ! чёрные не заняты — снимается доска в ожидании соперника');
      await closePanel(D);
      await D.waitForTimeout(3000);
    },
    async after({ D }) {
      const close = D.getByRole('button', { name: 'Закрыть шахматы' }).first();
      if (await close.isVisible().catch(() => false)) {
        await close.click();
        await D.getByRole('dialog').getByRole('button', { name: 'Закрыть шахматы' }).click();
      } else await closeGame(D, /Шахматы/);
      await D.waitForTimeout(1500);
      await closePanel(D);
    },
  },
  {
    id: 'game-gartic',
    group: 'Игры',
    title: 'Gartic — «Угадай рисунок», первый ход',
    src: 'ui/GarticTable.tsx, ui/GarticCanvas.tsx, gartic.css',
    async run({ D, M, people }) {
      await openGameRow(D, /Gartic/);
      await D.getByText('Угадай рисунок')
        .first()
        .click()
        .catch(() => {});
      await D.getByRole('button', { name: /Открыть Gartic/ })
        .first()
        .click();
      for (const page of [D, M, ...people.map((p) => p.page)]) {
        const join = page.getByRole('button', { name: 'Присоединиться', exact: true }).first();
        await join.waitFor({ timeout: 20000 }).catch(() => {});
        if (await join.isVisible().catch(() => false)) await join.click().catch(() => {});
      }
      await D.getByRole('button', { name: /Начать игру/ })
        .first()
        .click({ timeout: 30000 });
      await closePanel(D);
      await D.waitForTimeout(4000);
    },
    async after({ D }) {
      const close = D.getByRole('button', { name: 'Закрыть Gartic' }).first();
      if (await close.isVisible().catch(() => false)) {
        await close.click();
        const dialog = D.getByRole('dialog');
        if (await dialog.isVisible().catch(() => false))
          await dialog
            .getByRole('button', { name: /Закрыть/ })
            .last()
            .click();
      } else await closeGame(D, /Gartic/);
      await D.waitForTimeout(1500);
      await closePanel(D);
    },
  },
  {
    id: 'games-history',
    group: 'Игры',
    title: 'Окно «История игр»',
    src: 'ui/GamesGroup.tsx, ui/PokerResult.tsx',
    shoot: { phone: false },
    async run({ D }) {
      if (!(await panelOpen(D))) await openPanel(D, 'Интеграции');
      const group = D.getByRole('button', { name: /^Игры/ }).first();
      const history = D.getByRole('button', { name: /История игр/ }).first();
      if (!(await history.isVisible().catch(() => false))) await group.click();
      await history.click();
      await D.getByRole('dialog').waitFor();
      await D.waitForTimeout(800);
    },
    async after({ D }) {
      await closeOverlays(D);
      await closePanel(D);
    },
  },
  {
    id: 'meeting-control-lost',
    group: 'Встреча',
    title: 'Обрыв управления — «Восстанавливаем чат и управление…»',
    src: 'ui/MeetingView.tsx, core/meeting.ts',
    async run({ D, guardD, guardM }) {
      await guardD.events.block();
      await guardM.events.block();
      await D.getByText(/Восстанавливаем чат и управление/)
        .first()
        .waitFor({ timeout: 30000 });
      await D.waitForTimeout(800);
    },
    async after({ D, guardD, guardM }) {
      guardD.events.unblock();
      guardM.events.unblock();
      await D.waitForTimeout(6000);
    },
  },
  {
    id: 'meeting-recovering',
    group: 'Встреча',
    title: 'Обрыв медиа — «Возвращаемся в разговор», обратный отсчёт',
    src: 'ui/MeetingView.tsx, ui/MeetingHeader.tsx (TEXT.recovering), media/session.ts',
    async run({ D, guardD, guardM }) {
      await guardD.rtc.block();
      await guardM.rtc.block();
      await D.getByText(/Возвращаемся в разговор/)
        .first()
        .waitFor({ timeout: 20000 });
      await D.waitForTimeout(500);
    },
    async after({ D, guardD, guardM }) {
      guardD.rtc.unblock();
      guardM.rtc.unblock();
      await connected(D).catch(() => {});
      await D.waitForTimeout(4000);
    },
  },
  {
    id: 'meeting-ended',
    group: 'Встреча',
    title: 'Встреча завершена для всех',
    src: 'ui/MeetingView.tsx (экран завершения)',
    async run({ D }) {
      await moreItem(D, 'Завершить для всех');
      const dialog = D.getByRole('dialog');
      if (await dialog.isVisible().catch(() => false))
        await dialog
          .getByRole('button', { name: /Завершить/ })
          .last()
          .click();
      await D.getByRole('heading', { name: /Встреча завершена/ }).waitFor({ timeout: 30000 });
      await D.waitForTimeout(1500);
    },
  },
];

// ---------------------------------------------------------------------------------------------

const singleTitles = {};
async function runSingle(id, spec) {
  // --toggle-theme: одно открытие на ширину, вторая тема — атрибутом без перезагрузки (вдвое меньше
  // контекстов на нагруженной машине). Многокадровые рецепты и `spec.reload` снимаются по-старому.
  const themes = spec.themes ?? THEMES;
  // Окна оболочки — своих размеров (`spec.sizes`: [[ширина, высота]]), остальное — общие ширины.
  const targets = spec.sizes
    ? spec.sizes.filter(([w]) => !args.widths || WIDTHS.includes(w))
    : WIDTHS.filter((w) => !spec.widths || spec.widths.includes(w)).map((w) => [w, undefined]);
  if (args['toggle-theme'] && spec.multi && !spec.reload) {
    // Многокадровый рецепт: каждое его состояние снимается во всех темах сменой атрибута.
    for (const [width, height] of targets) {
      const context = await newContext(width, themes[0], { ...spec.context, height });
      const page = await context.newPage();
      const shootAs = async (as, title) => {
        if (title) singleTitles[as] = { group: spec.group, title, src: spec.src };
        for (const [index, theme] of themes.entries()) {
          if (index > 0) await setTheme(page, theme);
          await shoot(page, as, width, theme, spec);
        }
        if (themes.length > 1) await setTheme(page, themes[0]);
      };
      try {
        await spec.open(page, { width, theme: themes[0], context, shootAs });
      } catch (error) {
        await page.screenshot({ path: path.join(out, `_fail-${id}-${width}.png`) }).catch(() => {});
        console.log(`  ✗ ${id}-${width}: ${String(error).split('\n')[0]}`);
        record({ id, width, theme: themes[0], error: String(error).split('\n')[0] });
      } finally {
        await context.close();
      }
    }
    return;
  }
  if (args['toggle-theme'] && !spec.multi && !spec.reload) {
    for (const [width, height] of targets) {
      const context = await newContext(width, themes[0], { ...spec.context, height });
      const page = await context.newPage();
      try {
        await spec.open(page, { width, theme: themes[0], context, shootAs: null }).catch(async (error) => {
          await page.screenshot({ path: path.join(out, `_fail-${id}-${width}.png`) }).catch(() => {});
          throw error;
        });
        for (const [index, theme] of themes.entries()) {
          if (index > 0) await setTheme(page, theme);
          await shoot(page, id, width, theme, spec);
        }
      } catch (error) {
        console.log(`  ✗ ${id}-${width}: ${String(error).split('\n')[0]}`);
        for (const theme of themes) record({ id, width, theme, error: String(error).split('\n')[0] });
      } finally {
        await context.close();
      }
    }
    return;
  }
  for (const theme of THEMES) {
    for (const width of WIDTHS) {
      if (spec.widths && !spec.widths.includes(width)) continue;
      const context = await newContext(width, theme, spec.context ?? {});
      const page = await context.newPage();
      try {
        // Многокадровый рецепт снимает сам: `shootAs(id, title)` — состояние со своим именем.
        const shootAs = async (as, title) => {
          if (title) singleTitles[as] = { group: spec.group, title, src: spec.src };
          await shoot(page, as, width, theme, spec);
        };
        await spec.open(page, { width, theme, context, shootAs });
        if (!spec.multi) await shoot(page, id, width, theme, spec);
      } catch (error) {
        console.log(`  ✗ ${id}-${width}-${theme}: ${String(error).split('\n')[0]}`);
        record({ id, width, theme, error: String(error).split('\n')[0] });
      } finally {
        await context.close();
      }
    }
  }
}

if (args.list) {
  for (const [id, spec] of Object.entries(SINGLE)) console.log(`${spec.group} · ${id} — ${spec.title}`);
  for (const id of Object.keys(SCENARIOS)) console.log(`сценарий · ${id}`);
  await browser.close();
  process.exit(0);
}

const titlesFile = path.join(out, 'titles.json');
const titles = existsSync(titlesFile) ? JSON.parse(readFileSync(titlesFile, 'utf8')) : {};
for (const [id, spec] of Object.entries(SINGLE)) {
  if (!spec.multi) titles[id] = { group: spec.group, title: spec.title, src: spec.src, note: spec.note };
  if (only && !only.includes(id)) continue;
  console.log(`${id} — ${spec.title}`);
  await runSingle(id, spec);
}
Object.assign(titles, singleTitles);
for (const [id, scenario] of Object.entries(SCENARIOS)) {
  if (only && !only.includes(id)) continue;
  console.log(`сценарий ${id}`);
  try {
    await scenario({ titles });
  } catch (error) {
    console.log(`  ✗ сценарий ${id}: ${String(error).split('\n')[0]}`);
  }
}
writeFileSync(titlesFile, JSON.stringify(titles, null, 1));
// Встречи-подставки закрываются вместе с окнами: ядро уберёт их после срока восстановления.
for (const held of [host, gate]) await held?.context.close().catch(() => {});
await browser.close();
