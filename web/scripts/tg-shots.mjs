// Кадры Mini App Telegram (E09) на телефонной ширине — без Telegram и без сервера.
//
//   npm run build && npx vite preview --port 4317 &
//   node scripts/tg-shots.mjs [http://127.0.0.1:4317] [каталог]
//
// Telegram подменяется так, как его видит SDK: параметры запуска — в хэше адреса (`tgWebAppData`, тема,
// платформа), мост — `window.TelegramWebviewProxy.postEvent`, ответы клиента — `Telegram.WebView.receiveEvent`
// (безопасные зоны iPhone и кнопки Telegram в полноэкранном режиме). Ответы службы и сервера — подменой
// маршрутов. Кадры: «откройте из Telegram», «нет микрофона» в ночной и дневной теме Telegram, «не состоите в
// чате». Сама встреча здесь не снимается: ей нужен SFU — она та же, что в браузере.
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const base = process.argv[2] ?? 'http://127.0.0.1:4317';
const out = process.argv[3] ?? '../backlog/screens/E09/after';
mkdirSync(out, { recursive: true });

const NIGHT = {
  bg_color: '#212d3b',
  secondary_bg_color: '#151e27',
  section_bg_color: '#1d2733',
  text_color: '#ffffff',
  hint_color: '#7d8b99',
  link_color: '#5eabe1',
  accent_text_color: '#64b5ef',
  button_color: '#2481cc',
  button_text_color: '#ffffff',
  destructive_text_color: '#ee686f',
};
const DAY = {
  bg_color: '#ffffff',
  secondary_bg_color: '#f0f0f0',
  text_color: '#000000',
  hint_color: '#707579',
  link_color: '#3390ec',
  button_color: '#3390ec',
  button_text_color: '#ffffff',
};
const DATA =
  'auth_date=1760000000&hash=0000&signature=abc&user=%7B%22id%22%3A5%2C%22first_name%22%3A%22Ivan%22%7D' +
  '&start_param=bLink&chat_type=supergroup&chat_instance=-42';
const hash = (theme) =>
  '#' +
  new URLSearchParams({
    tgWebAppData: DATA,
    tgWebAppVersion: '9.1',
    tgWebAppPlatform: 'ios',
    tgWebAppStartParam: 'bLink',
    tgWebAppThemeParams: JSON.stringify(theme),
  }).toString();

const bridge = () => {
  const events = (window.__tgEvents = []);
  const reply = (name, data) => setTimeout(() => window.Telegram?.WebView?.receiveEvent?.(name, data), 10);
  window.TelegramWebviewProxy = {
    postEvent(name, raw) {
      events.push(name);
      if (name === 'web_app_request_viewport')
        reply('viewport_changed', { height: 844, width: 390, is_expanded: true, is_state_stable: true });
      if (name === 'web_app_request_safe_area')
        reply('safe_area_changed', { top: 47, bottom: 34, left: 0, right: 0 });
      if (name === 'web_app_request_content_safe_area')
        reply('content_safe_area_changed', { top: 46, bottom: 0, left: 0, right: 0 });
      if (name === 'web_app_request_fullscreen') reply('fullscreen_changed', { is_fullscreen: true });
      void raw;
    },
  };
};

async function shot(browser, name, { theme, enter }) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  if (theme) await page.addInitScript(bridge);
  await page.route('**/api/v1/session', (route) =>
    route.fulfill({
      json: { token: 't', expiresAt: Date.now() / 1000 + 3600, name: 'Cord', passwordRequired: false },
    }),
  );
  await page.route('**/api/v1/capabilities', (route) => route.fulfill({ json: {} }));
  if (enter) await page.route('**/api/v1/services/telegram/webapp/enter', enter);
  await page.goto(`${base}/tg.html${theme ? hash(theme) : ''}`);
  await page.locator('#cord-boot').waitFor({ state: 'detached', timeout: 15000 });
  await page.locator('h1').waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/${name}.png` });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  const events = await page.evaluate(() => window.__tgEvents ?? []);
  const inset = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--tg-inset-top'),
  );
  console.log(
    `${name}: переполнение ${overflow}px, отступ сверху ${inset || '—'}, Telegram: ${[...new Set(events)].join(' ')}`,
  );
  await context.close();
}

const entry = (route) =>
  route.fulfill({
    json: {
      roomId: '11111111-2222-3333-4444-555555555555',
      title: 'Планёрка',
      name: 'Ivan',
      inviteUrl: 'https://cord.test/join/11111111-2222-3333-4444-555555555555#invite=' + 'a'.repeat(43),
    },
  });
const notMember = (route) =>
  route.fulfill({
    status: 403,
    json: { code: 'TELEGRAM_NOT_MEMBER', detail: 'Вы не состоите в чате, к которому привязана встреча' },
  });

const browser = await chromium.launch();
await shot(browser, 'tg-outside-390', {});
await shot(browser, 'tg-microphone-night-390', { theme: NIGHT, enter: entry });
await shot(browser, 'tg-microphone-day-390', { theme: DAY, enter: entry });
await shot(browser, 'tg-not-member-night-390', { theme: NIGHT, enter: notMember });
await browser.close();
