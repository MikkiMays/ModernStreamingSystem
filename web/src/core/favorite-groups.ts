import { request } from '../api/client';
import { favoriteProfile, type Favorite } from './favorites';
import { notifyDesktop } from './desktop';
import { t } from '../i18n';

/**
 * Группы избранного и то, как комнаты в них лежат (T40, П3).
 *
 * Группы, закрепление и своё имя комнаты хранит ядро рядом с избранным — на профиле устройства,
 * как и само избранное (`/favorites/groups`, `/favorites/{id}/settings`, миграция V8). Учётных
 * записей нет, поэтому и синхронизации между устройствами нет: это список этого устройства на
 * этом сервере. Свёрнута ли группа — дело одного экрана, и это помнит `localStorage`.
 *
 * Новые поля ответа читаются защитно, как `media/capabilities.ts`: ядро без V8 их не присылает, и
 * тогда все комнаты просто лежат одним списком, как раньше.
 */
export interface FavoriteGroup {
  id: string;
  title: string;
}
export type SavedRoom = Favorite & {
  /** Группа, в которой лежит комната; `null` — общий список. */
  groupId: string | null;
  /** Закреплённые стоят первыми, над группами. */
  pinned: boolean;
  /** Своё имя комнаты — видно только на этом устройстве. */
  alias: string | null;
};

/** Сколько комнат помещается в избранное, если сервер не сказал иначе (П3). */
export const FAVORITES_MAX = 10;
/** Сколько групп можно завести (ядро отказывает в одиннадцатой). */
export const GROUPS_MAX = 10;
export const TITLE_MAX = 60;

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);

export function readRoom(raw: Favorite): SavedRoom {
  const extra = raw as Favorite & { groupId?: unknown; pinned?: unknown; alias?: unknown };
  return {
    ...raw,
    groupId: text(extra.groupId),
    pinned: extra.pinned === true,
    alias: text(extra.alias),
  };
}

/** Как комната называется в списке: своё имя, если оно есть. */
export function roomName(room: Pick<SavedRoom, 'title' | 'alias'>) {
  return room.alias ?? room.title;
}

/** Предел избранного из `capabilities.favoritesMax` (пакет WP1); без поля — {@link FAVORITES_MAX}. */
export function favoritesLimit(capabilities: unknown): number {
  const value = (capabilities as { favoritesMax?: unknown } | null | undefined)?.favoritesMax;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : FAVORITES_MAX;
}

export type SectionKey = 'pinned' | 'loose' | `group:${string}`;
export interface Section {
  key: SectionKey;
  kind: 'pinned' | 'group' | 'loose';
  group?: FavoriteGroup;
  rooms: SavedRoom[];
  /**
   * Сколько комнат группы закреплено (R86): они стоят в «Закреплено», а в группе не повторяются,
   * но группа их считает — «Семья» с одной закреплённой не пустая.
   */
  pinned: number;
}

export const groupKey = (id: string): SectionKey => `group:${id}`;

/**
 * Список боковой панели: закреплённые, затем группы по порядку (и пустые — в них есть куда
 * положить), затем всё остальное. Порядок комнат внутри раздела — общий порядок избранного.
 * Комната из группы, которой больше нет, не теряется — она в общем списке.
 *
 * Комната и в группе, и закреплена (R86), показывается один раз — в «Закреплено» — и остаётся в
 * своей группе: `groupId` у неё прежний, группа считает её в `pinned`, открепление возвращает её
 * на место в группе.
 */
export function sections(rooms: SavedRoom[], groups: FavoriteGroup[]): Section[] {
  const known = new Set(groups.map((group) => group.id));
  const pinned = rooms.filter((room) => room.pinned);
  const result: Section[] = [];
  if (pinned.length) result.push({ key: 'pinned', kind: 'pinned', rooms: pinned, pinned: 0 });
  for (const group of groups)
    result.push({
      key: groupKey(group.id),
      kind: 'group',
      group,
      rooms: rooms.filter((room) => !room.pinned && room.groupId === group.id),
      pinned: pinned.filter((room) => room.groupId === group.id).length,
    });
  result.push({
    key: 'loose',
    kind: 'loose',
    rooms: rooms.filter((room) => !room.pinned && (!room.groupId || !known.has(room.groupId))),
    pinned: 0,
  });
  return result;
}

export interface Placement {
  /** Новый общий порядок комнат — тот же, если он не менялся. */
  order: string[];
  groupId: string | null;
  pinned: boolean;
}

/**
 * Куда встаёт комната, которую положили в раздел `target` перед его `index`-й комнатой (или в
 * конец). Раздел решает принадлежность: в «Закреплённых» комната закреплена и помнит свою группу,
 * в группе — лежит в ней, в общем списке — ни в какой. Место в общем порядке — рядом с соседями
 * по разделу, чтобы порядок внутри раздела вышел ровно таким, каким его показали.
 *
 * Закреплённую, перетащенную в группу, открепляет именно перетаскивание: она встаёт туда, куда её
 * положили, — где горела черта вставки. Меню «Группа ›» закрепления не снимает (R86).
 */
export function place(
  rooms: SavedRoom[],
  groups: FavoriteGroup[],
  roomId: string,
  target: SectionKey,
  index: number,
): Placement | null {
  const room = rooms.find((candidate) => candidate.roomId === roomId);
  if (!room) return null;
  const groupId =
    target === 'pinned' ? room.groupId : target === 'loose' ? null : target.slice('group:'.length);
  const pinned = target === 'pinned';
  const moved: SavedRoom = { ...room, groupId, pinned };
  const rest = rooms.filter((candidate) => candidate.roomId !== roomId);
  const neighbours = sections(rest, groups).find((section) => section.key === target)?.rooms ?? [];
  const ids = rest.map((candidate) => candidate.roomId);
  const before = neighbours[Math.max(0, index)];
  const last = neighbours.at(-1);
  let at: number;
  if (before) at = ids.indexOf(before.roomId);
  else if (last) at = ids.indexOf(last.roomId) + 1;
  else at = rooms.findIndex((candidate) => candidate.roomId === roomId);
  const order = [...ids];
  order.splice(Math.max(0, Math.min(at, order.length)), 0, moved.roomId);
  return { order, groupId: moved.groupId, pinned: moved.pinned };
}

/** Сдвинуть комнату на шаг внутри её раздела (клавиатура: Alt+↑/↓). */
export function nudge(rooms: SavedRoom[], groups: FavoriteGroup[], roomId: string, step: -1 | 1) {
  const section = sections(rooms, groups).find((candidate) =>
    candidate.rooms.some((room) => room.roomId === roomId),
  );
  if (!section) return null;
  const index = section.rooms.findIndex((room) => room.roomId === roomId);
  const next = index + step;
  if (next < 0 || next >= section.rooms.length) return null;
  // Индекс считается среди оставшихся без самой комнаты: «перед next-й» — это на шаг вверх, а
  // вниз — перед той, что стояла через одну (или в конец раздела).
  return place(rooms, groups, roomId, section.key, next);
}

const COLLAPSED = 'cord:favorite-groups:collapsed:v1';
export function collapsedGroups(): Set<string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(COLLAPSED) ?? '[]');
    return new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}
export function setGroupCollapsed(id: string, collapsed: boolean) {
  const next = collapsedGroups();
  if (collapsed) next.add(id);
  else next.delete(id);
  try {
    localStorage.setItem(COLLAPSED, JSON.stringify([...next]));
  } catch {
    /* Без хранилища группа свёрнута до перезагрузки. */
  }
  return next;
}

/**
 * Ядро без V8 не знает этих адресов: Spring отвечает 404/405 без нашего `code`. Свои отказы
 * (`FAVORITE_MISSING` — тоже 404) приходят с кодом и показываются как есть.
 */
function unknownRoute(error: unknown) {
  return (
    error instanceof Error &&
    'status' in error &&
    (error.status === 404 || error.status === 405) &&
    (error as { code?: string }).code === 'REQUEST_FAILED'
  );
}
function olderServer(error: unknown): never {
  if (unknownRoute(error)) throw new Error(t(($) => $.favorites.errors.groupsUnsupported));
  throw error;
}

export const favoriteGroupApi = {
  async list(): Promise<FavoriteGroup[]> {
    try {
      const groups = await request<unknown>('/favorites/groups', {}, favoriteProfile());
      return Array.isArray(groups)
        ? groups.filter(
            (group): group is FavoriteGroup =>
              !!group && typeof group.id === 'string' && typeof group.title === 'string',
          )
        : [];
    } catch (error) {
      // Старое ядро: групп просто нет, избранное работает как раньше.
      if (unknownRoute(error)) return [];
      throw error;
    }
  },
  async save(group: FavoriteGroup) {
    await request(
      `/favorites/groups/${group.id}`,
      { method: 'PUT', body: JSON.stringify({ title: group.title }) },
      favoriteProfile(),
    ).catch(olderServer);
    notifyDesktop('favorites.changed');
  },
  async remove(id: string) {
    await request(`/favorites/groups/${id}`, { method: 'DELETE' }, favoriteProfile()).catch(olderServer);
    notifyDesktop('favorites.changed');
  },
  async reorder(groupIds: string[]) {
    await request(
      '/favorites/groups/order',
      { method: 'PUT', body: JSON.stringify({ groupIds }) },
      favoriteProfile(),
    ).catch(olderServer);
  },
  async settings(roomId: string, settings: Pick<SavedRoom, 'groupId' | 'pinned' | 'alias'>) {
    await request(
      `/favorites/${roomId}/settings`,
      { method: 'PUT', body: JSON.stringify(settings) },
      favoriteProfile(),
    ).catch(olderServer);
    notifyDesktop('favorites.changed');
  },
};
