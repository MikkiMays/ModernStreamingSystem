import { describe, expect, it } from 'vitest';
import { contrast, declarations, layer, resolve, theme } from '../../scripts/check-contrast.mjs';
import tokens from '../styles/tokens.css?raw';
import admin from './admin-tokens.css?raw';

/**
 * Смысловые токены пульта (R240, Р-147) поверх токенов продукта: ряды графиков, состояния и шкала карты флота
 * различимы на фоне панели в обеих темах; красный — только знак пульта. Тёмная тема записана дважды (ручной выбор
 * и «как в системе») — блоки должны совпадать.
 */
const LIGHT = ":root[data-app='admin'],\n[data-app='admin'] [data-theme='light']";
const DARK = ":root[data-app='admin'][data-theme='dark'],\n[data-app='admin'] [data-theme='dark']";
const SYSTEM = ":root[data-app='admin']:not([data-theme='light'])";

function vars(name: 'light' | 'dark') {
  const layerVars = declarations(admin, (s) => s === (name === 'light' ? LIGHT : DARK));
  return { ...theme(tokens, name), ...layerVars };
}

function value(all: Record<string, string>, name: string): string {
  const [top, base] = name.split(' over ');
  const color = (n: string) => resolve(all, all[n] ?? n);
  return base ? layer(color(top!), color(base)) : color(top!);
}

describe('admin-tokens.css', () => {
  it('тёмный блок «как в системе» совпадает с ручным', () => {
    const manual = declarations(admin, (s) => s === DARK);
    expect(Object.keys(manual).length).toBeGreaterThan(8);
    expect(declarations(admin, (s) => s === SYSTEM)).toEqual(manual);
  });

  it('красный — только знак пульта: ряды графиков синие, метка раздела рельса — красная (Р-147)', () => {
    const channels = (color: string) =>
      [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16)) as [number, number, number];
    for (const name of ['light', 'dark'] as const) {
      const all = vars(name);
      for (const token of ['--admin-series', '--admin-line', '--admin-heat']) {
        const [r, , b] = channels(value(all, token));
        expect(b, `${token} (${name})`).toBeGreaterThan(r * 1.5);
      }
    }
    const rail = declarations(admin, (s) => s === ":root[data-app='admin']");
    const [r, g, b] = channels(rail['--rail-mark']!);
    expect(r).toBeGreaterThan(g * 1.5);
    expect(r).toBeGreaterThan(b * 1.5);
  });

  it('ряды, состояния и ступени карты различимы на фоне панели — в обеих темах', () => {
    const failed: string[] = [];
    const rail = declarations(admin, (s) => s === ":root[data-app='admin']");
    for (const name of ['light', 'dark'] as const) {
      const all = { ...vars(name), ...rail };
      for (const token of [
        '--admin-series',
        '--admin-line',
        '--admin-compare',
        '--state-ok',
        '--state-warn',
        '--state-bad',
        '--state-off',
        '--map-load-1',
        '--map-load-2',
        '--map-load-3',
        '--map-load-4',
        '--map-load-5',
      ]) {
        const ratio = contrast(value(all, token), value(all, '--surface-1'));
        // Элементы данных и значки состояния — 3:1 к панели (WCAG 2.2, 1.4.11).
        if (ratio < 3) failed.push(`${name} ${token}: ${ratio.toFixed(2)} < 3`);
      }
    }
    expect(failed).toEqual([]);
  });

  it('рельс: подписи и метка выбранного раздела читаются на графите', () => {
    const rail = declarations(admin, (s) => s === ":root[data-app='admin']");
    expect(contrast(rail['--rail-text']!, rail['--rail-bg']!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(rail['--rail-muted']!, rail['--rail-bg']!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(rail['--rail-mark']!, rail['--rail-bg']!)).toBeGreaterThanOrEqual(3);
  });
});
