// Зонд: смена частоты/разрешения камеры в настройках во время встречи — гаснет ли камера.
//   node scripts/camera-switch-probe.mjs --base https://meet.nikg.tech [--phone 1] [--dist dir]
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]]);
    return pairs;
  }, []),
);
const base = args.base ?? 'https://meet.nikg.tech';
const phone = !!args.phone;
const out = args.out ?? '/tmp';
const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const ctx = await browser.newContext({
  viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
  deviceScaleFactor: phone ? 3 : 1,
  isMobile: phone,
  hasTouch: phone,
  permissions: ['camera', 'microphone'],
  locale: 'ru-RU',
  serviceWorkers: 'block',
});
if (args.dist)
  await ctx.route(`${base}/**`, (route) => {
    const request = route.request();
    const file = path.join(args.dist, new URL(request.url()).pathname);
    if (existsSync(file) && statSync(file).isFile()) return route.fulfill({ path: file });
    if (request.resourceType() === 'document')
      return route.fulfill({
        contentType: 'text/html',
        body: readFileSync(path.join(args.dist, 'index.html')),
      });
    return route.continue();
  });
await ctx.addInitScript(() => {
  localStorage.setItem(
    'cord:onboarding:v1',
    JSON.stringify({ tour: true, meeting: true, integrations: true }),
  );
  window.__pcs = [];
  const Native = window.RTCPeerConnection;
  window.RTCPeerConnection = function (...a) {
    const pc = new Native(...a);
    window.__pcs.push(pc);
    return pc;
  };
  window.RTCPeerConnection.prototype = Native.prototype;
  // Сколько захватов камеры живо одновременно и сколько раз её захватывали.
  window.__gum = 0;
  const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (c) => {
    const stream = await gum(c);
    if (c?.video) window.__gum++;
    return stream;
  };
});
const page = await ctx.newPage();
page.on('console', (m) => m.type() === 'error' && console.log('console:', m.text().slice(0, 200)));
await page.goto(base);
await page.getByRole('button', { name: /Новая встреча/ }).click({ timeout: 30000 });
await page.getByLabel('Ваше имя').fill('Камера');
await page.getByRole('button', { name: 'Начать встречу' }).click();
await page.locator('[data-media-status="connected"]').waitFor({ timeout: 45000 });
// Зритель: не гаснет ли у него поток при смене качества (тот же inbound-rtp, кадры растут).
const viewerContext = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  locale: 'ru-RU',
  serviceWorkers: 'block',
});
await viewerContext.addInitScript(() => {
  localStorage.setItem(
    'cord:onboarding:v1',
    JSON.stringify({ tour: true, meeting: true, integrations: true }),
  );
  window.__pcs = [];
  const Native = window.RTCPeerConnection;
  window.RTCPeerConnection = function (...a) {
    const pc = new Native(...a);
    window.__pcs.push(pc);
    return pc;
  };
  window.RTCPeerConnection.prototype = Native.prototype;
});
await page.getByRole('button', { name: 'Пригласить участников' }).click();
const invite = await page.getByLabel('Ссылка приглашения').inputValue();
await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
const viewer = await viewerContext.newPage();
await viewer.goto(invite);
await viewer.getByLabel('Ваше имя').fill('Зритель');
await viewer.getByRole('button', { name: 'Войти во встречу' }).click();
await viewer.locator('[data-media-status="connected"]').waitFor({ timeout: 45000 });
const received = () =>
  viewer.evaluate(async () => {
    const rows = [];
    for (const pc of window.__pcs)
      (await pc.getStats()).forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'video')
          rows.push(
            `${r.id.slice(-6)} ${r.frameWidth}x${r.frameHeight}@${r.framesPerSecond} decoded=${r.framesDecoded}`,
          );
      });
    return rows;
  });

const on = page.getByRole('button', { name: 'Включить камеру', exact: true });
if (await on.isVisible().catch(() => false)) await on.click();
await page.waitForTimeout(3000);

const sample = (label) =>
  page.evaluate(async (label) => {
    const senders = [];
    for (const pc of window.__pcs)
      for (const s of pc.getSenders())
        if (s.track?.kind === 'video' || s.track === null) {
          const stats = [];
          (await s.getStats()).forEach((r) => {
            if (r.type === 'outbound-rtp')
              stats.push(`${r.frameWidth}x${r.frameHeight}@${r.framesPerSecond}`);
          });
          senders.push({
            track: s.track ? `${s.track.readyState}${s.track.muted ? ' muted' : ''}` : null,
            settings: s.track
              ? `${s.track.getSettings().width}x${s.track.getSettings().height}@${s.track.getSettings().frameRate}`
              : null,
            stats,
          });
        }
    const off = !!document.querySelector('[aria-label="Включить камеру"]');
    return { label, cameraButtonSaysOff: off, gum: window.__gum, senders };
  }, label);
console.log(JSON.stringify(await sample('камера включена')));

// Настройки → Видео.
const menu = page.getByRole('button', { name: 'Настройки и действия' });
if (await menu.isVisible().catch(() => false)) await menu.click();
const items = await page.getByRole('menuitem').allTextContents();
console.log('menu:', items);
await page
  .getByRole('menuitem', { name: /^Настройки/ })
  .first()
  .click();
await page.waitForTimeout(800);
const video = page
  .getByRole('tab', { name: 'Видео' })
  .or(page.getByRole('button', { name: 'Видео', exact: true }))
  .first();
await video.click().catch((e) => console.log('no video tab', e.message.slice(0, 80)));
await page.waitForTimeout(2000);
await page.screenshot({ path: `${out}/settings-video.png` });
console.log(JSON.stringify(await sample('открыт раздел «Видео»')));

for (const [name, label] of [
  ['60 fps', 'выбрано 60'],
  ['30 fps', 'выбрано 30'],
  ['1080p', 'выбрано 1080p'],
]) {
  const t0 = Date.now();
  await page.getByRole('radio', { name }).first().click();
  for (const wait of [300, 1000, 3000]) {
    await page.waitForTimeout(wait);
    const seen = await sample(label);
    console.log(
      JSON.stringify({
        label,
        ms: Date.now() - t0,
        off: seen.cameraButtonSaysOff,
        gum: seen.gum,
        senders: seen.senders
          .filter((x) => x.track || x.stats.length)
          .map((x) => `${x.track} ${x.settings} ${x.stats}`),
        viewer: await received(),
      }),
    );
  }
}
await page.keyboard.press('Escape');
await page.waitForTimeout(2000);
console.log(JSON.stringify(await sample('настройки закрыты')));
await page.screenshot({ path: `${out}/after.png` });
await browser.close();
