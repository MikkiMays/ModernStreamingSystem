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
    notifyDesktop('favorites.changed');
  },
  join: (roomId: string, name: string, commandId: string) =>
    request<Admission>(
      `/favorites/${roomId}/join`,
      { method: 'POST', body: JSON.stringify({ name, commandId }) },
      favoriteProfile(),
    ),
};
