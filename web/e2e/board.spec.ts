import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

/*
  Доска встречи (R159, R154) двумя браузерами через настоящую встречу на стенде:
  штрих одного — у другого за доли секунды (p95 задержки по меткам самой доски), одновременные правки
  сходятся, смотрящий не рисует, «Сохранить в чат» — картинка и файл доски одним сообщением, импорт
  заменяет доску, «Открыть на доске» из чата добавляет на неё, 390 и 1440 без горизонтальной прокрутки,
  и ни одного нарушения CSP и ни одного адреса наружу (шрифты Excalidraw — свои).

  Одна встреча на весь файл (сценарии по порядку): у адреса стенда 10 новых встреч в час
  (`cord-e2e-create-budget`).

    cd web && PLAYWRIGHT_BASE_URL=https://cord.nikg.tech npx playwright test e2e/board.spec.ts

  `CORD_BOARD_LOCAL=1` — против dev-сервера с ядром этой ветки без SFU и загрузок: медиа не ждать,
  сценарий с вложениями чата пропустить.
*/

const LOCAL = process.env.CORD_BOARD_LOCAL === '1';
/**
 * Предел p95 задержки штриха, мс. Цель — 100 у людей, e2e на стенде держит 150 (проект доски, 9.9). Локально
 * оба пути идут через прокси dev-сервера Node и dev-сборки React и Excalidraw — там предел шире.
 */
const P95 = Number(process.env.CORD_BOARD_P95 ?? (LOCAL ? 1000 : 150));

test.describe.configure({ mode: 'serial' });

let first: BrowserContext;
let second: BrowserContext;
let anna: Page;
let boris: Page;
/** Запросы туда, куда доска ходить не должна: CDN шрифтов Excalidraw, его сайты, GitHub. */
const outside: string[] = [];

async function context(browser: Browser) {
  const created = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: { width: 1440, height: 900 },
  });
  // Нарушения CSP — с первой строки страницы: шрифт с чужого адреса заметен только здесь.
  await created.addInitScript(() => {
    const scope = window as unknown as { __csp: string[] };
    scope.__csp = [];
    document.addEventListener('securitypolicyviolation', (event) =>
      scope.__csp.push(`${event.violatedDirective} ${event.blockedURI}`),
    );
  });
  created.on('request', (request) => {
    if (/esm\.sh|excalidraw\.com|github\.com|unpkg\.com|jsdelivr/.test(request.url()))
      outside.push(request.url());
  });
  return created;
}

async function inMeeting(page: Page) {
  if (LOCAL) await expect(page.locator('.meeting-page')).toBeVisible({ timeout: 30000 });
  else await expect(page.locator('[data-media-status="connected"]')).toBeVisible({ timeout: 30000 });
}

async function startMeeting(page: Page, name: string) {
  await page.goto('/');
  await page.getByRole('button', { name: /Новая встреча/ }).click();
  await page.getByLabel('Ваше имя').fill(name);
  await page.getByRole('button', { name: 'Начать встречу' }).click();
  await inMeeting(page);
}

async function inviteLink(page: Page) {
  await page.getByRole('button', { name: 'Пригласить участников', exact: true }).click();
  const link = await page.getByRole('textbox', { name: 'Ссылка приглашения' }).inputValue();
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  return link;
}

async function joinMeeting(page: Page, invitation: string, name: string) {
  await page.goto(invitation);
  await page.getByLabel('Ваше имя').fill(name);
  await page.getByRole('button', { name: 'Войти во встречу' }).click();
  await inMeeting(page);
}

/** Интеграции → «Доска рисования»; панель закрывается, чтобы доска заняла сцену. */
async function openBoard(page: Page) {
  const toggle = page.getByRole('button', { name: 'Интеграции', exact: true });
  await toggle.click();
  await page
    .locator('.service-group')
    .filter({ has: page.locator('b', { hasText: /^Доска рисования$/ }) })
    .click();
  await expect(page.locator('.board')).toBeVisible({ timeout: 30000 });
  if (await page.locator('.services-panel').isVisible()) await toggle.click();
}

const board = (page: Page) => page.locator('section.board');
const canvas = (page: Page) => page.locator('section.board .excalidraw__canvas.interactive');
const count = async (page: Page) => Number((await board(page).getAttribute('data-elements')) ?? '0');

/** Выбрать инструмент Excalidraw по его метке. */
async function tool(page: Page, name: 'rectangle' | 'freedraw' | 'selection') {
  await page.locator(`label:has([data-testid="toolbar-${name}"])`).first().click();
}

/** Провести мышью внутри холста: доли его ширины и высоты. */
async function drag(page: Page, from: [number, number], to: [number, number], steps = 12) {
  const box = (await canvas(page).boundingBox())!;
  const at = ([x, y]: [number, number]) => [box.x + box.width * x, box.y + box.height * y] as const;
  const [x0, y0] = at(from);
  const [x1, y1] = at(to);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++)
    await page.mouse.move(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps);
  await page.mouse.up();
}

async function converged(...pages: Page[]) {
  await expect
    .poll(
      async () =>
        new Set(await Promise.all(pages.map((page) => board(page).getAttribute('data-scene')))).size,
      {
        timeout: 15000,
      },
    )
    .toBe(1);
}

/** Меню «Ещё» в шапке доски. */
async function more(page: Page, item: string | RegExp) {
  await board(page).getByRole('button', { name: 'Ещё', exact: true }).click();
  await page
    .getByRole('menuitem', { name: item })
    .or(page.getByRole('menuitemradio', { name: item }))
    .click();
}

/** Файл доски с тремя прямоугольниками — то, что сохраняет «Скачать» → «Файлом доски». */
function boardFile(): { name: string; mimeType: string; buffer: Buffer } {
  const rect = (id: string, x: number) => ({
    id,
    type: 'rectangle',
    x,
    y: 100,
    width: 120,
    height: 80,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: null,
    roundness: null,
    seed: 1,
    version: 2,
    versionNonce: 5,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
  });
  const doc = {
    type: 'excalidraw',
    version: 2,
    source: 'cord',
    elements: [rect('e2e-a', 0), rect('e2e-b', 200), rect('e2e-c', 400)],
    appState: { viewBackgroundColor: '#ffffff', gridSize: null },
    files: {},
  };
  return {
    name: 'Доска e2e.cord-board',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(doc)),
  };
}

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  first = await context(browser);
  second = await context(browser);
  anna = await first.newPage();
  boris = await second.newPage();
  await startMeeting(anna, 'Анна');
  await joinMeeting(boris, await inviteLink(anna), 'Борис');
  await openBoard(anna);
  for (const page of [anna, boris])
    await expect(board(page)).toHaveAttribute('data-state', 'live', { timeout: 30000 });
});

test.afterAll(async () => {
  await first?.close();
  await second?.close();
});

test(`штрих Анны — у Бориса; p95 задержки по 20 штрихам меньше ${P95} мс`, async () => {
  test.setTimeout(300_000);
  await tool(anna, 'freedraw');
  await drag(anna, [0.3, 0.4], [0.5, 0.55]);
  await expect.poll(() => count(boris), { timeout: 10000 }).toBe(1);
  await converged(anna, boris);
  for (let i = 0; i < 20; i++) await drag(anna, [0.2 + i * 0.02, 0.6], [0.25 + i * 0.02, 0.7], 3);
  await expect.poll(() => count(boris), { timeout: 15000 }).toBe(21);
  await converged(anna, boris);
  // Задержку меряет сама доска: метка времени в правке автора против часов приёмника (оба — по серверу).
  await expect
    .poll(async () => Number((await board(boris).getAttribute('data-latency')) ?? 'NaN'), { timeout: 5000 })
    .not.toBeNaN();
  const p95 = Number(await board(boris).getAttribute('data-latency'));
  console.log(`[board] p95 задержки у Бориса: ${p95} мс`);
  expect(p95).toBeLessThan(P95);
});

test('одновременные правки двоих сходятся', async () => {
  const before = await count(anna);
  await tool(anna, 'rectangle');
  await tool(boris, 'rectangle');
  await Promise.all([drag(anna, [0.6, 0.2], [0.7, 0.3]), drag(boris, [0.62, 0.25], [0.75, 0.35])]);
  await expect.poll(() => count(anna), { timeout: 10000 }).toBe(before + 2);
  await expect.poll(() => count(boris), { timeout: 10000 }).toBe(before + 2);
  await converged(anna, boris);
});

test('«Рисует ведущий»: Борис смотрит — подпись, без инструментов, его штрих не уходит', async () => {
  await more(anna, 'Только ведущий');
  await expect(board(boris).getByText('Смотрите: рисует ведущий')).toBeVisible({ timeout: 10000 });
  await expect(boris.locator('[data-testid="toolbar-rectangle"]')).toHaveCount(0);
  const before = await count(anna);
  await drag(boris, [0.4, 0.4], [0.6, 0.6]);
  await anna.waitForTimeout(1000);
  expect(await count(anna)).toBe(before);
  await more(anna, 'Все участники');
  await expect(board(boris).getByText('Смотрите: рисует ведущий')).toHaveCount(0, { timeout: 10000 });
  await expect(boris.locator('[data-testid="toolbar-rectangle"]')).toHaveCount(1);
});

test('импорт файла заменяет доску у всех', async () => {
  const chooser = anna.waitForEvent('filechooser');
  await more(anna, 'Открыть файл');
  await (await chooser).setFiles(boardFile());
  const dialog = anna.getByRole('dialog', { name: 'Открыть файл на доске' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Заменить доску' }).click();
  await expect.poll(() => count(anna), { timeout: 15000 }).toBe(3);
  await expect.poll(() => count(boris), { timeout: 15000 }).toBe(3);
  await converged(anna, boris);
});

test('«Сохранить в чат» — картинка и файл доски одним сообщением; «Открыть на доске» добавляет', async () => {
  test.skip(LOCAL, 'без tusd вложений нет');
  test.setTimeout(120_000);
  await board(anna).getByRole('button', { name: 'Сохранить в чат' }).click();
  await boris.getByRole('button', { name: /^Чат(,|$)/ }).click();
  const files = boris.locator('.attachment-message');
  await expect(files.filter({ hasText: /\.png\b/ })).toHaveCount(1, { timeout: 60000 });
  await expect(files.filter({ hasText: /\.cord-board/ })).toHaveCount(1, { timeout: 60000 });
  await expect(
    boris
      .locator('.message')
      .filter({ hasText: /Доска · \d\d:\d\d/ })
      .last(),
  ).toBeVisible();
  // У файла доски в чате — «Открыть на доске»: Борис добавляет ту же доску рядом.
  await files
    .filter({ hasText: /\.cord-board/ })
    .getByRole('button', { name: /^Открыть на доске/ })
    .click();
  const dialog = boris.getByRole('dialog', { name: 'Открыть файл на доске' });
  await expect(dialog).toBeVisible({ timeout: 15000 });
  await dialog.getByRole('button', { name: 'Добавить на доску' }).click();
  await expect.poll(() => count(anna), { timeout: 15000 }).toBe(6);
  await converged(anna, boris);
  await boris.getByRole('button', { name: /^Чат(,|$)/ }).click();
});

test('1440 и 390 — без горизонтальной прокрутки; на телефоне пульт уходит, «Все участники» на месте', async () => {
  await anna.setViewportSize({ width: 1440, height: 900 });
  await expect(board(anna)).toBeVisible();
  expect(await overflow(anna)).toBeLessThanOrEqual(0);
  await anna.setViewportSize({ width: 390, height: 844 });
  await expect(board(anna)).toBeVisible();
  await anna.waitForTimeout(500);
  expect(await overflow(anna)).toBeLessThanOrEqual(0);
  await expect(anna.locator('.call-footer')).toBeHidden();
  await expect(board(anna).getByRole('button', { name: 'Все участники' })).toBeVisible();
  // К участникам — пульт снова здесь, а доска — чёлкой сверху.
  await board(anna).getByRole('button', { name: 'Все участники' }).click();
  await expect(anna.locator('.call-footer')).toBeVisible();
  await expect(anna.locator('[data-stage-notch]')).toBeVisible();
  await anna.locator('[data-stage-notch]').click();
  await expect(board(anna)).toBeVisible();
  await anna.setViewportSize({ width: 1440, height: 900 });
});

test('ни одного нарушения CSP и ни одного запроса наружу; закрыть доску — с вопросом о чате', async () => {
  for (const page of [anna, boris]) {
    const csp = await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
    expect(csp, 'нарушения CSP').toEqual([]);
  }
  expect(outside, 'запросы наружу').toEqual([]);
  await board(anna).getByRole('button', { name: 'Закрыть доску' }).click();
  const ask = anna.getByRole('dialog', { name: 'Сохранить доску в чат?' });
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Закрыть без сохранения' }).click();
  for (const page of [anna, boris]) await expect(board(page)).toHaveCount(0, { timeout: 15000 });
});
