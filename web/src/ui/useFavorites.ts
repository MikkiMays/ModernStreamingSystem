import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  cacheFavorites,
  cachedFavorites,
  favoriteApi,
  favoriteProfile,
  type Favorite,
} from '../core/favorites';
import { orderedFavorites } from '../core/favorite-order';

const favoritesKey = () => ['favorites', favoriteProfile()] as const;

/**
 * The rooms saved on this server. The last known list is shown immediately and replaced by the
 * server's answer as soon as it arrives — `initialDataUpdatedAt: 0` marks the cache as already
 * stale, so it is a starting picture rather than something that delays the real one.
 */
export function useFavorites() {
  return useQuery({
    queryKey: favoritesKey(),
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

export function useReorderFavorites() {
  const client = useQueryClient();
  const key = favoritesKey();
  return useMutation({
    mutationFn: favoriteApi.reorder,
    onMutate: async (roomIds) => {
      await client.cancelQueries({ queryKey: key });
      const previous = client.getQueryData<Favorite[]>(key);
      if (previous) {
        const next = orderedFavorites(previous, roomIds);
        client.setQueryData(key, next);
        cacheFavorites(next);
      }
      return { previous };
    },
    onError: (_error, _roomIds, context) => {
      if (context?.previous) {
        const current = client.getQueryData<Favorite[]>(key);
        // A removal may have completed while the order request was in flight. Restore only
        // when the membership is unchanged; otherwise the next server list is authoritative.
        const restored = orderedFavorites(
          current ?? context.previous,
          context.previous.map((room) => room.roomId),
        );
        if (!current || restored !== current) {
          client.setQueryData(key, restored);
          cacheFavorites(restored);
        }
      }
    },
    onSettled: () => client.invalidateQueries({ queryKey: key }),
  });
}
