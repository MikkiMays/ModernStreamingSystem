import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../api/types';
import { awayAfter, stageOccupant, stageView, type StageOccupant } from './stage-view';

/*
  Выход из интеграции к участникам (R121): что занимает сцену, какой вид у зрителя и что остаётся от его
  ухода, когда сцена меняется. Выбор вида — личный, комната о нём не знает.
*/

type Room = Pick<Snapshot, 'chess' | 'gartic' | 'poker' | 'durak' | 'watch' | 'board'>;
const room = (extra: Partial<Record<keyof Room, unknown>> = {}) =>
  ({
    chess: null,
    gartic: null,
    poker: null,
    durak: null,
    watch: null,
    board: null,
    ...extra,
  }) as unknown as Room;
const film: StageOccupant = { kind: 'cinema', film: true };
const catalog: StageOccupant = { kind: 'cinema', film: false };
const poker: StageOccupant = { kind: 'poker', film: false };

describe('что занимает сцену', () => {
  it('никто — разговор', () => {
    expect(stageOccupant(room(), false)).toBeNull();
  });

  it('порядок тот же, что у сцены: шахматы, рисование, покер, дурак, кинозал', () => {
    expect(stageOccupant(room({ chess: {}, gartic: {}, poker: {}, watch: {} }), true)).toEqual({
      kind: 'chess',
      film: false,
    });
    expect(stageOccupant(room({ gartic: {}, poker: {} }), false)?.kind).toBe('gartic');
    expect(stageOccupant(room({ poker: {}, durak: {}, watch: {} }), false)?.kind).toBe('poker');
    expect(stageOccupant(room({ durak: {}, watch: {} }), false)?.kind).toBe('durak');
  });

  it('доска (R159) — своя интеграция на сцене, раньше кинозала', () => {
    expect(stageOccupant(room({ board: { drawers: 'all' } }), false)).toEqual({ kind: 'board', film: false });
    expect(stageOccupant(room({ board: { drawers: 'all' } }), true)?.kind).toBe('board');
    expect(stageOccupant(room({ durak: {}, board: { drawers: 'all' } }), false)?.kind).toBe('durak');
  });

  it('кинозал — фильм комнаты или свой открытый каталог', () => {
    expect(stageOccupant(room({ watch: {} }), false)).toEqual(film);
    expect(stageOccupant(room({ watch: {} }), true)).toEqual(film);
    expect(stageOccupant(room(), true)).toEqual(catalog);
  });
});

describe('вид у зрителя', () => {
  it('сцену никто не занимает — обычная встреча, что бы ни помнилось', () => {
    expect(stageView(null, null, false)).toBe('meeting');
    expect(stageView(null, 'poker', true)).toBe('meeting');
  });

  it('ушёл именно от этой интеграции — участники, иначе интеграция', () => {
    expect(stageView(poker, 'poker', false)).toBe('people');
    expect(stageView(poker, null, false)).toBe('integration');
    expect(stageView(poker, 'cinema', false)).toBe('integration');
  });

  it('чужой экран открыт поверх занятой сцены — это вид участников', () => {
    expect(stageView(film, null, true)).toBe('people');
  });
});

describe('уход после смены сцены', () => {
  it('без ухода нечего помнить', () => {
    expect(awayAfter(null, poker, poker)).toBeNull();
  });

  it('та же интеграция идёт — уход остаётся', () => {
    expect(awayAfter('poker', poker, poker)).toBe('poker');
  });

  it('интеграция кончилась или её сменила другая — уход забыт: новая открывается у всех', () => {
    expect(awayAfter('poker', poker, null)).toBeNull();
    expect(awayAfter('poker', poker, { kind: 'durak', film: false })).toBeNull();
  });

  it('стоял в своём каталоге и ушёл, а комната включила фильм — фильм открывается и у него', () => {
    expect(awayAfter('cinema', catalog, film)).toBeNull();
  });

  it('следующая серия, пауза или другой фильм в идущем кинозале ухода не сбрасывают', () => {
    expect(awayAfter('cinema', film, film)).toBe('cinema');
  });

  it('фильм закрыли, а свой каталог остался открытым — ушедший остаётся с людьми', () => {
    expect(awayAfter('cinema', film, catalog)).toBe('cinema');
  });
});
