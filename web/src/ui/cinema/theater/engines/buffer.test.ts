import { describe, expect, it } from 'vitest';
import { AHEAD_MAX, AHEAD_MIN, aheadFor, BEHIND } from './buffer';

describe('буфер «как у YouTube» (R172)', () => {
  it('вперёд — 20 с впритык и пока полосы не знаем, 30 с с запасом, между — по прямой', () => {
    expect([AHEAD_MIN, AHEAD_MAX, BEHIND]).toEqual([20, 30, 30]);
    expect(aheadFor(undefined, 2_000_000)).toBe(20);
    expect(aheadFor(5_000_000, 0)).toBe(20);
    expect(aheadFor(Number.NaN, 2_000_000)).toBe(20);
    expect(aheadFor(2_000_000, 2_000_000)).toBe(20);
    expect(aheadFor(3_000_000, 2_000_000)).toBe(20);
    expect(aheadFor(4_500_000, 2_000_000)).toBe(25);
    expect(aheadFor(6_000_000, 2_000_000)).toBe(30);
    expect(aheadFor(100_000_000, 2_000_000)).toBe(30);
  });

  it('никогда не больше полуминуты вперёд — ни при какой полосе', () => {
    for (const bandwidth of [1e5, 1e6, 1e7, 1e8, 1e9])
      for (const bitrate of [2e5, 1e6, 5e6, 2e7]) {
        const ahead = aheadFor(bandwidth, bitrate);
        expect(ahead).toBeGreaterThanOrEqual(AHEAD_MIN);
        expect(ahead).toBeLessThanOrEqual(AHEAD_MAX);
      }
  });
});
