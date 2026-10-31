import { exportToBlob, exportToSvg } from '@excalidraw/excalidraw';
import type { NonDeleted, ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { boardDocument, visible, type BoardFileData } from '../../core/board/export';
import type { BoardElement } from '../../core/board/protocol';
import type { Shade } from './theme';

/**
 * Доска картинкой и файлом (R154): PNG вдвое крупнее экрана, SVG и `.cord-board` — то, что уходит в чат
 * и на устройство. Фон — по теме человека: тёмная тема даёт тёмную картинку, как на экране.
 */

/** Сторона картинки — не больше этого: дальше браузер не создаст холст. */
const MAX_SIDE = 8192;

function scene(api: ExcalidrawImperativeAPI) {
  return visible(
    api.getSceneElements() as unknown as BoardElement[],
  ) as unknown as NonDeleted<ExcalidrawElement>[];
}

export function hasContent(api: ExcalidrawImperativeAPI): boolean {
  return scene(api).length > 0;
}

export async function boardPng(api: ExcalidrawImperativeAPI, shade: Shade): Promise<Blob> {
  return exportToBlob({
    elements: scene(api),
    appState: { ...api.getAppState(), exportBackground: true, exportWithDarkMode: shade === 'dark' },
    files: api.getFiles(),
    mimeType: 'image/png',
    exportPadding: 24,
    getDimensions: (width: number, height: number) => {
      const scale = Math.min(2, MAX_SIDE / Math.max(width, height, 1));
      return { width: Math.round(width * scale), height: Math.round(height * scale), scale };
    },
  });
}

export async function boardSvg(api: ExcalidrawImperativeAPI, shade: Shade): Promise<Blob> {
  const svg = await exportToSvg({
    elements: scene(api),
    appState: { ...api.getAppState(), exportBackground: true, exportWithDarkMode: shade === 'dark' },
    files: api.getFiles(),
    exportPadding: 24,
    // Встроить шрифты Excalidraw умеет только через модуль woff2 с `new Function` — его CSP Cord не
    // пускает (`script-src` без 'unsafe-eval'). SVG ссылается на шрифты по имени, картинки внутри.
    skipInliningFonts: true,
  });
  return new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' });
}

/** Файл доски `.cord-board`: элементы и картинки внутри. */
export function boardJson(api: ExcalidrawImperativeAPI): Blob {
  const files = api.getFiles() as unknown as Record<string, BoardFileData>;
  const doc = boardDocument(
    api.getSceneElements() as unknown as BoardElement[],
    files,
    api.getAppState().viewBackgroundColor,
  );
  return new Blob([JSON.stringify(doc)], { type: 'application/json' });
}

/** Отдать файл браузеру на сохранение — ссылкой `blob:` (клиент Windows её пропускает). */
export function saveFile(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
