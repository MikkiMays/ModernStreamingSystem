import type { BoardElement } from './protocol';

/**
 * Файл доски `.cord-board` (R154, «как в Телемосте»): сохранить доску в чат или на устройство и потом
 * открыть её на доске снова.
 *
 * Это JSON Excalidraw (`type: "excalidraw"`, `version: 2`) с `source: "cord"` и картинками внутри
 * (`files`, `data:`-ссылки): его открывает и сам Cord, и любой редактор Excalidraw. Удалённые элементы и
 * недорисованные штрихи соседей в файл не идут.
 */
export const BOARD_EXTENSION = '.cord-board';
export const BOARD_MIME = 'application/vnd.cord.board+json';

/** Картинка сцены так, как её хранит Excalidraw. */
export interface BoardFileData {
  id: string;
  dataURL: string;
  mimeType: string;
  created: number;
}

export interface BoardDocument {
  type: 'excalidraw';
  version: 2;
  source: 'cord';
  elements: BoardElement[];
  appState: { viewBackgroundColor: string; gridSize: null };
  files: Record<string, BoardFileData>;
}

/** Временный штрих соседа: его нет у ядра и не должно быть в файле. */
export function isInk(el: BoardElement): boolean {
  const data = el.customData as { cordInk?: boolean } | undefined;
  return !!data?.cordInk;
}

/** То, что видно на доске: без удалённого и без чужих недорисованных штрихов. */
export function visible(elements: readonly BoardElement[]): BoardElement[] {
  return elements.filter((el) => !el.isDeleted && !isInk(el));
}

/** Картинки, на которые ссылаются видимые элементы. */
export function referencedFiles(
  elements: readonly BoardElement[],
  files: Readonly<Record<string, BoardFileData | undefined>>,
): Record<string, BoardFileData> {
  const used: Record<string, BoardFileData> = {};
  for (const el of elements)
    if (el.type === 'image' && typeof el.fileId === 'string') {
      const file = files[el.fileId];
      if (file)
        used[el.fileId] = {
          id: file.id,
          dataURL: file.dataURL,
          mimeType: file.mimeType,
          created: file.created,
        };
    }
  return used;
}

export function boardDocument(
  elements: readonly BoardElement[],
  files: Readonly<Record<string, BoardFileData | undefined>>,
  background: string,
): BoardDocument {
  const shown = visible(elements);
  return {
    type: 'excalidraw',
    version: 2,
    source: 'cord',
    elements: shown,
    appState: { viewBackgroundColor: background, gridSize: null },
    files: referencedFiles(shown, files),
  };
}

export function serializeBoard(
  elements: readonly BoardElement[],
  files: Readonly<Record<string, BoardFileData | undefined>>,
  background: string,
): string {
  return JSON.stringify(boardDocument(elements, files, background));
}

/** Не файл доски: не JSON, не сцена Excalidraw или в нём нет элементов. */
export class BoardFileError extends Error {}

/** Разобрать `.cord-board` или `.excalidraw`: элементы и картинки, без проверки слиянием. */
export function parseBoard(
  text: string,
): Pick<BoardDocument, 'elements' | 'files'> & { background?: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new BoardFileError('not json');
  }
  const doc = data as Partial<BoardDocument> | null;
  if (!doc || doc.type !== 'excalidraw' || !Array.isArray(doc.elements))
    throw new BoardFileError('not a board');
  const files: Record<string, BoardFileData> = {};
  for (const [id, file] of Object.entries(doc.files ?? {}))
    if (file && typeof file.dataURL === 'string' && file.dataURL.startsWith('data:image/'))
      files[id] = { id, dataURL: file.dataURL, mimeType: file.mimeType, created: file.created ?? Date.now() };
  return {
    elements: doc.elements.filter((el) => el && typeof el === 'object' && typeof el.id === 'string'),
    files,
    background: doc.appState?.viewBackgroundColor,
  };
}

/** Новый номер элемента — того же вида, что у Excalidraw (nanoid: 21 знак `A-Za-z0-9_-`). */
export function randomId(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  const bytes = crypto.getRandomValues(new Uint8Array(21));
  let id = '';
  for (const byte of bytes) id += alphabet[byte & 63];
  return id;
}

/**
 * «Добавить на доску»: те же элементы под новыми номерами, со всеми связями — группы, рамки, текст в
 * фигуре, стрелки к фигурам. Иначе вставка файла поверх доски с тем же содержимым перезаписала бы её
 * элементы. Слой (`index`) сбрасывается: Excalidraw поставит вставленное поверх.
 */
export function remapIds(elements: readonly BoardElement[], makeId: () => string = randomId): BoardElement[] {
  const ids = new Map<string, string>();
  const groups = new Map<string, string>();
  for (const el of elements) ids.set(el.id, makeId());
  const map = (id: unknown) => (typeof id === 'string' ? (ids.get(id) ?? null) : null);
  const group = (id: string) => {
    if (!groups.has(id)) groups.set(id, makeId());
    return groups.get(id)!;
  };
  return elements.map((el) => {
    const next: BoardElement = { ...el, id: ids.get(el.id)!, index: null };
    if (Array.isArray(el.groupIds)) next.groupIds = (el.groupIds as string[]).map(group);
    if (el.frameId !== undefined) next.frameId = map(el.frameId);
    if (el.containerId !== undefined) next.containerId = map(el.containerId);
    if (Array.isArray(el.boundElements))
      next.boundElements = (el.boundElements as { id: string; type: string }[])
        .filter((bound) => ids.has(bound.id))
        .map((bound) => ({ ...bound, id: ids.get(bound.id)! }));
    for (const key of ['startBinding', 'endBinding'] as const) {
      const binding = el[key] as { elementId?: string } | null | undefined;
      if (binding && typeof binding === 'object')
        next[key] = ids.has(binding.elementId ?? '')
          ? { ...binding, elementId: ids.get(binding.elementId!)! }
          : null;
    }
    return next;
  });
}

/** Рамка элементов в координатах сцены (поворот не учитывается — для «поставить в центр» хватает). */
export function bounds(elements: readonly BoardElement[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const el of elements) {
    const x = el.x ?? 0;
    const y = el.y ?? 0;
    const points = Array.isArray(el.points) && el.points.length ? el.points : null;
    if (points)
      for (const point of points) {
        minX = Math.min(minX, x + point[0]!);
        minY = Math.min(minY, y + point[1]!);
        maxX = Math.max(maxX, x + point[0]!);
        maxY = Math.max(maxY, y + point[1]!);
      }
    else {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + (el.width ?? 0));
      maxY = Math.max(maxY, y + (el.height ?? 0));
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : { minX: 0, minY: 0, maxX: 0, maxY: 0 };
}

/** Сдвинуть элементы так, чтобы середина их рамки встала в точку `(x, y)` сцены. */
export function centerAt(elements: readonly BoardElement[], x: number, y: number): BoardElement[] {
  const box = bounds(elements);
  const dx = x - (box.minX + box.maxX) / 2;
  const dy = y - (box.minY + box.maxY) / 2;
  return elements.map((el) => ({ ...el, x: (el.x ?? 0) + dx, y: (el.y ?? 0) + dy }));
}

/** Время для подписи «Доска · 14:20» и для имени файла «… 14-20» (двоеточия в именах файлов нельзя). */
export function boardStamp(date: Date, locale: string): { time: string; file: string } {
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false }).format(
    date,
  );
  const pad = (n: number) => String(n).padStart(2, '0');
  return { time, file: `${pad(date.getHours())}-${pad(date.getMinutes())}` };
}

/** Файл доски по имени: `.cord-board` и `.excalidraw` — сцена, PNG — может нести сцену внутри. */
export function boardFileKind(name: string): 'board' | 'png' | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(BOARD_EXTENSION) || lower.endsWith('.excalidraw') || lower.endsWith('.json'))
    return 'board';
  if (lower.endsWith('.png')) return 'png';
  return null;
}
