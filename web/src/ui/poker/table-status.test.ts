import { describe, expect, it } from 'vitest';
import type { PokerTable } from '../../api/types';
import { tableStatus } from './table-status';

/** Стол, у которого задано только то, что читает шапка. */
function table(patch: Partial<PokerTable> = {}): PokerTable {
  const seats = Array.from({ length: 10 }, (_, index) => ({
    index,
    memberId: null as string | null,
    stack: 0,
    away: false,
  }));
  return {
    phase: 'lobby',
    paused: false,
    deadline: 0,
    closesAt: 0,
    seats,
    ...patch,
  } as unknown as PokerTable;
}
const seated = (count: number, patch: object = {}) =>
  table().seats.map((seat, index) =>
    index < count ? { ...seat, memberId: `p${index}`, stack: 5000, ...patch } : seat,
  );

/**
 * R46: шапка стола сама говорит, в каком он состоянии, — строки под столом и плашек на сукне
 * больше нет (R45, R27).
 */
describe('что шапка покерного стола говорит между раздачами', () => {
  it('ждёт игроков и считает, сколько из двух уже есть', () => {
    expect(tableStatus(table(), false)).toEqual({ kind: 'waiting', ready: 0, need: 2 });
    expect(tableStatus(table({ seats: seated(1) } as Partial<PokerTable>), true)).toEqual({
      kind: 'waiting',
      ready: 1,
      need: 2,
    });
  });

  it('отошедшего и пустой стек не считает готовым', () => {
    const seats = seated(2).map((seat, index) => (index === 1 ? { ...seat, away: true } : seat));
    expect(tableStatus(table({ seats } as Partial<PokerTable>), true)).toMatchObject({
      kind: 'waiting',
      ready: 1,
    });
  });

  it('раздающему говорит «можно раздавать», остальным — что ждём его', () => {
    const ready = table({ seats: seated(2) } as Partial<PokerTable>);
    expect(tableStatus(ready, true)).toEqual({ kind: 'ready' });
    expect(tableStatus(ready, false)).toEqual({ kind: 'dealer' });
  });

  it('называет срок автораздачи', () => {
    expect(tableStatus(table({ seats: seated(3), deadline: 9000 } as Partial<PokerTable>), false)).toEqual({
      kind: 'dealing',
      until: 9000,
    });
  });

  it('срок пустого стола важнее всего остального — и после конца игры тоже', () => {
    expect(tableStatus(table({ closesAt: 600000 }), true)).toEqual({ kind: 'closing', until: 600000 });
    expect(tableStatus(table({ phase: 'over', closesAt: 600000 } as Partial<PokerTable>), true)).toEqual({
      kind: 'closing',
      until: 600000,
    });
  });

  it('на паузе говорит о паузе', () => {
    expect(tableStatus(table({ paused: true, seats: seated(2) } as Partial<PokerTable>), true)).toEqual({
      kind: 'paused',
    });
  });

  it('пока идёт раздача, молчит: там шапка говорит, чей ход', () => {
    expect(tableStatus(table({ phase: 'flop', closesAt: 600000 } as Partial<PokerTable>), true)).toBeNull();
    expect(tableStatus(table({ phase: 'over' } as Partial<PokerTable>), true)).toBeNull();
  });
});
