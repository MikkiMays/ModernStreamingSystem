import { request } from '../api/client';
import type { Admission } from '../api/types';
import type { components } from '../api/generated';
import { notifyDesktop } from './desktop';

export type Favorite = components['schemas']['Favorite'];
let volatileProfile: string | undefined;
export function favoriteProfile(): string {
  const key = 'cord:profile:v1';
  try {
    const saved = localStorage.getItem(key);
    if (saved && /^[A-Za-z0-9_-]{43}$/.test(saved)) return saved;
  } catch {
    /* Private browsing can disable storage. */
  }
  volatileProfile ??= btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
  try {
    localStorage.setItem(key, volatileProfile);
  } catch {
    /* Session-only identity. */
  }
  return volatileProfile;
}
export const favoriteApi = {
  list: () => request<Favorite[]>('/favorites', {}, favoriteProfile()),
  async save(admission: Admission) {
    await request(
      `/favorites/${admission.roomId}`,
      { method: 'PUT', body: JSON.stringify({ roomCredential: admission.credential }) },
      favoriteProfile(),
    );
    notifyDesktop('favorites.changed');
  },
  async remove(roomId: string) {
    await request(`/favorites/${roomId}`, { method: 'DELETE' }, favoriteProfile());
    setAutoJoin(roomId, false);
    notifyDesktop('favorites.changed');
  },
  join: (roomId: string, name: string, commandId: string) =>
    request<Admission>(
      `/favorites/${roomId}/join`,
      { method: 'POST', body: JSON.stringify({ name, commandId }) },
      favoriteProfile(),
    ),
};

/**
 * The last list this server gave us, kept so the home has something to show while it asks
 * again. Storage is per origin, so this is already per server: one server's rooms can never
 * appear under another. The profile is recorded with it because a new profile means a
 * different set of favourites, and showing the old one would be showing someone else's.
 */
const FAVORITES_KEY = 'cord:favorites:v1';
export function cachedFavorites(): Favorite[] | undefined {
  try {
    const saved = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? 'null') as {
      profile?: string;
      rooms?: unknown;
    } | null;
    if (saved?.profile !== favoriteProfile() || !Array.isArray(saved.rooms)) return undefined;
    const rooms = saved.rooms.filter(
      (room): room is Favorite =>
        !!room &&
        typeof (room as Favorite).roomId === 'string' &&
        typeof (room as Favorite).title === 'string',
    );
    return rooms.length ? rooms : undefined;
  } catch {
    return undefined;
  }
}
export function cacheFavorites(rooms: Favorite[]) {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify({ profile: favoriteProfile(), rooms }));
    forgetAutoJoinForMissingRooms(rooms);
  } catch {
    /* The list is still correct in memory for this visit. */
  }
}

/**
 * Забыть автовход в комнаты, которых больше нет.
 *
 * Список автовхода пополнялся сам и очищался только руками: `remove` вычёркивает комнату,
 * когда её убирают из избранного, — а встреча, которую сервер удалил по сроку хранения,
 * никем не убирается и остаётся в `localStorage` навсегда. Сами по себе тридцать шесть байт
 * ничего не весят; плохо то, что список растёт от простого пользования и не уменьшается
 * никогда. Ответ уже есть в руках: сервер только что прислал полный список избранного, и
 * всё, чего в нём нет, — это комнаты, в которые войти больше нельзя.
 */
function forgetAutoJoinForMissingRooms(rooms: Favorite[]) {
  const saved: unknown = JSON.parse(localStorage.getItem('cord:autojoin:v1') ?? '[]');
  if (!Array.isArray(saved) || saved.length === 0) return;
  const live = new Set(rooms.map((room) => room.roomId));
  const kept = saved.filter((id): id is string => typeof id === 'string' && live.has(id));
  if (kept.length !== saved.length) localStorage.setItem('cord:autojoin:v1', JSON.stringify(kept));
}

export function autoJoinEnabled(roomId: string): boolean {
  try {
    const rooms: unknown = JSON.parse(localStorage.getItem('cord:autojoin:v1') ?? '[]');
    return Array.isArray(rooms) && rooms.includes(roomId);
  } catch {
    return false;
  }
}
export function setAutoJoin(roomId: string, enabled: boolean) {
  let rooms: string[] = [];
  try {
    const saved: unknown = JSON.parse(localStorage.getItem('cord:autojoin:v1') ?? '[]');
    if (Array.isArray(saved))
      rooms = saved.filter((id): id is string => typeof id === 'string' && id !== roomId);
  } catch {
    /* Use a fresh list when preferences are corrupt. */
  }
  if (enabled) rooms.push(roomId);
  localStorage.setItem('cord:autojoin:v1', JSON.stringify(rooms));
}
