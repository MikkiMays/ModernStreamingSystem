// Холст jsdom — раньше Excalidraw: его `loadFromBlob` меряет текст при разборе сцены.
import '../../test/canvas-stub';
import { loadFromBlob } from '@excalidraw/excalidraw';
import { describe, expect, it } from 'vitest';
import {
  boardFileKind,
  boardStamp,
  bounds,
  centerAt,
  parseBoard,
  remapIds,
  serializeBoard,
  type BoardFileData,
} from './export';
import type { BoardElement } from './protocol';

/**
 * Файл доски `.cord-board` (R154): что уходит в чат и на устройство и что потом открывается снова —
 * у Cord и у любого редактора Excalidraw.
 */

const base = {
  version: 3,
  versionNonce: 7,
  isDeleted: false,
  angle: 0,
  groupIds: [] as string[],
  frameId: null,
};
const rect: BoardElement = {
  ...base,
  id: 'rect',
  type: 'rectangle',
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  index: 'a0',
  groupIds: ['g1'],
  boundElements: [
    { id: 'text', type: 'text' },
    { id: 'arrow', type: 'arrow' },
  ],
};
const text: BoardElement = {
  ...base,
  id: 'text',
  type: 'text',
  x: 50,
  y: 40,
  width: 100,
  height: 20,
  index: 'a1',
  text: 'Привет',
  originalText: 'Привет',
  fontSize: 20,
  fontFamily: 6,
  textAlign: 'center',
  verticalAlign: 'middle',
  containerId: 'rect',
  groupIds: ['g1'],
  lineHeight: 1.25,
};
const arrow: BoardElement = {
  ...base,
  id: 'arrow',
  type: 'arrow',
  x: 300,
  y: 50,
  width: 100,
  height: 0,
  index: 'a2',
  points: [
    [0, 0],
    [-100, 0],
  ],
  startBinding: null,
  endBinding: { elementId: 'rect', focus: 0, gap: 4 },
};
const image: BoardElement = {
  ...base,
  id: 'img',
  type: 'image',
  x: 500,
  y: 0,
  width: 64,
  height: 64,
  index: 'a3',
  fileId: 'f1',
  status: 'saved',
  scale: [1, 1],
};
const gone: BoardElement = { ...base, id: 'gone', type: 'ellipse', isDeleted: true, index: 'a4' };
const ink: BoardElement = {
  ...base,
  id: 'ink',
  type: 'freedraw',
  index: 'a5',
  points: [
    [0, 0],
    [1, 1],
  ],
  customData: { cordInk: true },
};
const files: Record<string, BoardFileData> = {
  f1: { id: 'f1', dataURL: 'data:image/png;base64,iVBORw0KGgo=', mimeType: 'image/png', created: 1 },
  unused: { id: 'unused', dataURL: 'data:image/png;base64,AAAA', mimeType: 'image/png', created: 1 },
};

describe('файл доски', () => {
  it('видимое и картинки внутри, без удалённого и без чужих недорисованных штрихов', () => {
    const doc = JSON.parse(serializeBoard([rect, text, arrow, image, gone, ink], files, '#ffffff'));
    expect(doc).toMatchObject({ type: 'excalidraw', version: 2, source: 'cord' });
    expect(doc.elements.map((el: BoardElement) => el.id)).toEqual(['rect', 'text', 'arrow', 'img']);
    expect(Object.keys(doc.files)).toEqual(['f1']);
    expect(doc.appState.viewBackgroundColor).toBe('#ffffff');
  });

  it('круг: сохранённая доска открывается той же — и Cord, и Excalidraw', async () => {
    const saved = serializeBoard([rect, text, arrow, image], files, '#ffffff');
    const own = parseBoard(saved);
    expect(own.elements.map((el) => el.id)).toEqual(['rect', 'text', 'arrow', 'img']);
    expect(own.files.f1?.dataURL).toBe(files.f1!.dataURL);
    const scene = await loadFromBlob(new Blob([saved], { type: 'application/json' }), null, null);
    expect(scene.elements.map((el) => el.id)).toEqual(['rect', 'text', 'arrow', 'img']);
    const back = new Map(scene.elements.map((el) => [el.id, el]));
    expect(back.get('text')).toMatchObject({ text: 'Привет', containerId: 'rect' });
    expect(back.get('arrow')).toMatchObject({ endBinding: { elementId: 'rect' } });
    expect(back.get('img')).toMatchObject({ fileId: 'f1' });
    expect(scene.files.f1?.dataURL).toBe(files.f1!.dataURL);
  });

  it('не доска — понятный отказ', () => {
    expect(() => parseBoard('не json')).toThrow();
    expect(() => parseBoard('{"type":"other","elements":[]}')).toThrow();
  });

  it('«Добавить на доску» — новые номера, а связи те же', () => {
    let n = 0;
    const out = remapIds([rect, text, arrow], () => `n${++n}`);
    const [r, t, a] = out as [BoardElement, BoardElement, BoardElement];
    expect(new Set(out.map((el) => el.id)).size).toBe(3);
    expect([r.id, t.id, a.id]).not.toContain('rect');
    expect(t.containerId).toBe(r.id);
    expect((r.boundElements as { id: string }[]).map((b) => b.id)).toEqual([t.id, a.id]);
    expect((a.endBinding as { elementId: string }).elementId).toBe(r.id);
    expect(r.groupIds).toEqual(t.groupIds);
    expect(r.groupIds).not.toEqual(['g1']);
    expect(out.every((el) => el.index === null)).toBe(true);
    // Связь с элементом вне вставки рвётся, а не ведёт к чужому.
    const lonely = remapIds([arrow], () => 'x')[0]!;
    expect(lonely.endBinding).toBeNull();
  });

  it('вставка встаёт серединой в середину вида', () => {
    const moved = centerAt([rect, arrow], 1000, 1000);
    const box = bounds(moved);
    expect((box.minX + box.maxX) / 2).toBe(1000);
    expect((box.minY + box.maxY) / 2).toBe(1000);
  });

  it('подпись «Доска · 14:20» и имя файла без двоеточия', () => {
    const stamp = boardStamp(new Date(2026, 9, 31, 14, 5), 'ru-RU');
    expect(stamp.time).toBe('14:05');
    expect(stamp.file).toBe('14-05');
    expect(boardFileKind('Доска 14-05.cord-board')).toBe('board');
    expect(boardFileKind('scene.excalidraw')).toBe('board');
    expect(boardFileKind('Доска.png')).toBe('png');
    expect(boardFileKind('notes.txt')).toBeNull();
  });
});
