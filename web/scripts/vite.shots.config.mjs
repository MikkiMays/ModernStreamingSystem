// Dev-сервер для снимков из рабочей копии, у которой node_modules — ссылка на соседний каталог
// (`npx vite --config scripts/vite.shots.config.mjs --port 5199 --strictPort`, затем `node scripts/shots.mjs
// --base http://127.0.0.1:5199 --screens admin`). Без разрешения Vite не отдаёт по ссылке файлы шрифтов, и снимки
// выходят запасным шрифтом.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vite';
import base from '../vite.config.ts';

const modules = realpathSync(fileURLToPath(new URL('../node_modules', import.meta.url)));

export default defineConfig(async (env) => {
  const resolved = typeof base === 'function' ? await base(env) : base;
  return mergeConfig(resolved, { server: { fs: { allow: ['..', modules] } } });
});
