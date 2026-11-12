import { expect, it } from 'vitest';
import { squarify } from './treemap';

/** Раскладка карты флота (R240): площади по весу, всё внутри рамки, ничего не перекрывается и не теряется. */
const items = (weights: number[]) => weights.map((weight, i) => ({ weight, data: i }));
const area = (r: { w: number; h: number }) => r.w * r.h;

it('площади пропорциональны весам и заполняют рамку целиком', () => {
  const placed = squarify(items([6, 6, 4, 3, 2, 2, 1]), 600, 400);
  expect(placed).toHaveLength(7);
  expect(placed.reduce((sum, r) => sum + area(r), 0)).toBeCloseTo(600 * 400, 3);
  const byData = new Map(placed.map((r) => [r.data, r]));
  expect(area(byData.get(0)!) / area(byData.get(6)!)).toBeCloseTo(6, 3);
  expect(area(byData.get(2)!) / area(byData.get(4)!)).toBeCloseTo(2, 3);
});

it('плитки лежат внутри рамки и не перекрываются', () => {
  const placed = squarify(items([9, 7, 5, 5, 3, 2, 2, 1, 1, 1]), 500, 300);
  for (const r of placed) {
    expect(r.x).toBeGreaterThanOrEqual(-1e-6);
    expect(r.y).toBeGreaterThanOrEqual(-1e-6);
    expect(r.x + r.w).toBeLessThanOrEqual(500 + 1e-6);
    expect(r.y + r.h).toBeLessThanOrEqual(300 + 1e-6);
  }
  for (let i = 0; i < placed.length; i++)
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i]!;
      const b = placed[j]!;
      const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      expect(overlapX > 1e-6 && overlapY > 1e-6).toBe(false);
    }
});

it('плитки близки к квадрату, а не полосы', () => {
  const placed = squarify(items([4, 4, 4, 4, 1, 1, 1, 1]), 800, 400);
  for (const r of placed) expect(Math.max(r.w / r.h, r.h / r.w)).toBeLessThan(4);
});

it('самое тяжёлое — первым, в левом верхнем углу', () => {
  const placed = squarify(items([1, 5, 2]), 300, 300);
  expect(placed[0]!.data).toBe(1);
  expect(placed[0]!.x).toBe(0);
  expect(placed[0]!.y).toBe(0);
});

it('мелкое не исчезает: наименьшая доля площади', () => {
  const honest = squarify(items([1000, 1]), 400, 400);
  const lifted = squarify(items([1000, 1]), 400, 400, 0.05);
  const tiny = (placed: typeof honest) => area(placed.find((r) => r.data === 1)!);
  expect(tiny(honest)).toBeLessThan(400 * 400 * 0.002);
  expect(tiny(lifted) / (400 * 400)).toBeCloseTo(0.05 / 1.049, 2);
  expect(lifted.reduce((sum, r) => sum + area(r), 0)).toBeCloseTo(400 * 400, 3);
});

it('пусто, нулевые веса и нулевая рамка — пустой ответ', () => {
  expect(squarify([], 100, 100)).toEqual([]);
  expect(squarify(items([0, -1]), 100, 100)).toEqual([]);
  expect(squarify(items([1, 2]), 0, 100)).toEqual([]);
  expect(squarify(items([3]), 120, 80)).toEqual([{ x: 0, y: 0, w: 120, h: 80, data: 0 }]);
});
