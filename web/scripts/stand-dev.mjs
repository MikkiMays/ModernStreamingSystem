// Невыкаченный веб против стенда со всем медиа: страница — из этого рабочего каталога (dev-сервер
// Vite), ядро, SFU, службы и загрузки — настоящие на https://cord.nikg.tech.
//
//   node scripts/stand-dev.mjs                       # https://127.0.0.1:5443, стенд cord.nikg.tech
//   CORD_STAND_DEV=127.0.0.1:5443 PLAYWRIGHT_BASE_URL=https://cord.nikg.tech npx playwright test e2e/…
//
// Зачем так. Ядро отвечает 403 на чужой `Origin` (`RequestGuard` сравнивает с `PUBLIC_URL`), а SFU
// пускает только страницу стенда, поэтому обычный dev-сервер с прокси держит встречу секунд двадцать
// (скилл `verify`). Здесь браузер думает, что открыл сам стенд: Chromium запускают с
// `--host-resolver-rules=MAP cord.nikg.tech:443 127.0.0.1:5443` и `--ignore-certificate-errors`
// (это делает `playwright.config.ts` при `CORD_STAND_DEV`), а Vite на 5443 отдаёт приложение и
// проксирует `/api`, `/rtc` и `/uploads` настоящему стенду — Node разрешает имя обычным DNS. Origin у
// запросов — `https://cord.nikg.tech`, медиа идёт напрямую на адреса SFU из ICE.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const web = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const stand = process.env.CORD_STAND ?? 'https://cord.nikg.tech';
const [host, port] = (process.env.CORD_STAND_DEV ?? '127.0.0.1:5443').split(':');
const name = new URL(stand).hostname;

// Самоподписанный сертификат на имя стенда — только для этого браузера (`--ignore-certificate-errors`).
const certs = path.join(web, '.local', 'stand-dev');
const key = path.join(certs, 'key.pem');
const cert = path.join(certs, 'cert.pem');
if (!existsSync(cert)) {
  mkdirSync(certs, { recursive: true });
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '30',
      '-keyout',
      key,
      '-out',
      cert,
      '-subj',
      `/CN=${name}`,
      '-addext',
      `subjectAltName=DNS:${name}`,
    ],
    { stdio: 'ignore' },
  );
}

const upstream = { target: stand, changeOrigin: true, secure: true, ws: true };
const server = await createServer({
  root: web,
  configFile: path.join(web, 'vite.config.ts'),
  // Свой кэш зависимостей: `node_modules` у рабочих копий общий, и чужой dev-сервер не пересобирает его.
  cacheDir: path.join(web, '.local', 'stand-dev', 'vite'),
  server: {
    host,
    port: Number(port),
    strictPort: true,
    https: { key: readFileSync(key), cert: readFileSync(cert) },
    proxy: { '/api': upstream, '/rtc': upstream, '/uploads': upstream },
    // Клиент HMR открывает сокет на адрес страницы — то есть на «стенд», которого браузер не покидал.
    hmr: { clientPort: 443, host: name },
    // `node_modules` рабочей копии бывает ссылкой на общий каталог — шрифты оттуда тоже отдаются.
    fs: { allow: [web, realpathSync(path.join(web, 'node_modules'))] },
  },
});
await server.listen();
console.log(`stand-dev: https://${host}:${port} → ${stand}`);
console.log(`chromium: --host-resolver-rules="MAP ${name}:443 ${host}:${port}" --ignore-certificate-errors`);
