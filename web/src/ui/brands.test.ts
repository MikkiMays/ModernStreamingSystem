import { describe, expect, it } from 'vitest';
import { contrast, resolve, theme } from '../../scripts/check-contrast.mjs';
import tokens from '../styles/tokens.css?raw';
import { BRAND_IDS, BRANDS, paint } from './brands';

/*
  Цвета интеграций (R33): реестр `brands.ts` и переменные `tokens.css` — одно и то же, и каждый цвет
  читается там, где его рисуют: знак на плашке — 3:1, текст бренда на поверхности обеих тем — 4,5:1.
*/
const light = theme(tokens, 'light');
const dark = theme(tokens, 'dark');
const color = (vars: Record<string, string>, name: string) => resolve(vars, vars[name] ?? name).toLowerCase();

describe('реестр брендов', () => {
  it('у каждой записи tokens.css — та же заливка, тот же знак и тот же текст в обеих темах', () => {
    expect(BRAND_IDS.length).toBeGreaterThanOrEqual(16);
    for (const id of BRAND_IDS) {
      const brand = BRANDS[id];
      expect(color(light, `--brand-${id}`), id).toBe(brand.color);
      expect(color(dark, `--brand-${id}`), id).toBe(brand.color);
      expect(color(light, `--brand-${id}-ink`), id).toBe(brand.ink);
      expect(color(light, `--brand-${id}-text`), id).toBe(brand.text.light);
      expect(color(dark, `--brand-${id}-text`), id).toBe(brand.text.dark);
    }
  });

  it('знак на плашке бренда — не меньше 3:1', () => {
    for (const id of BRAND_IDS)
      expect(contrast(BRANDS[id].ink, BRANDS[id].color), id).toBeGreaterThanOrEqual(3);
  });

  it('текст цветом бренда на --surface-1 — AA в обеих темах', () => {
    for (const id of BRAND_IDS) {
      expect(
        contrast(BRANDS[id].text.light, color(light, '--surface-1')),
        `${id} light`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(contrast(BRANDS[id].text.dark, color(dark, '--surface-1')), `${id} dark`).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });

  it('paint даёт CSS три переменные бренда', () => {
    expect(paint('yandex')).toEqual({
      '--platform': 'var(--brand-yandex)',
      '--platform-ink': 'var(--brand-yandex-ink)',
      '--platform-text': 'var(--brand-yandex-text)',
    });
  });
});
