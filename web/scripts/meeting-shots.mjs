// Снимки встречи с людьми (W3: R27 R30 R77 R83 R84 R87) — в одной комнате на весь прогон.
//
//   node scripts/meeting-shots.mjs --base https://cord.nikg.tech --out ../backlog/screens/R103/W3/before
//   node scripts/meeting-shots.mjs --dev 127.0.0.1:5443 --out ../backlog/screens/R103/W3/after
//   node scripts/meeting-shots.mjs --scenes pinned,chat --widths 390,1440 --themes dark
//
// Почему не `shots.mjs`. Там каждый снимок — новая встреча, а стенд пускает с одного адреса десять
// новых встреч в час (антибот, `ABUSE_IP_ROOMS_CREATED`). Здесь встреч две: ведущий на мониторе и
// отдельная — для одиночного снимка телефона; остальные люди входят по ссылке, а ширина и тема
// меняются у той же страницы (`setViewportSize`, `data-theme`). `--dev` — невыкаченный веб из этого
// каталога под именем стенда (`scripts/stand-dev.mjs`).
//
// Сцены: one — один во встрече (как его видит вошедший первым); three — трое, у Ани камера; pinned —
// закреплена Аня (+ меню её плитки); speaker — раскладка «Говорящий»; share — свой показ экрана;
// chat — три чужих сообщения при закрытом чате. Рядом — report.json с переполнением по ширине.
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
const widths = (args.widths ?? '390,768,1440').split(',').map(Number);
const themes = (args.themes ?? 'light,dark').split(',');
const scenes = (args.scenes ?? 'one,three,pinned,speaker,share,chat').split(',');
const height = (width) => (width < 768 ? 844 : width < 1280 ? 900 : 1000);
const phoneWidths = widths.filter((width) => width < 768);
const deskWidths = widths.filter((width) => width >= 768);

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
mkdirSync(out, { recursive: true });

/** Свой браузерный профиль: телефон — с касанием, компьютер — без; знакомство — по желанию. */
async function context(width, { returning = true, screen = false } = {}) {
  const phone = width < 768;
  const ctx = await browser.newContext({
    viewport: { width, height: height(width) },
    deviceScaleFactor: phone ? 2 : 1,
    isMobile: phone,
    hasTouch: phone,
    permissions: ['camera', 'microphone'],
    locale: 'ru-RU',
    ignoreHTTPSErrors: !!args.dev,
  });
  if (returning)
    await ctx.addInitScript(() =>
      localStorage.setItem(
        'cord:onboarding:v1',
        JSON.stringify({ tour: true, meeting: true, integrations: true }),
      ),
    );
  if (screen)
    await ctx.addInitScript(() => {
      if (!navigator.mediaDevices) return;
      navigator.mediaDevices.getDisplayMedia = async () => {
        const canvas = Object.assign(document.createElement('canvas'), { width: 1280, height: 720 });
        const paint = canvas.getContext('2d');
        let frame = 0;
        setInterval(() => {
          paint.fillStyle = '#153f73';
          paint.fillRect(0, 0, 1280, 720);
          paint.fillStyle = '#fff';
          paint.font = '48px sans-serif';
          paint.fillText(`SCREEN · ${frame++}`, 64, 120);
          paint.fillRect((frame * 12) % 1180, 300, 100, 100);
        }, 1000 / 30);
        return canvas.captureStream(30);
      };
    });
  return ctx;
}

async function connected(page) {
  await page.locator('[data-media-status="connected"]').waitFor({ timeout: 45000 });
}

async function create(page, name) {
  await page.goto(base);
  await page.getByRole('button', { name: /Новая встреча/ }).click({ timeout: 30000 });
  await page.getByLabel('Ваше имя').fill(name);
  await page.getByRole('button', { name: 'Начать встречу' }).click();
  await connected(page);
}

async function join(page, invite, name) {
  await page.goto(invite);
  await page.getByLabel('Ваше имя').fill(name);
  await page.getByRole('button', { name: 'Войти во встречу' }).click();
  await connected(page);
}

/** Прямая кнопка пульта или пункт «ещё»: на телефоне правая группа и показ — в меню (E04). */
async function dock(page, button, item = button) {
  const direct = page.getByRole('button', { name: button, exact: true });
  if (await direct.isVisible()) return direct.click();
  await page.getByRole('button', { name: 'Настройки и действия' }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

async function overflow(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const offenders = [];
    for (const element of document.querySelectorAll('body *')) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.right <= doc.clientWidth + 1) continue;
      if (getComputedStyle(element).position === 'fixed' && box.left >= doc.clientWidth) continue;
      offenders.push(`${element.tagName.toLowerCase()}.${String(element.className).split(' ')[0]}`);
      if (offenders.length >= 8) break;
    }
    return { overflowX: doc.scrollWidth - doc.clientWidth, offenders };
  });
}

/** Снять страницу на её ширинах и в обеих темах: тема — тем же атрибутом, что ставит приложение. */
async function shoot(page, name, sizes, after) {
  for (const width of sizes) {
    if (page.viewportSize().width !== width) await page.setViewportSize({ width, height: height(width) });
    for (const theme of themes) {
      await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
      await page.waitForTimeout(700);
      if (after) await after(page);
      const file = `${name}-${width}-${theme}.png`;
      await page.screenshot({ path: path.join(out, file) });
      report.push({ screen: name, width, theme, file, ...(await overflow(page)) });
      if (after) await page.keyboard.press('Escape');
    }
  }
}

const tile = (page, name) => page.locator('.person-tile').filter({ hasText: name }).first();

const SCENES = {
  three: async () => {},
  pinned: async (page) => {
    await tile(page, 'Аня').getByRole('button', { name: 'Действия: Аня' }).click();
    await page.getByRole('menuitem', { name: /Закрепить/ }).click();
  },
  speaker: async (page) => {
    const direct = page.getByRole('button', { name: 'Расположение участников' });
    if (await direct.isVisible()) await direct.click();
    else await page.getByRole('button', { name: 'Настройки и действия' }).click();
    await page.getByRole('menuitem', { name: /Говорящий/ }).click();
  },
  share: async (page) => {
    await dock(page, 'Показать экран');
    await page.locator('.person-tile[data-sharing="true"]').waitFor({ timeout: 25000 });
    await page.waitForTimeout(1200);
  },
  chat: async (page, people) => {
    const { anchor } = people;
    // Чат ведущего мог закрыться (подсказка знакомства съедает первое нажатие) — открыть заново.
    const field = anchor.getByRole('textbox', { name: 'Сообщение', exact: true });
    if (!(await field.isVisible())) await anchor.getByRole('button', { name: 'Чат', exact: true }).click();
    for (const text of ['Привет!', 'Слышно меня?', 'Сейчас покажу экран']) {
      await anchor.getByRole('textbox', { name: 'Сообщение', exact: true }).fill(text);
      await anchor.getByRole('button', { name: 'Отправить сообщение' }).click();
    }
    await page.waitForTimeout(1500);
  },
};

try {
  // Ведущий — первым во встрече, без «знакомства пройдено»: так его видит каждый новый человек.
  const anchorContext = await context(deskWidths.at(-1) ?? 1440, { returning: false });
  const anchor = await anchorContext.newPage();
  await create(anchor, 'Ведущий');
  await anchor.waitForTimeout(1500);
  if (scenes.includes('one')) {
    await shoot(anchor, 'meeting-one', [...deskWidths].reverse());
    if (phoneWidths.length) {
      const phone = await context(phoneWidths[0], { returning: false });
      const page = await phone.newPage();
      await create(page, 'Снимок');
      await page.waitForTimeout(4000);
      await shoot(page, 'meeting-one', phoneWidths);
      await phone.close();
    }
  }
  await anchor.setViewportSize({ width: 1440, height: 1000 });
  await anchor.getByRole('button', { name: 'Пригласить участников' }).click();
  const invite = await anchor.getByLabel('Ссылка приглашения').inputValue();
  await anchor.getByRole('button', { name: 'Закрыть', exact: true }).click();
  // Чат ведущего открыт: из него и пишутся сообщения сцены `chat`.
  await anchor.getByRole('button', { name: 'Чат', exact: true }).click();
  const annContext = await context(1280);
  const ann = await annContext.newPage();
  await join(ann, invite, 'Аня');
  await ann.getByRole('button', { name: 'Включить камеру', exact: true }).click();

  for (const scene of scenes.filter((name) => name in SCENES)) {
    for (const sizes of [phoneWidths, [...deskWidths].reverse()]) {
      if (!sizes.length) continue;
      const shooterContext = await context(sizes[0], { screen: scene === 'share' });
      const page = await shooterContext.newPage();
      try {
        await join(page, invite, 'Снимок');
        await page.locator('.person-tile').nth(2).waitFor({ timeout: 20000 });
        await page.waitForTimeout(1500);
        await SCENES[scene](page, { anchor, ann });
        await page.waitForTimeout(900);
        await shoot(page, `meeting-${scene}`, sizes);
        if (scene === 'pinned')
          await shoot(page, 'meeting-pinned-menu', sizes, async (shooter) => {
            await tile(shooter, 'Аня').getByRole('button', { name: 'Действия: Аня' }).click();
            await shooter.getByRole('menu').waitFor();
            await shooter.waitForTimeout(300);
          });
        if (scene === 'share') await dock(page, 'Остановить показ').catch(() => {});
      } catch (error) {
        report.push({ screen: `meeting-${scene}`, width: sizes[0], error: String(error).split('\n')[0] });
        // Чем кончилось — снимок обоих: ошибку сцены иначе не понять.
        await page.screenshot({ path: path.join(out, `error-${scene}-${sizes[0]}.png`) }).catch(() => {});
        await anchor
          .screenshot({ path: path.join(out, `error-${scene}-${sizes[0]}-anchor.png`) })
          .catch(() => {});
      }
      // Уйти по-настоящему: закрытая вкладка висела бы во встрече «восстанавливается» ещё 20 с и
      // попала бы в следующую сцену лишним человеком.
      await page
        .getByRole('button', { name: 'Выйти из встречи', exact: true })
        .click({ timeout: 5000 })
        .catch(() => {});
      await page.waitForTimeout(1000);
      await shooterContext.close();
    }
  }
  await annContext.close();
  await anchorContext.close();
} finally {
  await browser.close();
  writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  const bad = report.filter((row) => row.error || row.overflowX > 0);
  for (const row of bad)
    console.log(
      row.error
        ? `ОШИБКА ${row.screen} ${row.width}: ${row.error}`
        : `ПЕРЕПОЛНЕНИЕ ${row.screen} ${row.width} ${row.theme}: +${row.overflowX}px ${row.offenders.join(', ')}`,
    );
  console.log(`${report.length} снимков в ${out}; с переполнением или ошибкой: ${bad.length}`);
}
