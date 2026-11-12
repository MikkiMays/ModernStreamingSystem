// Dev-сервер для снимков из рабочей копии, у которой node_modules — ссылка на соседний каталог:
// без разрешения Vite не отдаёт оттуда файлы шрифтов, и снимки выходят запасным шрифтом.
import { defineConfig, mergeConfig } from 'vite';
import base from '../vite.config.ts';

export default defineConfig(async (env) => {
  const resolved = typeof base === 'function' ? await base(env) : base;
  return mergeConfig(resolved, {
    server: { fs: { allow: ['..', '/opt/ModernStreamingSystem/web/node_modules'] } },
  });
});
