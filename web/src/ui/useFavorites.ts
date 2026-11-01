import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Admission } from '../api/types';
import {
  cacheFavorites,
  cachedFavorites,
  favoriteApi,
  favoriteProfile,
  type Favorite,
} from '../core/favorites';
import { orderedFavorites } from '../core/favorite-order';
import { favoritesLimit } from '../core/favorite-groups';
import { serverInfo } from '../core/session';

const favoritesKey = () => ['favorites', favoriteProfile()] as const;

/** Список с сервера — и он же в кэше устройства: с него начнёт следующий показ главной. */
async function loadFavorites() {
  const rooms = await favoriteApi.list();
  cacheFavorites(rooms);
  return rooms;
}

/**
 * The rooms saved on this server. The last known list is shown immediately and replaced by the
 * server's answer as soon as it arrives — `initialDataUpdatedAt: 0` marks the cache as already
 * stale, so it is a starting picture rather than something that delays the real one.
 */
export function useFavorites() {
  return useQuery({
    queryKey: favoritesKey(),
    queryFn: loadFavorites,
    initialData: cachedFavorites,
    initialDataUpdatedAt: 0,
    refetchOnWindowFocus: true,
  });
}

/**
 * Сохранить встречу в избранное или убрать её оттуда — и сразу перечитать список (R162).
 *
 * Избранное показывают сразу несколько мест: боковая панель главной, звезда в шапке встречи, меню
 * недавней встречи. Все они читают один запрос `['favorites', профиль]`, и кто меняет избранное, тот
 * его и обновляет — здесь, а не каждый у себя: «В избранное» у недавней встречи сохраняло комнату и
 * говорило «Встреча в избранном», а панель рядом ждала перезагрузки страницы (общий `staleTime` — 30 с,
 * а фокус окна при щелчке внутри страницы не меняется).
 *
 * Перечитывается и тогда, когда список сейчас никто не показывает: ответ ложится и в кэш устройства
 * (`cord:favorites:v1`), с которого начинает главная после выхода из встречи.
 */
export function useFavoriteMembership() {
  const client = useQueryClient();
  const refresh = async () => {
    const key = favoritesKey();
    // Чтение, ушедшее до правки, принесло бы список без неё — его отменяем и спрашиваем заново.
    await client.cancelQueries({ queryKey: key });
    try {
      await client.fetchQuery({ queryKey: key, queryFn: loadFavorites, staleTime: 0 });
    } catch {
      // Правка на сервере уже есть, не прочиталось только подтверждение: первый же показ спросит снова.
      await client.invalidateQueries({ queryKey: key });
    }
  };
  return {
    async save(admission: Pick<Admission, 'roomId' | 'credential'>) {
      await favoriteApi.save(admission as Admission);
      await refresh();
    },
    async remove(roomId: string) {
      await favoriteApi.remove(roomId);
      await refresh();
    },
  };
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

/** Сколько комнат помещается в избранное на этом сервере (П3): `capabilities.favoritesMax` или 10. */
export function useFavoritesLimit() {
  const capabilities = useQuery({ queryKey: ['capabilities'], queryFn: serverInfo, retry: 1 });
  return favoritesLimit(capabilities.data);
}
