import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { cacheFavorites, favoriteApi, favoriteProfile, type Favorite } from '../core/favorites';
import {
  collapsedGroups,
  favoriteGroupApi,
  place,
  readRoom,
  sections,
  setGroupCollapsed,
  type FavoriteGroup,
  type SavedRoom,
  type SectionKey,
} from '../core/favorite-groups';
import { useFavorites } from './useFavorites';

const favoritesKey = () => ['favorites', favoriteProfile()] as const;
const groupsKey = () => ['favorite-groups', favoriteProfile()] as const;

/**
 * Избранное боковой панели целиком: комнаты, группы, разделы и действия над ними (T40).
 *
 * Каждое действие сначала меняет то, что на экране, и только потом спрашивает ядро: перенос
 * комнаты в группу или новое имя должны случаться под пальцем, а не через полсекунды. Если ядро
 * отказало, список перечитывается с сервера, и ошибка уходит вызывающему — он скажет о ней словами.
 */
export function useFavoriteShelf() {
  const client = useQueryClient();
  const favorites = useFavorites();
  const groups = useQuery({
    queryKey: groupsKey(),
    queryFn: favoriteGroupApi.list,
    refetchOnWindowFocus: true,
  });
  const [collapsed, setCollapsed] = useState(collapsedGroups);
  const rooms = useMemo(() => (favorites.data ?? []).map(readRoom), [favorites.data]);
  const groupList = useMemo(() => groups.data ?? [], [groups.data]);
  const list = useMemo(() => sections(rooms, groupList), [rooms, groupList]);

  const setRooms = (next: SavedRoom[]) => {
    client.setQueryData<Favorite[]>(favoritesKey(), next);
    cacheFavorites(next);
  };
  const setGroups = (next: FavoriteGroup[]) => client.setQueryData(groupsKey(), next);
  const resync = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: favoritesKey() }),
      client.invalidateQueries({ queryKey: groupsKey() }),
    ]);
  };
  /**
   * Оптимистично, затем ядро; при отказе — перечитать и отдать ошибку наверх. Идущее чтение списка
   * сначала отменяется: иначе его ответ, ушедший до правки, затёр бы её на экране.
   */
  const attempt = async (optimistic: () => void, request: () => Promise<unknown>) => {
    await Promise.all([
      client.cancelQueries({ queryKey: favoritesKey() }),
      client.cancelQueries({ queryKey: groupsKey() }),
    ]);
    optimistic();
    try {
      await request();
    } catch (error) {
      await resync();
      throw error;
    }
  };
  const current = () => (client.getQueryData<Favorite[]>(favoritesKey()) ?? []).map(readRoom);

  const updateRoom = (roomId: string, patch: Partial<Pick<SavedRoom, 'groupId' | 'pinned' | 'alias'>>) => {
    const room = current().find((candidate) => candidate.roomId === roomId);
    if (!room) return Promise.resolve();
    const next = { ...room, ...patch };
    return attempt(
      () => setRooms(current().map((candidate) => (candidate.roomId === roomId ? next : candidate))),
      () =>
        favoriteGroupApi.settings(roomId, { groupId: next.groupId, pinned: next.pinned, alias: next.alias }),
    );
  };

  return {
    rooms,
    groups: groupList,
    sections: list,
    favorites,
    groupsQuery: groups,
    collapsed,
    toggleCollapsed(id: string) {
      setCollapsed(setGroupCollapsed(id, !collapsed.has(id)));
    },
    async createGroup(title: string, moveRoomId?: string) {
      const group = { id: crypto.randomUUID(), title };
      await attempt(
        () => setGroups([...(client.getQueryData<FavoriteGroup[]>(groupsKey()) ?? []), group]),
        () => favoriteGroupApi.save(group),
      );
      // «Новая группа…» из меню комнаты кладёт её в группу и закрепления не снимает (R86).
      if (moveRoomId) await updateRoom(moveRoomId, { groupId: group.id });
      return group;
    },
    renameGroup(id: string, title: string) {
      return attempt(
        () =>
          setGroups(
            (client.getQueryData<FavoriteGroup[]>(groupsKey()) ?? []).map((group) =>
              group.id === id ? { ...group, title } : group,
            ),
          ),
        () => favoriteGroupApi.save({ id, title }),
      );
    },
    removeGroup(id: string) {
      return attempt(
        () => {
          setGroups(
            (client.getQueryData<FavoriteGroup[]>(groupsKey()) ?? []).filter((group) => group.id !== id),
          );
          setRooms(current().map((room) => (room.groupId === id ? { ...room, groupId: null } : room)));
        },
        () => favoriteGroupApi.remove(id),
      );
    },
    updateRoom,
    /** Положить комнату в раздел перед его `index`-й комнатой: принадлежность и общий порядок. */
    async placeRoom(roomId: string, target: SectionKey, index: number) {
      const before = current();
      const placement = place(before, groupList, roomId, target, index);
      if (!placement) return;
      const room = before.find((candidate) => candidate.roomId === roomId)!;
      const moved = room.groupId !== placement.groupId || room.pinned !== placement.pinned;
      const reordered = placement.order.some((id, i) => before[i]?.roomId !== id);
      if (!moved && !reordered) return;
      const byId = new Map(before.map((candidate) => [candidate.roomId, candidate]));
      await attempt(
        () =>
          setRooms(
            placement.order.map((id) =>
              id === roomId
                ? { ...room, groupId: placement.groupId, pinned: placement.pinned }
                : byId.get(id)!,
            ),
          ),
        async () => {
          if (moved)
            await favoriteGroupApi.settings(roomId, {
              groupId: placement.groupId,
              pinned: placement.pinned,
              alias: room.alias,
            });
          if (reordered) await favoriteApi.reorder(placement.order);
        },
      );
    },
    async removeRoom(roomId: string) {
      await attempt(
        () => setRooms(current().filter((room) => room.roomId !== roomId)),
        () => favoriteApi.remove(roomId),
      );
    },
  };
}
export type FavoriteShelf = ReturnType<typeof useFavoriteShelf>;
