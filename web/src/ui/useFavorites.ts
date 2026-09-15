import { useQuery } from '@tanstack/react-query';
import { cacheFavorites, cachedFavorites, favoriteApi, favoriteProfile } from '../core/favorites';

/**
 * The rooms saved on this server. The last known list is shown immediately and replaced by the
 * server's answer as soon as it arrives — `initialDataUpdatedAt: 0` marks the cache as already
 * stale, so it is a starting picture rather than something that delays the real one.
 */
export function useFavorites() {
  return useQuery({
    queryKey: ['favorites', favoriteProfile()],
    queryFn: async () => {
      const rooms = await favoriteApi.list();
      cacheFavorites(rooms);
      return rooms;
    },
    initialData: cachedFavorites,
    initialDataUpdatedAt: 0,
    refetchOnWindowFocus: true,
  });
}
