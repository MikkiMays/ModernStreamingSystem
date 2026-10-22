// Скриншоты экранов Cord на нескольких ширинах и в обеих темах, плюс отчёт о переполнении.
//
//   node scripts/shots.mjs --base https://cord.nikg.tech --out ../backlog/screens/E00/before
//   node scripts/shots.mjs --screens home,settings --widths 390,1440 --themes dark
//   node scripts/shots.mjs --base http://127.0.0.1:5173 --screens kit-integrations --themes light
//   node scripts/shots.mjs --screens settings --scrollbars 1   # полосы прокрутки как у человека
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
// Playwright без окна прячет полосы прокрутки (`--hide-scrollbars`): для снимков полос (R17) их
// возвращают, и ширина страницы тогда считается так же, как у человека.
const scrollbars = args.scrollbars === '1';

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
    // Уже 960 px «Настройки» главной — в выдвижном меню под бургером (E02).
    const burger = page.getByRole('button', { name: 'Открыть меню' });
    if (await burger.isVisible()) await burger.click();
    await page
      .getByRole('button', { name: /Настройки/ })
      .first()
      .click();
    // Разделы — список слева (E03); у прежней сборки — вкладки сверху.
    const nav = page.getByRole('navigation', { name: 'Разделы настроек' });
    const items = (await nav.count()) ? nav.locator('.settings-nav__item') : page.getByRole('tab');
    await items.first().waitFor();
    const back = page.getByRole('button', { name: 'К разделам' });
    if (await nav.count()) await shoot('settings-list');
    for (let i = 0; i < (await items.count()); i++) {
      if (await back.isVisible()) await back.click();
      const item = items.nth(i);
      const name = (await item.innerText()).trim().toLowerCase().replace(/\s+/g, '-');
      await item.click();
      await page.waitForTimeout(250);
      await shoot(`settings-${i}-${name}`);
    }
    return null;
  },
  meeting: async (page) => {
    await meeting(page);
    return 'meeting';
  },
  // Витрина набора (`/kit`) целиком: обе темы колонками рядом. Нужен только dev-сервер или сборка.
  kit: async (page, shoot) => {
    await page.goto(new URL('/kit', base).href);
    await page.getByRole('heading', { name: 'Набор примитивов' }).waitFor();
    await page.addStyleTag({ content: '.kit__bar { position: static !important; }' });
    await page.evaluate(() => document.fonts.ready);
    await shoot('kit', page.locator('.kit__panes'));
    return null;
  },
  // Кольцо фокуса от Shift (R26, R75): мышью открыть, нажать Shift, снять — колец быть не должно.
  // Меню избранного — на подставном списке (`/favorites`), чтобы не трогать избранное стенда.
  focus: async (page, shoot) => {
    await page.route('**/api/v1/favorites', (route) =>
      route.request().method() === 'GET' ? route.fulfill({ json: [SAMPLE_FAVORITE] }) : route.fallback(),
    );
    await page.route('**/api/v1/favorites/groups', (route) => route.fulfill({ json: [] }));
    await home(page);
    const burger = page.getByRole('button', { name: 'Открыть меню' });
    if (await burger.isVisible()) await burger.click();
    await page
      .getByRole('button', { name: `Действия с «${SAMPLE_FAVORITE.title}»` })
      .first()
      .click();
    await page.getByRole('menuitem', { name: 'Переименовать' }).hover();
    await page.keyboard.press('Shift');
    await shoot('focus-favorites-menu');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Shift');
    await shoot('focus-favorites-trigger');
    await page.reload();
    await page.getByRole('button', { name: /Новая встреча/ }).waitFor({ timeout: 30000 });
    if (await burger.isVisible()) await burger.click();
    await page
      .getByRole('button', { name: 'Настройки', exact: true })
      .filter({ visible: true })
      .first()
      .click();
    await page.getByRole('dialog', { name: 'Настройки' }).waitFor();
    await page.waitForTimeout(300);
    await page.keyboard.press('Shift');
    await shoot('focus-settings');
    // Щелчок по пустому месту окна отдаёт фокус самому окну (`tabindex=-1`): «выделяются окна».
    await page.getByRole('dialog', { name: 'Настройки' }).getByRole('heading', { name: 'Настройки' }).click();
    await page.keyboard.press('Shift');
    await shoot('focus-settings-window');
    // С клавиатуры кольцо на месте: Tab переводит в режим клавиатуры (S1).
    await page.keyboard.press('Tab');
    await shoot('focus-settings-tab');
    return null;
  },
  // Полосы прокрутки (R17): окно настроек, курсор над содержимым (у длинных колонок бегунок виден
  // только под курсором), прокручено до середины. Снимать с `--scrollbars 1`.
  scrollbars: async (page, shoot) => {
    await home(page);
    const burger = page.getByRole('button', { name: 'Открыть меню' });
    if (await burger.isVisible()) await burger.click();
    await page
      .getByRole('button', { name: 'Настройки', exact: true })
      .filter({ visible: true })
      .first()
      .click();
    const content = page.locator('.settings-content');
    await content.waitFor();
    await content.evaluate((element) => element.scrollTo(0, element.scrollHeight / 3));
    await content.hover({ position: { x: 40, y: 200 } });
    await page.waitForTimeout(300);
    await shoot('scrollbars-settings');
    return null;
  },
  // Витрина интеграций и музыка во встрече (E06-B). Музыку во встречу не добавляет: бот занял бы
  // место в комнате стенда, а из опустевшей комнаты с пустой очередью он не уходит сам.
  integrations: async (page, shoot) => {
    await meeting(page);
    const direct = page.getByRole('button', { name: 'Интеграции', exact: true });
    if (await direct.isVisible()) await direct.click();
    else {
      // На телефоне правая группа пульта — в «ещё» (E04).
      await page.getByRole('button', { name: 'Настройки и действия' }).click();
      await page.getByRole('menuitem', { name: /Интеграции/ }).click();
    }
    await page.locator('.services-panel').waitFor();
    await page.waitForTimeout(400);
    await shoot('integrations');
    await page
      .locator('.service-group')
      .filter({ has: page.locator('b', { hasText: /^Музыка$/ }) })
      .click();
    await page.waitForTimeout(600);
    await shoot('integrations-music');
    return null;
  },
  // Витрина и музыка на образцах страницы набора (`/kit` → «Интеграции»), обложки — подставные
  // картинки. Нужен только dev-сервер или сборка, не стенд. Снимается колонка той темы, что у страницы:
  // компонентные токены (`--field-bg` и др.) считаются на `:root`, и в колонке другой темы поля
  // остались бы в теме страницы — так бывает только на витрине, в приложении тема одна.
  'kit-integrations': async (page, shoot) => {
    await page.route('**/api/v1/services/music/covers/**', (route) =>
      route.fulfill({ contentType: 'image/svg+xml', body: cover(route.request().url()) }),
    );
    await page.goto(new URL('/kit', base).href);
    const theme = await page.evaluate(() => localStorage.getItem('cord:theme') ?? 'light');
    const section = page.locator(`.kit__pane[data-theme='${theme}'] .kit-integrations`);
    await section.waitFor();
    // Липкая шапка набора легла бы поверх снимка элемента; CSS набора приезжает отдельным чанком.
    await page.addStyleTag({ content: '.kit__bar { position: static !important; }' });
    await page.evaluate(() => document.fonts.ready);
    const search = section.getByRole('searchbox');
    await search.fill('ночной город');
    await search.press('Enter');
    // Поле — площадки YouTube (T59): найденное приходит одной группой.
    await section.getByText('Клуб', { exact: true }).waitFor();
    await section.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await shoot('kit-integrations', section);
    // Страница набора на телефоне шире окна сама по себе (переключатель темы, разделы набора), поэтому
    // переполнение здесь меряется внутри рамок панели: ни один элемент не выходит за их край.
    const spills = await section.evaluate((root) =>
      [...root.querySelectorAll('.kit-integrations__frame')].flatMap((frame) => {
        const edge = frame.getBoundingClientRect().right + 1;
        return [...frame.querySelectorAll('*')]
          .filter(
            (element) =>
              element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().right > edge,
          )
          .slice(0, 6)
          .map((element) => `${element.tagName.toLowerCase()}.${String(element.className).split(' ')[0]}`);
      }),
    );
    if (spills.length) throw new Error(`за краем панели: ${spills.join(', ')}`);
    return null;
  },
};

async function meeting(page) {
  await home(page);
  await page.getByRole('button', { name: /Новая встреча/ }).click();
  await page.getByLabel('Ваше имя').fill('Снимок');
  await page.getByRole('button', { name: 'Начать встречу' }).click();
  await connected(page);
  await page.waitForTimeout(800);
}

/** Подставная комната избранного для снимков меню (форма `Favorite` ядра). */
const SAMPLE_FAVORITE = {
  roomId: '00000000-0000-4000-8000-0000000000aa',
  code: '123456789',
  title: 'Планёрка',
  alias: null,
  groupId: null,
  pinned: false,
  closed: false,
  canJoin: true,
  savedAt: 1760000000000,
};

/** Подставная обложка: градиент своего цвета на каждое имя — свет под обложкой виден на снимке. */
function cover(url) {
  const hue = [...url].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 80% 60%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360} 70% 30%)"/></linearGradient></defs><rect width="320" height="320" fill="url(#g)"/><circle cx="220" cy="110" r="70" fill="hsl(${(hue + 180) % 360} 90% 70% / 0.6)"/></svg>`;
}

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
  ignoreDefaultArgs: scrollbars ? ['--hide-scrollbars'] : [],
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
        // Экраны ищутся по русским подписям; без языка Chromium взял бы en-US, и Cord — английский.
        locale: 'ru-RU',
      });
      await context.addInitScript((value) => localStorage.setItem('cord:theme', value), theme);
      const page = await context.newPage();
      const shoot = async (name, element) => {
        const file = path.join(out, `${name}-${width}-${theme}.png`);
        // Элемент — целиком, даже если он выше окна; без элемента — окно, как его видит человек.
        if (element) await element.screenshot({ path: file });
        else await page.screenshot({ path: file });
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
