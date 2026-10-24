import { afterEach, describe, expect, it } from 'vitest';
import { watchTitlebar, type WindowControlsOverlayLike } from './titlebar';

/** Зона кнопок окна, как её отдаёт Chromium: прямоугольник заголовка слева от «— ⧉ ×». */
function overlay(visible: boolean, rect = { x: 0, y: 0, width: 1142, height: 36 }) {
  const listeners = new Set<() => void>();
  const fake: { -readonly [K in keyof WindowControlsOverlayLike]: WindowControlsOverlayLike[K] } & {
    move(next: typeof rect, shown?: boolean): void;
  } = {
    visible,
    getTitlebarAreaRect: () => rect,
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
    move(next, shown = fake.visible) {
      rect = next;
      fake.visible = shown;
      listeners.forEach((listener) => listener());
    },
  };
  return fake;
}

const root = document.documentElement;
afterEach(() => {
  root.style.removeProperty('--titlebar-h');
  root.style.removeProperty('--titlebar-end');
});

describe('кнопки окна Electron (R34)', () => {
  it('видимая зона: высота полосы и ширина кнопок справа — в переменные корня', () => {
    const stop = watchTitlebar(overlay(true), 1280, root);
    expect(root.style.getPropertyValue('--titlebar-h')).toBe('36px');
    expect(root.style.getPropertyValue('--titlebar-end')).toBe('138px');
    stop();
  });

  it('окно поменяло размер или ушло во весь экран — переменные следуют, а снятые не остаются', () => {
    const wco = overlay(true);
    let width = 1280;
    const stop = watchTitlebar(wco, () => width, root);
    width = 1920;
    wco.move({ x: 0, y: 0, width: 1782, height: 36 });
    expect(root.style.getPropertyValue('--titlebar-end')).toBe('138px');
    wco.move({ x: 0, y: 0, width: 0, height: 0 }, false);
    expect(root.style.getPropertyValue('--titlebar-h')).toBe('');
    expect(root.style.getPropertyValue('--titlebar-end')).toBe('');
    stop();
  });

  it('браузер без зоны — ничего не пишет и не подписывается', () => {
    const stop = watchTitlebar(undefined, 1280, root);
    expect(root.style.getPropertyValue('--titlebar-h')).toBe('');
    stop();
  });

  it('отписка убирает и слушателя, и переменные', () => {
    const wco = overlay(true);
    const stop = watchTitlebar(wco, 1280, root);
    stop();
    expect(root.style.getPropertyValue('--titlebar-end')).toBe('');
    wco.move({ x: 0, y: 0, width: 100, height: 36 });
    expect(root.style.getPropertyValue('--titlebar-end')).toBe('');
  });
});
