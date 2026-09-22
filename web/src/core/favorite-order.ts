import type { Favorite } from './favorites';

/** Only an exact, duplicate-free snapshot may be reordered optimistically. */
export function orderedFavorites(current: Favorite[], roomIds: string[]) {
  if (current.length !== roomIds.length) return current;
  const byId = new Map(current.map((favorite) => [favorite.roomId, favorite]));
  if (new Set(roomIds).size !== roomIds.length || roomIds.some((roomId) => !byId.has(roomId))) return current;
  return roomIds.map((roomId) => byId.get(roomId)!);
}
