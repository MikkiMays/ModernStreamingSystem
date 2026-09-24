import { execSync } from 'node:child_process';
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

export default defineConfig({
  define: {
    __CORD_VERSION__: JSON.stringify(version),
    __CORD_BUILD__: JSON.stringify(commit()),
  },
  plugins: [react(), babel({ presets: [reactCompilerPreset()] }), tailwindcss()],
  server: {
    proxy: {
      '/api/v1/services': { target: process.env.CORD_DEV_SERVICES ?? 'http://127.0.0.1:18100' },
      '/api': { target: process.env.CORD_DEV_API ?? 'http://127.0.0.1:8080', ws: true },
      '/uploads': { target: process.env.CORD_DEV_UPLOADS ?? 'http://127.0.0.1:1081' },
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
