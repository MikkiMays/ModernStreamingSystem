import { describe, expect, it } from 'vitest';
import { PAIRS, contrast, declarations, layer, resolve, theme } from '../../scripts/check-contrast.mjs';
import tokens from '../styles/tokens.css?raw';
import admin from './admin-tokens.css?raw';

/**
 * Красный слой пульта (R220) поверх токенов продукта: те же пары WCAG 2.2 AA, что сверяет
 * `scripts/check-contrast.mjs` для акцента продукта, — текст акцентом на фонах, подпись на заливке,
 * кольцо и заливка на фонах, — в обеих темах. Тёмная тема записана дважды (ручной выбор и «как в системе»).
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

  it('акцент пульта — красный в обеих темах, синего продукта нет', () => {
    for (const name of ['light', 'dark'] as const) {
      const all = vars(name);
      for (const token of ['--accent', '--accent-fill', '--admin-series']) {
        const [r, g, b] = [1, 3, 5].map((i) => parseInt(value(all, token).slice(i, i + 2), 16));
        expect(r, `${token} (${name})`).toBeGreaterThan(g! * 1.5);
        expect(r, `${token} (${name})`).toBeGreaterThan(b! * 1.5);
      }
    }
  });

  it('контраст WCAG 2.2 AA для всех пар с акцентом — в обеих темах', () => {
    const failed: string[] = [];
    for (const name of ['light', 'dark'] as const) {
      const all = vars(name);
      const pairs = PAIRS[name].filter(([fg, bg]) => `${fg} ${bg}`.includes('accent'));
      expect(pairs.length).toBeGreaterThan(8);
      for (const [fg, bg, min] of [
        ...pairs,
        // Ряды графиков — элементы данных: 3:1 к карточке.
        ['--admin-series', '--surface-1', 3] as [string, string, number],
        ['--admin-line', '--surface-1', 3] as [string, string, number],
      ]) {
        const ratio = contrast(value(all, fg), value(all, bg));
        if (ratio < min) failed.push(`${name} ${fg} на ${bg}: ${ratio.toFixed(2)} < ${min}`);
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
