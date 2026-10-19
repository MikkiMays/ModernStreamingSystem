import { beforeEach, describe, expect, it } from 'vitest';
import {
  collapsedGroups,
  favoritesLimit,
  groupKey,
  nudge,
  place,
  readRoom,
  roomName,
  sections,
  setGroupCollapsed,
  type FavoriteGroup,
  type SavedRoom,
} from './favorite-groups';

const room = (roomId: string, extra: Partial<SavedRoom> = {}): SavedRoom => ({
  roomId,
  title: `Комната ${roomId}`,
  code: '333444555',
  savedAt: 1,
  closed: false,
  canJoin: true,
  groupId: null,
  pinned: false,
  alias: null,
  ...extra,
});
const work: FavoriteGroup = { id: 'work', title: 'Работа' };
const home: FavoriteGroup = { id: 'home', title: 'Дом' };

describe('readRoom', () => {
  it('reads an older core without groups as a plain list', () => {
    const plain = readRoom({ roomId: 'a', title: 'А', code: '1', savedAt: 1, closed: false, canJoin: true, pinned: false });
    expect(plain).toMatchObject({ groupId: null, pinned: false, alias: null });
  });

  it('keeps the person’s own name and treats a blank one as none', () => {
    const named = readRoom({ ...room('a'), alias: '  Дейли ' } as never);
    expect(roomName(named)).toBe('Дейли');
    expect(roomName(readRoom({ ...room('b'), alias: '  ' } as never))).toBe('Комната b');
  });
});

describe('sections', () => {
  it('puts pinned rooms first, then groups in order, then the rest', () => {
    const list = sections(
      [
        room('a', { groupId: 'work' }),
        room('b', { pinned: true, groupId: 'work' }),
        room('c'),
        room('d', { groupId: 'home' }),
      ],
      [work, home],
    );
    expect(list.map((s) => [s.key, s.rooms.map((r) => r.roomId)])).toEqual([
      ['pinned', ['b']],
      ['group:work', ['a']],
      ['group:home', ['d']],
      ['loose', ['c']],
    ]);
  });

  it('shows empty groups so there is somewhere to drop a room, and no pinned section without pins', () => {
    const list = sections([room('a')], [work]);
    expect(list.map((s) => s.key)).toEqual(['group:work', 'loose']);
    expect(list[0]!.rooms).toEqual([]);
  });

  it('does not lose a room whose group was deleted on another device', () => {
    const list = sections([room('a', { groupId: 'gone' })], [work]);
    expect(list.find((s) => s.key === 'loose')!.rooms.map((r) => r.roomId)).toEqual(['a']);
  });
});

describe('place', () => {
  const rooms = [
    room('a', { groupId: 'work' }),
    room('b'),
    room('c', { groupId: 'work' }),
    room('d'),
    room('e', { groupId: 'work' }),
  ];

  it('moves a room into a group at the dropped spot, keeping the rest of the order', () => {
    expect(place(rooms, [work], 'd', groupKey('work'), 1)).toEqual({
      order: ['a', 'b', 'd', 'c', 'e'],
      groupId: 'work',
      pinned: false,
    });
  });

  it('appends after the last room of the section when dropped on its header', () => {
    expect(place(rooms, [work], 'b', groupKey('work'), 99)?.order).toEqual(['a', 'c', 'd', 'e', 'b']);
  });

  it('returns a room to the common list', () => {
    expect(place(rooms, [work], 'c', 'loose', 0)).toEqual({
      order: ['a', 'c', 'b', 'd', 'e'],
      groupId: null,
      pinned: false,
    });
  });

  it('pins without forgetting the group the room came from', () => {
    expect(place(rooms, [work], 'e', 'pinned', 0)).toMatchObject({ groupId: 'work', pinned: true });
  });

  it('keeps the place of a room dropped into an empty group', () => {
    expect(place(rooms, [work, home], 'd', groupKey('home'), 0)?.order).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('knows nothing about a room that is not saved', () => {
    expect(place(rooms, [work], 'zzz', 'loose', 0)).toBeNull();
  });
});

describe('nudge', () => {
  const rooms = [room('a', { groupId: 'work' }), room('b'), room('c', { groupId: 'work' }), room('d')];

  it('moves a room one step within its own section', () => {
    expect(nudge(rooms, [work], 'c', -1)?.order).toEqual(['c', 'a', 'b', 'd']);
    expect(nudge(rooms, [work], 'b', 1)?.order).toEqual(['a', 'c', 'd', 'b']);
  });

  it('stops at the edges of the section', () => {
    expect(nudge(rooms, [work], 'a', -1)).toBeNull();
    expect(nudge(rooms, [work], 'd', 1)).toBeNull();
  });
});

describe('favoritesLimit', () => {
  it('follows the server, and ten without it', () => {
    expect(favoritesLimit({ favoritesMax: 12 })).toBe(12);
    expect(favoritesLimit({})).toBe(10);
    expect(favoritesLimit({ favoritesMax: 0 })).toBe(10);
    expect(favoritesLimit(undefined)).toBe(10);
  });
});

describe('collapsed groups', () => {
  beforeEach(() => localStorage.clear());

  it('remembers which groups are folded on this device', () => {
    setGroupCollapsed('work', true);
    setGroupCollapsed('home', true);
    setGroupCollapsed('home', false);
    expect([...collapsedGroups()]).toEqual(['work']);
  });

  it('survives a corrupt record', () => {
    localStorage.setItem('cord:favorite-groups:collapsed:v1', '{oops');
    expect(collapsedGroups().size).toBe(0);
  });
});
