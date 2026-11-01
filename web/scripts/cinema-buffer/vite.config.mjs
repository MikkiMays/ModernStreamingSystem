// Сборка стенда замера буфера: `npx vite build --config scripts/cinema-buffer/vite.config.mjs` (из web/).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  root,
  base: '/',
  logLevel: 'warn',
  build: { outDir: root + 'dist', emptyOutDir: true, minify: false },
});
