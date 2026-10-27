// Зонд: что телефон с портретной камерой отдаёт в сеть и что получает компьютер.
//   node scripts/phone-camera-probe.mjs --base https://meet.nikg.tech --camera /path/portrait.y4m
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
const exe = '/usr/bin/google-chrome';
const flags = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];
const desk = await chromium.launch({ executablePath: exe, args: flags });
const phoneBrowser = await chromium.launch({
  executablePath: exe,
  args: [...flags, `--use-file-for-fake-video-capture=${args.camera}`],
});

const hook = () => {
  window.__pcs = [];
  const Native = window.RTCPeerConnection;
  window.RTCPeerConnection = function (...a) {
    const pc = new Native(...a);
    window.__pcs.push(pc);
    return pc;
  };
  window.RTCPeerConnection.prototype = Native.prototype;
  Object.setPrototypeOf(window.RTCPeerConnection, Native);
  localStorage.setItem(
    'cord:onboarding:v1',
    JSON.stringify({ tour: true, meeting: true, integrations: true }),
  );
};

// Телефон в портретном положении отдаёт кадр, повёрнутый относительно запрошенного (Safari, Chrome на Android).
const portrait = () => {
  const swap = (c) => {
    if (!c || typeof c !== 'object') return c;
    const { width, height, ...rest } = c;
    return {
      ...rest,
      ...(height !== undefined ? { width: height } : {}),
      ...(width !== undefined ? { height: width } : {}),
    };
  };
  const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = (c) => gum(c?.video ? { ...c, video: swap(c.video) } : c);
  const apply = MediaStreamTrack.prototype.applyConstraints;
  MediaStreamTrack.prototype.applyConstraints = function (c) {
    return apply.call(this, this.kind === 'video' ? swap(c) : c);
  };
};

async function context(browser, phone) {
  const ctx = await browser.newContext({
    viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    deviceScaleFactor: phone ? 3 : 1,
    isMobile: phone,
    hasTouch: phone,
    permissions: ['camera', 'microphone'],
    locale: 'ru-RU',
    serviceWorkers: 'block',
  });
  // `--dist` — своя сборка вместо выложенной: страница и её файлы из папки, API — с сервера.
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
  await ctx.addInitScript(hook);
  if (phone && args.rotate !== 'no') await ctx.addInitScript(portrait);
  return ctx;
}
const connected = (page) => page.locator('[data-media-status="connected"]').waitFor({ timeout: 45000 });

async function rtp(page, type) {
  return page.evaluate(async (type) => {
    const rows = [];
    for (const pc of window.__pcs) {
      const report = await pc.getStats();
      report.forEach((s) => {
        if (s.type !== type || s.kind !== 'video') return;
        rows.push({
          rid: s.rid,
          w: s.frameWidth,
          h: s.frameHeight,
          fps: s.framesPerSecond,
          active: s.active,
          limit: s.qualityLimitationReason,
          kbytes: Math.round((s.bytesSent ?? s.bytesReceived ?? 0) / 1000),
          target: s.targetBitrate,
        });
      });
    }
    return rows;
  }, type);
}

const hostPage = await (await context(desk, false)).newPage();
await hostPage.goto(base);
await hostPage.getByRole('button', { name: /Новая встреча/ }).click({ timeout: 30000 });
await hostPage.getByLabel('Ваше имя').fill('Компьютер');
await hostPage.getByRole('button', { name: 'Начать встречу' }).click();
await connected(hostPage);
await hostPage.getByRole('button', { name: 'Пригласить участников' }).click();
const invite = await hostPage.getByLabel('Ссылка приглашения').inputValue();
await hostPage.getByRole('button', { name: 'Закрыть', exact: true }).click();

const phone = await (await context(phoneBrowser, true)).newPage();
phone.on('console', (m) => m.type() === 'error' && console.log('phone console:', m.text().slice(0, 200)));
await phone.goto(invite);
await phone.getByLabel('Ваше имя').fill('Телефон');
await phone.getByRole('button', { name: 'Войти во встречу' }).click();
await connected(phone);
const on = phone.getByRole('button', { name: 'Включить камеру', exact: true });
if (await on.isVisible().catch(() => false)) await on.click();

for (let i = 0; i < 6; i++) {
  await phone.waitForTimeout(5000);
  const settings = await phone.evaluate(async () => {
    const out = [];
    for (const pc of window.__pcs)
      for (const s of pc.getSenders())
        if (s.track?.kind === 'video')
          out.push({ settings: s.track.getSettings(), encodings: s.getParameters().encodings });
    return out;
  });
  const dock = await phone.evaluate(() => document.body.innerText.match(/\d+p · \d+ fps/g));
  console.log(`--- t=${(i + 1) * 5}s phone dock:`, dock);
  if (i === 0) console.log('phone sender:', JSON.stringify(settings));
  console.log('phone out:', JSON.stringify(await rtp(phone, 'outbound-rtp')));
  console.log('host in:', JSON.stringify(await rtp(hostPage, 'inbound-rtp')));
}
await hostPage.screenshot({ path: args.shot ?? '/tmp/host.png' });
await phone.screenshot({ path: (args.shot ?? '/tmp/host.png').replace('.png', '-phone.png') });
await desk.close();
await phoneBrowser.close();
