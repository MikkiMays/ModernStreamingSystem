// Dev-сервер для снимков невыкаченных экранов (E15-B): конфиг веба как есть, плюс доступ к
// node_modules основного checkout — в worktree он ссылкой, и Vite иначе не отдаёт шрифт Inter.
//   CORD_DEV_API=http://127.0.0.1:18080 npx vite --config scripts/vite.figma.config.mjs --port 5199
import base from '../vite.config.ts';

export default {
  ...base,
  server: { ...base.server, fs: { strict: false } },
};
