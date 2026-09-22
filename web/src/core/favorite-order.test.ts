import { describe, expect, it } from 'vitest';
import type { Favorite } from './favorites';
import { orderedFavorites } from './favorite-order';

const room = (roomId: string) => ({ roomId, title: roomId }) as Favorite;

describe('optimistic ordering of favorites', () => {
  it('uses the submitted order only when it contains the current rooms exactly once', () => {
    const current = [room('a'), room('b'), room('c')];
    expect(orderedFavorites(current, ['c', 'a', 'b']).map((favorite) => favorite.roomId)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  it('keeps the known list when a concurrent remove or stale list changes its membership', () => {
    const current = [room('a'), room('c')];
    expect(orderedFavorites(current, ['c', 'a', 'b'])).toBe(current);
    expect(orderedFavorites(current, ['c', 'c'])).toBe(current);
  });
});
