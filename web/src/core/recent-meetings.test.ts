import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Admission } from '../api/types';
import {
  CREDENTIAL_MS,
  RECENT_MAX,
  clearRecent,
  forgetRecent,
  listRecent,
  recordVisit,
} from './recent-meetings';

const admission = (roomId: string, extra: Partial<Admission['snapshot']> = {}, owner = false) =>
  ({
    roomId,
    credential: `${roomId}-member.secret`,
    participantId: `${roomId}-member`,
    inviteUrl: null,
    recoverySeconds: 30,
    snapshot: {
      id: roomId,
      title: `Встреча ${roomId}`,
      code: '123456789',
      closedAt: null,
      participants: [{ id: `${roomId}-member`, name: 'Я', owner }],
      ...extra,
    },
  }) as unknown as Admission;

describe('недавние встречи на устройстве (R148)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.useRealTimers());

  it('вход кладёт встречу наверх, повторный — поднимает её, а не дублирует', () => {
    recordVisit(admission('a'), 1000);
    recordVisit(admission('b'), 2000);
    recordVisit(admission('a', { title: 'Новое название' }), 3000);
    expect(listRecent(3000).map((entry) => [entry.roomId, entry.title])).toEqual([
      ['a', 'Новое название'],
      ['b', 'Встреча b'],
    ]);
  });

  it('создатель остаётся создателем, даже если поздний снимок этого не сказал', () => {
    recordVisit(admission('a', {}, true), 1000);
    recordVisit(admission('a'), 2000);
    expect(listRecent(2000)[0]!.creator).toBe(true);
  });

  it('не больше двадцати, самые старые уходят', () => {
    for (let index = 0; index < RECENT_MAX + 5; index++) recordVisit(admission(`r${index}`), index);
    const list = listRecent(RECENT_MAX + 5);
    expect(list).toHaveLength(RECENT_MAX);
    expect(list.at(-1)!.roomId).toBe('r5');
  });

  it('пропуск живёт сутки: после — строка остаётся, а вернуться им нельзя', () => {
    recordVisit(admission('a'), 1000);
    expect(listRecent(1000 + CREDENTIAL_MS - 1)[0]!.credential).toBe('a-member.secret');
    const later = listRecent(1000 + CREDENTIAL_MS + 1)[0]!;
    expect(later.credential).toBeUndefined();
    expect(later.roomId).toBe('a');
  });

  it('завершённая встреча помечена, удалённую и весь список можно убрать', () => {
    recordVisit(admission('a', { closedAt: 5000 }), 6000);
    recordVisit(admission('b'), 7000);
    expect(listRecent(7000).find((entry) => entry.roomId === 'a')!.closedAt).toBe(5000);
    forgetRecent('a');
    expect(listRecent(7000).map((entry) => entry.roomId)).toEqual(['b']);
    clearRecent();
    expect(listRecent(7000)).toEqual([]);
  });

  it('чужой профиль и битая запись — пустой список, а не ошибка', () => {
    recordVisit(admission('a'), 1000);
    const saved = JSON.parse(localStorage.getItem('cord:recent:v1')!);
    localStorage.setItem('cord:recent:v1', JSON.stringify({ ...saved, profile: 'чужой' }));
    expect(listRecent(1000)).toEqual([]);
    localStorage.setItem('cord:recent:v1', '{не json');
    expect(listRecent(1000)).toEqual([]);
  });
});
