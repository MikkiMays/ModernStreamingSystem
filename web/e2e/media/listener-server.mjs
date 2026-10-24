// Браузер-слушатель внутри сетевого пространства имён (R107, `netns.sh`): Playwright-сервер слушает
// адрес пространства, тест подключается к нему `chromium.connect(…)`. Имя стенда разрешается
// правилом Chromium — DNS внутри пространства нет.
//
//   sudo e2e/media/netns.sh exec node e2e/media/listener-server.mjs     # из web/
//   → печатает ws://10.213.0.2:9555/listener — это CORD_LISTENER_WS для voice-probe.spec.ts
import { chromium } from '@playwright/test';
import { lookup } from 'node:dns/promises';

const stand = new URL(process.env.PLAYWRIGHT_BASE_URL ?? 'https://cord.nikg.tech');
// Внутри пространства DNS нет: адрес стенда передают снаружи (CORD_STAND_IP) или берут из /etc/hosts.
const address = process.env.CORD_STAND_IP ?? (await lookup(stand.hostname).catch(() => null))?.address;
if (!address) throw new Error('CORD_STAND_IP не задан, а имя стенда внутри пространства не разрешается');
const host = process.env.CORD_LISTENER_HOST ?? '10.213.0.2';
const port = Number(process.env.CORD_LISTENER_PORT ?? 9555);
const server = await chromium.launchServer({
  host,
  port,
  wsPath: '/listener',
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    `--host-resolver-rules=MAP ${stand.hostname} ${address}`,
    ...(process.env.CORD_FAKE_AUDIO
      ? [`--use-file-for-fake-audio-capture=${process.env.CORD_FAKE_AUDIO}`]
      : []),
  ],
});
console.log(server.wsEndpoint());
const stop = async () => {
  await server.close().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
