import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Admission } from '../api/types';
import {
  RECENT_MAX,
  RECENT_MS,
  clearRecent,
  forgetRecent,
  listRecent,
  markEnded,
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

  it('не больше пяти: шестая встреча вытесняет самую старую (R165)', () => {
    expect(RECENT_MAX).toBe(5);
    for (let index = 1; index <= 5; index++) recordVisit(admission(`r${index}`), index * 1000);
    expect(listRecent(5000)).toHaveLength(5);
    recordVisit(admission('r6'), 6000);
    expect(listRecent(6000).map((entry) => entry.roomId)).toEqual(['r6', 'r5', 'r4', 'r3', 'r2']);
    // На диске — тоже пять, и пропуска вытесненной там нет.
    const saved = localStorage.getItem('cord:recent:v1')!;
    expect(JSON.parse(saved).items).toHaveLength(5);
    expect(saved).not.toContain('r1-member.secret');
  });

  it('встреча живёт сутки с последнего захода — потом уходит целиком, и с диска (R165)', () => {
    expect(RECENT_MS).toBe(24 * 60 * 60 * 1000);
    recordVisit(admission('a'), 1000);
    recordVisit(admission('b'), 5000);
    expect(listRecent(1000 + RECENT_MS - 1).map((entry) => entry.roomId)).toEqual(['b', 'a']);
    expect(listRecent(1000 + RECENT_MS - 1)[1]!.credential).toBe('a-member.secret');
    expect(listRecent(1000 + RECENT_MS).map((entry) => entry.roomId)).toEqual(['b']);
    // Пропуск стёрт и в хранилище, а не только в том, что вернули.
    expect(localStorage.getItem('cord:recent:v1')).not.toContain('a-member.secret');
    expect(listRecent(5000 + RECENT_MS)).toEqual([]);
  });

  it('повторный заход продлевает сутки', () => {
    recordVisit(admission('a'), 1000);
    recordVisit(admission('a'), 1000 + RECENT_MS - 10);
    expect(listRecent(1000 + RECENT_MS + 10).map((entry) => entry.roomId)).toEqual(['a']);
  });

  it('старый список длиннее пяти (до R165) при чтении урезается и на диске', () => {
    recordVisit(admission('seed'), 1000);
    const saved = JSON.parse(localStorage.getItem('cord:recent:v1')!);
    const items = Array.from({ length: 20 }, (_, index) => ({
      ...saved.items[0],
      roomId: `old${index}`,
      lastAt: 1000 + index,
    }));
    localStorage.setItem('cord:recent:v1', JSON.stringify({ ...saved, items }));
    expect(listRecent(2000).map((entry) => entry.roomId)).toEqual([
      'old19',
      'old18',
      'old17',
      'old16',
      'old15',
    ]);
    expect(JSON.parse(localStorage.getItem('cord:recent:v1')!).items).toHaveLength(5);
  });

  it('«уже закончилась» при попытке вернуться — строка помечается завершённой', () => {
    recordVisit(admission('a'), 1000);
    markEnded('a', 2000);
    expect(listRecent(2000)[0]).toMatchObject({ roomId: 'a', closedAt: 2000, lastAt: 1000 });
  });

  it('завершённая встреча помечена, удалённую и весь список можно убрать', () => {
    // «Убрать» пишет по часам устройства — и сутки считает от них же: время здесь настоящее.
    const now = Date.now();
    recordVisit(admission('a', { closedAt: now - 2000 }), now - 1000);
    recordVisit(admission('b'), now);
    expect(listRecent(now).find((entry) => entry.roomId === 'a')!.closedAt).toBe(now - 2000);
    forgetRecent('a');
    expect(listRecent(now).map((entry) => entry.roomId)).toEqual(['b']);
    clearRecent();
    expect(listRecent(now)).toEqual([]);
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
