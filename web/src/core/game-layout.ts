export interface GameSeatSpot {
  index: number;
  x: number;
  y: number;
  side: 'bottom' | 'top' | 'left' | 'right';
  slot: number;
}

/** Equal physical arc intervals on the displayed ellipse; logical seat IDs never change. */
export function occupiedSeatLayout(
  occupied: readonly number[],
  mySeat: number | null,
  width = 2,
): GameSeatSpot[] {
  const ids = [...new Set(occupied)].sort((a, b) => a - b);
  if (!ids.length) return [];
  const anchor = Math.max(0, ids.indexOf(mySeat ?? ids[0]!));
  const ordered = [...ids.slice(anchor), ...ids.slice(0, anchor)];
  const segments = 2048;
  const points = Array.from({ length: segments + 1 }, (_, i) => {
    const angle = Math.PI / 2 + (i / segments) * Math.PI * 2;
    return { x: 50 + 42 * Math.cos(angle), y: 50 + 39 * Math.sin(angle), angle };
  });
  const lengths = [0];
  for (let i = 1; i <= segments; i++) {
    lengths.push(
      lengths[i - 1]! +
        Math.hypot((points[i]!.x - points[i - 1]!.x) * width, points[i]!.y - points[i - 1]!.y),
    );
  }
  return ordered.map((index, slot) => {
    const target = (lengths[segments]! * slot) / ordered.length;
    let low = 0,
      high = segments;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (lengths[mid]! < target) low = mid + 1;
      else high = mid;
    }
    const p = points[low]!;
    return {
      index,
      x: p.x,
      y: p.y,
      slot,
      side:
        Math.sin(p.angle) > 0.5
          ? 'bottom'
          : Math.sin(p.angle) < -0.5
            ? 'top'
            : Math.cos(p.angle) > 0
              ? 'right'
              : 'left',
    };
  });
}
