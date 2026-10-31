/**
 * Где Excalidraw берёт шрифты (R159) — у себя, а не с CDN (`esm.sh`): CSP (`font-src 'self'`) чужого не
 * пустит, и правило «ни одной ссылки наружу» тоже. Файлы шрифтов кладёт в сборку `vite.config.ts`
 * (`excalidrawAssets`) по версионному пути — их можно кэшировать навсегда, как всё под `/assets/`.
 *
 * Отдельный модуль, подключённый раньше Excalidraw: тот читает путь, когда заводит шрифты.
 */
declare const __EXCALIDRAW_ASSETS__: string;

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

export const EXCALIDRAW_ASSETS =
  typeof __EXCALIDRAW_ASSETS__ === 'string' ? __EXCALIDRAW_ASSETS__ : '/assets/excalidraw/';

window.EXCALIDRAW_ASSET_PATH = EXCALIDRAW_ASSETS;
