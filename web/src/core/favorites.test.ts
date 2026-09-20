import { beforeEach, expect, it } from 'vitest';
import { autoJoinEnabled, cacheFavorites, cachedFavorites, favoriteProfile, setAutoJoin } from './favorites';
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

it('forgets auto-join for meetings the server no longer has', () => {
  setAutoJoin('a', true);
  setAutoJoin('b', true);
  // Комнату `b` удалил сервер по сроку хранения: её нет в присланном списке, и войти в неё
  // больше нельзя — значит и автовходу в неё храниться не за чем.
  cacheFavorites([room('a')]);
  expect(autoJoinEnabled('a')).toBe(true);
  expect(autoJoinEnabled('b')).toBe(false);
  expect(JSON.parse(localStorage.getItem('cord:autojoin:v1')!)).toEqual(['a']);
});

it('leaves auto-join alone when the list is empty or unreadable', () => {
  cacheFavorites([]);
  expect(localStorage.getItem('cord:autojoin:v1')).toBeNull();
  localStorage.setItem('cord:autojoin:v1', '{ broken');
  cacheFavorites([room('a')]);
  expect(localStorage.getItem('cord:autojoin:v1')).toBe('{ broken');
});
