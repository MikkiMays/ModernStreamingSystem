// Холст jsdom — раньше Excalidraw (`test/canvas-stub.ts`).
import '../../test/canvas-stub';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { Cursor } from '../../core/board/sync';
import { CursorLayer, type BoardPerson } from './cursors';
import { ExcalidrawCanvas } from './excalidraw-canvas';

/**
 * Курсоры соседей (R168): только стрелка цвета участника — свой слой поверх холста; Excalidraw о соседях
 * знает (значки, лазер), но курсор, имя и чужое выделение не рисует и не будится на каждый кадр.
 */
const PEOPLE = new Map<string, BoardPerson>([
  ['boris', { name: 'Борис', color: '#e8590c' }],
  ['vera', { name: 'Вера', color: '#2b9459' }],
]);
const VIEW = { scrollX: 0, scrollY: 0, zoom: 1, width: 800, height: 600 };

function cursor(x: number, y: number, tool: Cursor['tool'] = 'pointer'): Cursor {
  return { x, y, tool, button: 'up' };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('слой курсоров соседей', () => {
  it('стрелка цвета участника там, где он, — без подписи и без обводки другим цветом', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const layer = new CursorLayer(root, () => PEOPLE);
    layer.move(VIEW);
    layer.set(new Map([['boris', cursor(100, 50)]]));
    layer.paint();
    const marks = root.querySelectorAll<SVGSVGElement>('svg.board-cursor');
    expect(marks).toHaveLength(1);
    expect(marks[0]!.style.transform).toBe('translate(98px, 48px)');
    const path = marks[0]!.querySelector('path')!;
    expect(path.getAttribute('fill')).toBe('#e8590c');
    expect(path.getAttribute('stroke')).toBe('#e8590c');
    expect(root.textContent).toBe('');
  });

  it('прокрутка и масштаб двигают стрелку; ушедшая за край и чужой без имени — не видны', () => {
    const root = document.createElement('div');
    const layer = new CursorLayer(root, () => PEOPLE);
    layer.move({ ...VIEW, scrollX: -50, zoom: 2 });
    layer.set(
      new Map([
        ['boris', cursor(100, 50)],
        ['vera', cursor(5000, 50)],
        ['ghost', cursor(10, 10)],
      ]),
    );
    layer.paint();
    const marks = root.querySelectorAll<SVGSVGElement>('svg.board-cursor');
    expect([...marks].map((mark) => mark.dataset.peer)).toEqual(['boris']);
    expect(marks[0]!.style.transform).toBe('translate(98px, 98px)');
    layer.set(new Map());
    layer.paint();
    expect(root.querySelectorAll('svg.board-cursor')).toHaveLength(0);
    // Сосед ещё не водил мышью над доской: его вид пришёл с точкой (0, 0) — курсора нет.
    layer.move(VIEW);
    layer.set(new Map([['boris', cursor(0, 0)]]));
    layer.paint();
    expect(root.querySelectorAll('svg.board-cursor')).toHaveLength(0);
    layer.dispose();
  });
});

describe('соседи у Excalidraw', () => {
  function fakeApi() {
    const updateScene = vi.fn();
    const api = {
      updateScene,
      getAppState: () => ({ userToFollow: null }),
    } as unknown as ExcalidrawImperativeAPI;
    return { api, updateScene };
  }

  it('без курсора, имени на холсте и чужого выделения; лазер — цветом участника', () => {
    const { api, updateScene } = fakeApi();
    const canvas = new ExcalidrawCanvas(api, () => PEOPLE);
    canvas.cursors(new Map([['boris', cursor(1, 2, 'laser')]]));
    const { collaborators } = updateScene.mock.calls[0]![0] as {
      collaborators: Map<string, Record<string, unknown>>;
    };
    const boris = collaborators.get('boris')!;
    expect(boris.pointer).toEqual({ x: 1, y: 2, tool: 'laser', renderCursor: false, laserColor: '#e8590c' });
    expect(boris.selectedElementIds).toBeUndefined();
    expect(boris.username).toBe('Борис');
  });

  it('будится, только когда сменился состав соседей или светит лазер', () => {
    const { api, updateScene } = fakeApi();
    const root = document.createElement('div');
    const layer = new CursorLayer(root, () => PEOPLE);
    const set = vi.spyOn(layer, 'set');
    const canvas = new ExcalidrawCanvas(api, () => PEOPLE, layer);
    canvas.cursors(new Map([['boris', cursor(1, 1)]]));
    canvas.cursors(new Map([['boris', cursor(2, 2)]]));
    canvas.cursors(new Map([['boris', cursor(3, 3)]]));
    expect(updateScene).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledTimes(3);
    canvas.cursors(
      new Map([
        ['boris', cursor(3, 3)],
        ['vera', cursor(0, 0)],
      ]),
    );
    expect(updateScene).toHaveBeenCalledTimes(2);
    canvas.cursors(new Map([['boris', cursor(4, 4, 'laser')]]));
    canvas.cursors(new Map([['boris', cursor(5, 5, 'laser')]]));
    // Лазер погас — ещё один кадр, чтобы след закончился.
    canvas.cursors(new Map([['boris', cursor(6, 6)]]));
    canvas.cursors(new Map([['boris', cursor(7, 7)]]));
    expect(updateScene).toHaveBeenCalledTimes(5);
    layer.dispose();
  });
});
