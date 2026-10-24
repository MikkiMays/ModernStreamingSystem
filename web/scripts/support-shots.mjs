// Снимки поддержки, диагностики и чата (W6: R37 R38 R51 R79 R94 R116) — одна встреча на весь прогон.
//
//   node scripts/support-shots.mjs --base https://cord.nikg.tech --out ../backlog/review-1.0.3/shots --phase before
//   node scripts/support-shots.mjs --dev 127.0.0.1:5463 --out ../backlog/review-1.0.3/shots --phase after
//   node scripts/support-shots.mjs --scenes settings,help --widths 1440 --themes dark
//
// Встреча одна (стенд пускает с адреса десять новых встреч в час): ширина и тема меняются у той же
// страницы (`setViewportSize`, `data-theme`). Обращения никуда не уходят — `/api/v1/support` и
// задача «не бот» подменены, как в `e2e/support.spec.ts`. Поиск музыки для R116 в «после» отвечает
// подменой тем, что отдаёт новая служба (`available: false` у ролика длиннее часа): выкатки нет, а
// снимок — про разметку выдачи. Код и ссылка встречи на снимках закрашены.
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]]);
    return pairs;
  }, []),
);
const base = args.base ?? 'https://cord.nikg.tech';
const out = path.resolve(args.out ?? 'shots');
const phase = args.phase ?? 'after';
const widths = (args.widths ?? '1440,390').split(',').map(Number);
const themes = (args.themes ?? 'light,dark').split(',');
const scenes = new Set((args.scenes ?? 'settings,header,help,report,chat,music').split(','));
const height = (width) => (width < 768 ? 844 : 900);
const report = [];
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
const context = await browser.newContext({
  viewport: { width: widths[0], height: height(widths[0]) },
  permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'],
  locale: 'ru-RU',
  ignoreHTTPSErrors: !!args.dev,
});
await context.addInitScript(() =>
  localStorage.setItem(
    'cord:onboarding:v1',
    JSON.stringify({ tour: true, meeting: true, integrations: true }),
  ),
);
const page = await context.newPage();
await page.route('**/api/v1/proof?for=support', (route) => route.fulfill({ status: 204 }));
await page.route('**/api/v1/support', (route) =>
  route.fulfill({ json: { id: '1a2b3c4d-0000-4000-8000-000000000000', number: '1A2B3C4D' } }),
);
if (phase === 'after')
  await page.route('**/music/search', (route) =>
    route.fulfill({
      json: [
        ['Lo-fi для работы', 'Studio', 3540, true],
        ['Дождь за окном — 10 часов', 'Sleep', 36000, false],
        ['Джаз в кафе · 3 часа', 'Cafe', 10805, false],
        ['Lo-fi beats · 24/7', 'Radio', 0, false],
        ['Спокойная музыка', 'Calm', 1520, true],
      ].map(([title, artist, duration, available], index) => ({
        url: `https://www.youtube.com/watch?v=AAAAAAAAAA${index}`,
        title,
        artist,
        duration,
        available,
        source: 'youtube',
      })),
    }),
  );

async function overflow() {
  return page.evaluate(() => {
    const doc = document.documentElement;
    return { overflowX: doc.scrollWidth - doc.clientWidth };
  });
}

/** Снять страницу на всех ширинах и в обеих темах; `prepare` — что открыть заново после смены ширины. */
async function shoot(name, prepare) {
  for (const width of widths) {
    if (page.viewportSize().width !== width) {
      await page.setViewportSize({ width, height: height(width) });
      await page.waitForTimeout(500);
    }
    if (prepare) await prepare();
    for (const theme of themes) {
      await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
      await page.waitForTimeout(600);
      const file = `${name}-${phase}-${width}-${theme}.png`;
      await page.screenshot({
        path: path.join(out, file),
        mask: [page.locator('.meeting-header__code'), page.locator('input[readonly]')],
        maskColor: '#000',
      });
      report.push({ screen: name, width, theme, file, ...(await overflow()) });
    }
  }
}

async function step(name, work) {
  if (!scenes.has(name)) return;
  try {
    await work();
  } catch (error) {
    report.push({ screen: name, error: String(error).split('\n')[0] });
    console.error(`${name}: ${String(error).split('\n')[0]}`);
    await page.keyboard.press('Escape').catch(() => {});
  }
}

const closeDialogs = async () => {
  for (let i = 0; i < 3 && (await page.getByRole('dialog').count()); i++) await page.keyboard.press('Escape');
};
const supportButton = () =>
  page
    .getByRole('button', { name: /^(Помощь|Поддержка)$/ })
    .filter({ visible: true })
    .first();
const more = () => page.getByRole('button', { name: 'Настройки и действия' }).click();

await page.goto(base);
await page.getByRole('button', { name: /Новая встреча/ }).waitFor({ timeout: 120000 });

// R51: «Поддержка» в настройках — раздел в группе «Cord» (после) против строки «О программе» (до).
await step('settings', async () => {
  const open = async () => {
    await closeDialogs();
    const menu = page.getByRole('button', { name: 'Открыть меню' });
    if (await menu.isVisible()) await menu.click();
    await page
      .getByRole('button', { name: 'Настройки', exact: true })
      .filter({ visible: true })
      .first()
      .click();
    const settings = page.getByRole('dialog', { name: 'Настройки' });
    await settings.waitFor();
    const nav = settings.getByRole('navigation', { name: 'Разделы настроек' });
    const support = nav.getByRole('button', { name: 'Поддержка', exact: true });
    await (
      (await support.count()) ? support : nav.getByRole('button', { name: 'О программе', exact: true })
    ).click();
    await page.waitForTimeout(800);
  };
  await shoot('r51-settings', open);
  await closeDialogs();
});

await page.goto(base);
await page.getByRole('button', { name: /Новая встреча/ }).click();
await page.getByLabel('Ваше имя').fill('Майя');
await page.getByRole('button', { name: 'Начать встречу' }).click();
await page.locator('[data-media-status="connected"]').waitFor({ timeout: 90000 });
await page.waitForTimeout(12000);

try {
  // R37: значок поддержки в шапке встречи рядом со звездой и ссылкой.
  await step('header', () => shoot('r37-header'));

  // R38: окно поддержки — вкладками (после) против одной длинной колонки (до).
  await step('help', async () => {
    const open = async (tab) => {
      await closeDialogs();
      await supportButton().click();
      const help = page.getByRole('dialog', { name: /^(Помощь|Поддержка)$/ });
      await help.waitFor();
      if (tab) await help.getByRole('tab', { name: tab }).click();
      await page.waitForTimeout(700);
    };
    await shoot('r38-help', () => open());
    if (phase === 'after') {
      await shoot('r38-help-check', () => open('Проверить'));
      await shoot('r38-help-write', () => open('Написать'));
    }
    await closeDialogs();
  });

  // R79: «Сообщить о проблеме» из диагностики — чипы ошибок и отчёт о звонке.
  await step('report', async () => {
    const diagnostics = async () => {
      await closeDialogs();
      await more();
      await page.getByRole('menuitem', { name: /^Диагностика/ }).click();
      await page.getByRole('dialog', { name: 'Диагностика' }).waitFor();
      await page.waitForTimeout(2500);
    };
    await shoot('r79-diagnostics', diagnostics);
    if (phase === 'after')
      await shoot('r79-report', async () => {
        await diagnostics();
        await page.getByRole('button', { name: 'Сообщить о проблеме' }).click();
        const help = page.getByRole('dialog', { name: 'Поддержка' });
        await help.waitFor();
        await help.getByRole('checkbox', { name: 'Звук обрывается' }).click();
        await help.getByRole('checkbox', { name: 'Не слышно музыку' }).click();
        await page.waitForTimeout(500);
      });
    await closeDialogs();
  });

  // R94: Ctrl+V скриншота в чате — превью над полем ввода.
  await step('chat', async () => {
    const paste = async () => {
      await closeDialogs();
      if (!(await page.locator('.chat-panel').count()))
        await page.getByRole('button', { name: 'Чат', exact: true }).click();
      const field = page.getByRole('textbox', { name: 'Сообщение', exact: true });
      await field.waitFor();
      await page
        .locator('.composer-attachments__remove')
        .evaluateAll((buttons) => buttons.forEach((b) => b.click()));
      await field.fill('Вот что у меня на экране');
      await field.evaluate(async (element) => {
        const canvas = Object.assign(document.createElement('canvas'), { width: 640, height: 400 });
        const paint = canvas.getContext('2d');
        paint.fillStyle = '#1d4ed8';
        paint.fillRect(0, 0, 640, 400);
        paint.fillStyle = '#fff';
        paint.font = 'bold 56px sans-serif';
        paint.fillText('Скриншот', 150, 220);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
        const data = new DataTransfer();
        data.items.add(new File([blob], 'image.png', { type: 'image/png' }));
        element.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
        );
      });
      await page.waitForTimeout(800);
    };
    await shoot('r94-chat', paste);
  });

  // R116: поиск музыки — ролик длиннее часа помечен «Не добавить» в выдаче.
  await step('music', async () => {
    const search = async () => {
      await closeDialogs();
      if (!(await page.locator('.services-panel').count())) {
        const direct = page.getByRole('button', { name: 'Интеграции', exact: true });
        if (await direct.isVisible()) await direct.click();
        else {
          await more();
          await page.getByRole('menuitem', { name: /Интеграции/ }).click();
        }
        await page.locator('.services-panel').waitFor();
      }
      const field = page.getByRole('searchbox');
      if (!(await field.count())) {
        await page
          .locator('.service-group')
          .filter({ has: page.locator('b', { hasText: /^Музыка$/ }) })
          .click();
        const add = page.getByRole('button', { name: 'Добавить во встречу' });
        if (await add.count()) await add.click();
      }
      await page.getByRole('searchbox').fill('lofi 10 hours');
      await page.getByRole('searchbox').press('Enter');
      await page.locator('.music-results__row').first().waitFor({ timeout: 60000 });
      await page.waitForTimeout(800);
    };
    await shoot('r116-music', search);
  });
} finally {
  await closeDialogs();
  await page
    .getByRole('button', { name: 'Выйти из встречи' })
    .click()
    .catch(() => {});
  writeFileSync(path.join(out, `w6-${phase}-report.json`), JSON.stringify(report, null, 2) + '\n');
  await browser.close();
}
console.log(JSON.stringify(report.filter((entry) => entry.error || entry.overflowX > 0)));
