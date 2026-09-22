import { describe, expect, it } from 'vitest';
import { occupiedSeatLayout } from './game-layout';

describe('occupied ellipse layout', () => {
  for (const count of [2, 3, 4, 5, 6, 10])
    for (const ratio of [0.8, 1.6, 2.5]) {
      it(`uses equal arc distances for ${count} seats at ratio ${ratio}`, () => {
        const ids = Array.from({ length: count }, (_, i) => i * 2 + 1);
        const spots = occupiedSeatLayout(ids, ids[1]!, ratio);
        expect(spots.map((spot) => spot.index).sort((a, b) => a - b)).toEqual(ids);
        expect(spots[0]).toMatchObject({ index: ids[1], slot: 0, x: 50, y: 89 });
        const angle = (p: { x: number; y: number }) => {
          const raw = Math.atan2((p.y - 50) / 39, (p.x - 50) / 42) - Math.PI / 2;
          return (raw + Math.PI * 2) % (Math.PI * 2);
        };
        const arcs = spots.map((spot, index) => {
          const start = angle(spot),
            end = index === count - 1 ? Math.PI * 2 : angle(spots[index + 1]!);
          let length = 0;
          for (let n = 0; n < 1000; n++) {
            const t = start + ((end - start) * (n + 0.5)) / 1000 + Math.PI / 2;
            length += (Math.hypot(42 * ratio * Math.sin(t), 39 * Math.cos(t)) * (end - start)) / 1000;
          }
          return length;
        });
        expect(Math.max(...arcs) / Math.min(...arcs)).toBeLessThan(1.015);
      });
    }
  it('handles empty seats and a spectator deterministically', () => {
    expect(occupiedSeatLayout([], null)).toEqual([]);
    expect(occupiedSeatLayout([9, 1, 4, 4], null).map((s) => s.index)).toEqual([1, 4, 9]);
  });
});
