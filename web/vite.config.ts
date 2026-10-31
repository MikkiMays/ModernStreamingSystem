import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

export default defineConfig({
  define: {
    __CORD_VERSION__: JSON.stringify(version),
  },
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
    buildMeta(),
    mediapipeAssets(),
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
  },
});
