import { describe, expect, it } from 'vitest';
import { installDevicePixel } from './device-pixel';

/** Окно с масштабом экрана, которое умеет «переехать» на другой монитор. */
function screen(ratio: number) {
  const listeners = new Set<() => void>();
  const queries: string[] = [];
  const target = {
    devicePixelRatio: ratio,
    matchMedia(query: string) {
      queries.push(query);
      return {
        addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
      };
    },
    move(next: number) {
      target.devicePixelRatio = next;
      [...listeners].forEach((listener) => listener());
    },
    listeners,
    queries,
  };
  return target;
}

describe('физический пиксель в CSS-пикселях (R123)', () => {
  it('125 % — 0.8 px, 150 % — 2/3 px', () => {
    const root = document.createElement('div');
    const stop = installDevicePixel(screen(1.25) as unknown as Window, root);
    expect(root.style.getPropertyValue('--device-px')).toBe('0.8px');
    stop();
    installDevicePixel(screen(1.5) as unknown as Window, root);
    expect(parseFloat(root.style.getPropertyValue('--device-px'))).toBeCloseTo(2 / 3, 5);
  });

  it('окно переехало на монитор с другим масштабом — переменная следует, слушатель один', () => {
    const root = document.createElement('div');
    const win = screen(1);
    const stop = installDevicePixel(win as unknown as Window, root);
    expect(root.style.getPropertyValue('--device-px')).toBe('1px');
    win.move(1.25);
    expect(root.style.getPropertyValue('--device-px')).toBe('0.8px');
    expect(win.queries.at(-1)).toBe('(resolution: 1.25dppx)');
    expect(win.listeners.size).toBe(1);
    stop();
    expect(win.listeners.size).toBe(0);
    expect(root.style.getPropertyValue('--device-px')).toBe('');
  });
});
