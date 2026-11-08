import { execSync } from 'node:child_process';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import babel from '@rolldown/plugin-babel';
import tailwindcss from '@tailwindcss/vite';
import { version } from './package.json' with { type: 'json' };

/**
 * Какую именно сборку отдаёт этот сервер.
 *
 * Версия одна на пакет, а коммит отвечает на вопрос, который версия не отвечает: выкатили
 * ли уже то, что починили. В образ репозиторий не попадает (`.dockerignore` исключает `.git`),
 * поэтому там коммит передаётся переменной окружения. Нет ни того, ни другого — просто нет
 * коммита; сборка из архива остаётся сборкой.
 *
 * Человеку коммит не показывается (владелец, 29.10.2026): он живёт в `<meta name="cord-build">`
 * страницы (`buildMeta`), и сверяет его выкатка (`backlog/bin/deploy.sh`).
 */
function commit() {
  if (process.env.CORD_BUILD) return process.env.CORD_BUILD.trim().slice(0, 12);
  try {
    return execSync('git rev-parse --short HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Куда отправлять API, службы и загрузки — одним объектом для dev-сервера и `vite preview`.
 *
 * Сборка ведёт себя не во всём как dev-сервер: CSS ленивых чанков приезжает отдельными файлами в
 * конец каскада, код минифицирован. Поэтому эталон вида снимается и со сборки, тем же стендом, —
 * а для этого у `preview` должен быть тот же прокси, что у dev.
 */
const proxy = {
  '/api/v1/services': { target: process.env.CORD_DEV_SERVICES ?? 'http://127.0.0.1:18100' },
  '/api': { target: process.env.CORD_DEV_API ?? 'http://127.0.0.1:8080', ws: true },
  '/uploads': { target: process.env.CORD_DEV_UPLOADS ?? 'http://127.0.0.1:1081' },
};

/** Коммит сборки — в `<head>` обеих страниц (приложение и Mini App), не в интерфейсе. */
function buildMeta(): Plugin {
  const build = commit();
  return {
    name: 'cord-build-meta',
    transformIndexHtml: () =>
      build ? [{ tag: 'meta', attrs: { name: 'cord-build', content: build }, injectTo: 'head' }] : [],
  };
}

/**
 * Шрифты доски (R159) — свои, а не с CDN Excalidraw (`esm.sh`): CSP пускает шрифты только со своего
 * адреса (`font-src 'self'`). Сборка кладёт `dist/prod/fonts` пакета в `/assets/excalidraw-<версия>/fonts/`
 * — путь меняется с версией, поэтому шлюз кэширует его навсегда, как всё под `/assets/`. Dev-сервер
 * отдаёт те же файлы прямо из `node_modules`. Путь доска узнаёт из `__EXCALIDRAW_ASSETS__`
 * (`ui/board/asset-path.ts`), а запасной адрес пакета на esm.sh сборка заменяет тем же путём.
 */
const excalidrawRoot = fileURLToPath(new URL('./node_modules/@excalidraw/excalidraw/', import.meta.url));
const excalidrawVersion = existsSync(join(excalidrawRoot, 'package.json'))
  ? (JSON.parse(readFileSync(join(excalidrawRoot, 'package.json'), 'utf8')) as { version: string }).version
  : '0';
const excalidrawAssets = `assets/excalidraw-${excalidrawVersion}/`;

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

function excalidrawFonts(): Plugin {
  const fonts = join(excalidrawRoot, 'dist', 'prod', 'fonts');
  return {
    name: 'cord-excalidraw-fonts',
    configureServer(server) {
      server.middlewares.use(`/${excalidrawAssets}fonts/`, (request, response, next) => {
        const file = join(fonts, decodeURIComponent((request.url ?? '').split('?')[0] ?? ''));
        if (!file.startsWith(fonts + sep) || !existsSync(file)) return next();
        response.setHeader('Content-Type', 'font/woff2');
        createReadStream(file).pipe(response);
      });
    },
    // Запасной адрес шрифтов Excalidraw (`ASSETS_FALLBACK_URL`, esm.sh) стоит в каждом `FontFace` вторым
    // источником, а Chrome сверяет с CSP все источники сразу при создании: 230 нарушений на каждое открытие
    // доски, хотя грузятся свои. В сборке запасной адрес — тот же свой путь. Не нашёлся (другая версия
    // пакета) — сборка падает: внешний адрес не должен вернуться молча.
    transform(code, id) {
      if (!id.includes('@excalidraw/excalidraw/dist/') || !code.includes('"ASSETS_FALLBACK_URL"')) return;
      const next = code.replace(
        /("ASSETS_FALLBACK_URL",\s*)`https:\/\/esm\.sh\/.*?\/dist\/prod\/`/s,
        // Абсолютный: Excalidraw берёт его основанием `new URL(путь, основание)`, относительное там — ошибка.
        (_, head: string) =>
          `${head}(globalThis.location?.origin ?? '') + ${JSON.stringify(`/${excalidrawAssets}`)}`,
      );
      if (next === code) this.error(`Excalidraw ${excalidrawVersion}: запасной адрес шрифтов не найден`);
      return { code: next, map: null };
    },
    generateBundle() {
      for (const file of files(fonts))
        this.emitFile({
          type: 'asset',
          fileName: `${excalidrawAssets}fonts/${relative(fonts, file).split(sep).join('/')}`,
          source: readFileSync(file),
        });
    },
  };
}

/**
 * Фон в видео (R153): wasm MediaPipe — со своего сервера, а не с jsdelivr. По умолчанию
 * `@livekit/track-processors` тянет его с CDN, а модель — с googleapis, и CSP шлюза закрыла бы и то и
 * другое (ослаблять её нельзя). Модель (250 КБ) лежит в `public/mediapipe/`, а wasm (~18 МБ) в
 * репозиторий не кладём: в dev он отдаётся из `node_modules`, в сборку копируется рядом.
 */
function mediapipeAssets(): Plugin {
  const source = fileURLToPath(new URL('./node_modules/@mediapipe/tasks-vision/wasm/', import.meta.url));
  const files = [
    'vision_wasm_internal.js',
    'vision_wasm_internal.wasm',
    'vision_wasm_nosimd_internal.js',
    'vision_wasm_nosimd_internal.wasm',
  ];
  const type = (name: string) => (name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
  return {
    name: 'cord-mediapipe-assets',
    configureServer(server) {
      server.middlewares.use('/mediapipe/wasm/', (request, response, next) => {
        const name = (request.url ?? '').replace(/^\//, '').split('?')[0]!;
        if (!files.includes(name)) return next();
        response.setHeader('Content-Type', type(name));
        response.end(readFileSync(source + name));
      });
    },
    generateBundle() {
      for (const name of files)
        this.emitFile({
          type: 'asset',
          fileName: `mediapipe/wasm/${name}`,
          source: readFileSync(source + name),
        });
    },
  };
}

/**
 * Что не должно попасть в первую загрузку (главная, прихожая, настройки): SDK звонка, доска, сегментация фона,
 * плеер потоков. Они нужны только во встрече, а на телефоне их разбор держит главную секундами. Сборка
 * обходит статические импорты входов (динамические — не в счёт: они грузятся по требованию) и падает, если
 * такой модуль туда вернулся, — например, значением вместо `import type`.
 */
const NOT_AT_START = [
  '/node_modules/livekit-client/',
  '/node_modules/@excalidraw/',
  '/node_modules/@mediapipe/',
  '/node_modules/hls.js/',
];

function startupBudget(): Plugin {
  return {
    name: 'cord-startup-budget',
    apply: 'build',
    generateBundle(_, bundle) {
      const chunks = new Map(
        Object.values(bundle).flatMap((item) =>
          item.type === 'chunk' ? [[item.fileName, item] as const] : [],
        ),
      );
      // Откуда пришёл каждый чанк — чтобы в отказе была цепочка от входа, а не одно имя.
      const from = new Map<string, string>();
      const queue = [...chunks.values()].filter((chunk) => chunk.isEntry).map((chunk) => chunk.fileName);
      for (const entry of queue) from.set(entry, '');
      while (queue.length) {
        const name = queue.shift()!;
        const chunk = chunks.get(name);
        if (!chunk) continue;
        const heavy = (chunk.moduleIds ?? Object.keys(chunk.modules)).find((id) =>
          NOT_AT_START.some((path) => id.replaceAll(sep, '/').includes(path)),
        );
        if (heavy) {
          const path = [name];
          for (let at = from.get(name); at; at = from.get(at)) path.unshift(at);
          this.error(`первая загрузка тянет ${heavy}: ${path.join(' → ')} — импортируйте его по требованию`);
        }
        for (const next of chunk.imports)
          if (!from.has(next)) {
            from.set(next, name);
            queue.push(next);
          }
      }
    },
  };
}

export default defineConfig({
  define: {
    __CORD_VERSION__: JSON.stringify(version),
    __EXCALIDRAW_ASSETS__: JSON.stringify(`/${excalidrawAssets}`),
  },
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
    buildMeta(),
    mediapipeAssets(),
    excalidrawFonts(),
    startupBudget(),
  ],
  server: { proxy },
  preview: { proxy },
  /*
    Два HTML-входа: приложение и Mini App Telegram (`tg.html`, E09). Mini App — отдельный документ, а не
    маршрут: роутера в вебе нет (решение архитектора 13), а Telegram Web открывает `/tg` в рамке, которую
    шлюз разрешает только этому пути (`infra/Caddyfile`). Общий код — общими чанками.
  */
  build: {
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        tg: fileURLToPath(new URL('./tg.html', import.meta.url)),
        // Пульт флота (R207, Р-119): третий вход, шлюз отдаёт его только на имени ADMIN_HOST.
        admin: fileURLToPath(new URL('./admin.html', import.meta.url)),
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // CSS в тестах выключен целиком, и `import … from '*.css?raw'` получал бы пустую строку. Текстом
    // CSS читает только сверка границ раскладки (`ui/breakpoints.test.ts`) — ей текст и отдаётся.
    css: { include: [/\.css\?raw$/] },
    // Excalidraw (R159) — ESM-сборка с импортами без расширений: её разбирает Vite, а не Node.
    server: { deps: { inline: [/@excalidraw\/excalidraw/] } },
  },
});
