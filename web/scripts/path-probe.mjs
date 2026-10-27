// Зонд: каким путём идёт медиа (UDP / TCP / TURN) до, во время и после потери UDP.
//   node scripts/path-probe.mjs --base https://meet.nikg.tech --block all [--before 3 --blocked 10 --after 25]
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]]);
    return pairs;
  }, []),
);
const base = args.base ?? 'https://cordcam.ru';
// Только UDP этого зонда (его cgroup): сервер на той же машине и его TURN этого правила не видят.
const own = readFileSync('/proc/self/cgroup', 'utf8').trim().split('::')[1];
// `--block all` — весь UDP зонда, кроме DNS: сервер на той же машине отвечает и с внутренних адресов.
const target = args.block === 'all' ? '! --dport 53' : `-d ${args.block}`;
const rule = `OUTPUT -p udp ${target} -m cgroup --path ${own} -m comment --comment cord-path-probe -j DROP`;
const unblock = () => {
  try {
    execSync(`iptables -D ${rule}`, { stdio: 'ignore' });
  } catch {
    /* правила уже нет */
  }
};
process.on('exit', unblock);
const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  // Без D-Bus: иначе Chrome переселяет себя в свой systemd-scope, и правило по cgroup его не видит.
  env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: 'disabled:' },
});
const hook = () => {
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
};
async function open(phone) {
  const ctx = await browser.newContext({
    viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 800 },
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
  return ctx.newPage();
}
const connected = (page) => page.locator('[data-media-status="connected"]').waitFor({ timeout: 60000 });
const host = await open(false);
await host.goto(base);
await host.getByRole('button', { name: /Новая встреча/ }).click({ timeout: 30000 });
await host.getByLabel('Ваше имя').fill('Зритель');
await host.getByRole('button', { name: 'Начать встречу' }).click();
await connected(host);
await host.getByRole('button', { name: 'Пригласить участников' }).click();
const invite = await host.getByLabel('Ссылка приглашения').inputValue();
await host.getByRole('button', { name: 'Закрыть', exact: true }).click();
const phone = await open(true);
phone.on('console', (m) => /\[cord\]/.test(m.text()) && console.log('  phone:', m.text().slice(0, 160)));
await phone.goto(invite);
await phone.getByLabel('Ваше имя').fill('Телефон');
await phone.getByRole('button', { name: 'Войти во встречу' }).click();
await connected(phone);
const on = phone.getByRole('button', { name: 'Включить камеру', exact: true });
if (await on.isVisible().catch(() => false)) await on.click();

const mediaPath = (page) =>
  page.evaluate(async () => {
    const out = [];
    for (const [index, pc] of window.__pcs.entries()) {
      if (pc.connectionState === 'closed') continue;
      const report = await pc.getStats();
      let pair;
      report.forEach((s) => {
        if (s.type === 'transport' && s.selectedCandidatePairId) pair = report.get(s.selectedCandidatePairId);
      });
      const local = pair && report.get(pair.localCandidateId);
      let video = '';
      let inbound = 0;
      report.forEach((s) => {
        if (s.type === 'outbound-rtp' && s.kind === 'video' && s.frameHeight)
          video = ` out ${s.frameHeight}p@${s.framesPerSecond ?? 0}`;
        if (s.type === 'inbound-rtp') inbound++;
      });
      video += ` in ${inbound}`;
      out.push(
        `pc${index}:${pc.iceConnectionState}` +
          (local ? ` ${local.candidateType}/${local.relayProtocol ?? local.protocol}` : '') +
          video,
      );
    }
    return out.join(' | ');
  });
const t0 = Date.now();
const log = async (phase) =>
  console.log(
    `${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s ${phase}: ${await mediaPath(phone)}`,
  );
for (let i = 0; i < Number(args.before ?? 3); i++) {
  await phone.waitForTimeout(4000);
  await log('UDP открыт');
}
execSync(`iptables -I ${rule}`);
for (let i = 0; i < Number(args.blocked ?? 12); i++) {
  await phone.waitForTimeout(4000);
  await log('UDP закрыт');
}
unblock();
for (let i = 0; i < Number(args.after ?? 25); i++) {
  await phone.waitForTimeout(4000);
  await log('UDP снова открыт');
  // `--nudge N` — на N-м замере сказать странице «сеть сменилась» (как `online` браузера).
  if (i + 1 === Number(args.nudge)) {
    console.log('     → online');
    await phone.evaluate(() => window.dispatchEvent(new Event('online')));
  }
}
await browser.close();
