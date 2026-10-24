// Одна встреча на серию замеров (R107): «якорь» заводит её и сидит в ней без микрофона и камеры,
// а прогоны `voice-probe.spec.ts` входят по приглашению (PROBE_INVITE). Иначе серия упирается в
// предел «новых встреч за час» с одного адреса (10 в час) — и правильно, что упирается.
//
//   CORD_LISTENER_WS=ws://10.213.0.2:9555/listener node e2e/media/anchor.mjs /tmp/invite.txt
//   (из web/; без CORD_LISTENER_WS — свой браузер здесь же). Остановка — SIGTERM.
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const out = process.argv[2] ?? '/tmp/voice-invite.txt';
const base = process.env.PLAYWRIGHT_BASE_URL ?? 'https://cord.nikg.tech';
const browser = process.env.CORD_LISTENER_WS
  ? await chromium.connect(process.env.CORD_LISTENER_WS)
  : await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const context = await browser.newContext({
  baseURL: base,
  locale: 'ru-RU',
  viewport: { width: 1024, height: 700 },
  storageState: {
    cookies: [],
    origins: [
      {
        origin: new URL(base).origin,
        localStorage: [{ name: 'cord:onboarding:v1', value: '{"tour":true}' }],
      },
    ],
  },
});
const page = await context.newPage();
await page.goto('/');
await page.getByRole('button', { name: /Новая встреча/ }).click({ timeout: 60000 });
await page.getByLabel('Ваше имя').fill('Якорь');
await page.getByRole('button', { name: 'Начать встречу' }).click();
await page.locator('[data-media-status="connected"]').waitFor({ timeout: 90000 });
await page.getByRole('button', { name: 'Пригласить участников', exact: true }).click();
const invite = await page.getByRole('textbox', { name: 'Ссылка приглашения' }).inputValue();
await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
await page.addStyleTag({ content: 'body { content-visibility: hidden !important; }' });
writeFileSync(out, invite);
console.log('anchor in', invite);
const stop = async () => {
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
setInterval(() => {}, 60000);
