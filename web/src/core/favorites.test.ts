import { beforeEach, expect, it } from 'vitest';
import { cacheFavorites, cachedFavorites, favoriteProfile } from './favorites';
import type { Favorite } from './favorites';

const room = (roomId: string): Favorite => ({
  roomId,
  title: 'Наш вечер',
  code: '123456789',
  savedAt: 1,
  closed: false,
  canJoin: true,
});

beforeEach(() => localStorage.clear());

it('keeps the last list this server gave us so the home has something to show', () => {
  expect(cachedFavorites()).toBeUndefined();
  cacheFavorites([room('a'), room('b')]);
  expect(cachedFavorites()?.map((r) => r.roomId)).toEqual(['a', 'b']);
});

it('never shows one profile the favourites of another', () => {
  cacheFavorites([room('a')]);
  const stored = JSON.parse(localStorage.getItem('cord:favorites:v1')!) as { profile: string };
  expect(stored.profile).toBe(favoriteProfile());
  localStorage.setItem('cord:favorites:v1', JSON.stringify({ profile: 'somebody-else', rooms: [room('a')] }));
  expect(cachedFavorites()).toBeUndefined();
});

it('ignores a cache a previous version or a broken write left behind', () => {
  localStorage.setItem(
    'cord:favorites:v1',
    JSON.stringify({ profile: favoriteProfile(), rooms: [room('a'), { roomId: 5 }, null] }),
  );
  expect(cachedFavorites()?.map((r) => r.roomId)).toEqual(['a']);
  localStorage.setItem('cord:favorites:v1', '{ broken');
  expect(cachedFavorites()).toBeUndefined();
});
