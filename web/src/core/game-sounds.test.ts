import { describe, expect, it } from 'vitest';
import type { ChessTable, GameVisualEvent, GarticTable } from '../api/types';
import { EventCursor, cardCues, chessCue, garticCues, tickSecond, RECENT_MS } from './game-sounds';

const event = (id: number, type: GameVisualEvent['type'], at = 1000): GameVisualEvent => ({
  id,
  at,
  type,
  fromSeat: null,
  toSeat: null,
  count: 1,
  cards: [],
});

describe('звуки карт от событий стола', () => {
  it('раздача звучит тасовкой и не больше чем шестью картами, по шагу полёта', () => {
    const deals = Array.from({ length: 24 }, (_, index) => event(index + 1, 'deal'));
    const cues = cardCues('durak', deals);
    expect(cues[0]).toEqual({ sound: 'shuffle', delay: 0 });
    expect(cues.filter((cue) => cue.sound === 'deal')).toHaveLength(6);
    expect(cues.map((cue) => cue.delay)).toEqual([0, 180, 250, 320, 390, 460, 530]);
  });

  it('у дурака бросок, перевод, взятие и «бито» звучат по-разному', () => {
    const cues = cardCues('durak', [
      event(1, 'play'),
      event(2, 'transfer'),
      event(3, 'take'),
      event(4, 'discard'),
    ]).map((cue) => cue.sound);
    expect(cues).toEqual(['place', 'slide', 'sweep', 'discard']);
  });

  it('одно событие у двух игр значит разное: сброс в покере — не отбой, борт — не добор', () => {
    expect(cardCues('poker', [event(1, 'discard')]).map((cue) => cue.sound)).toEqual(['slide']);
    expect(cardCues('poker', [event(1, 'draw'), event(2, 'draw')])).toEqual([
      { sound: 'place', delay: 0 },
      { sound: 'place', delay: 120 },
    ]);
    expect(cardCues('durak', [event(1, 'draw')]).map((cue) => cue.sound)).toEqual(['deal']);
  });
});

describe('курсор событий', () => {
  it('первый снимок и снимок после обрыва — это состояние, а не новости', () => {
    const cursor = new EventCursor();
    expect(cursor.take([event(1, 'play'), event(2, 'play')], true, 1000)).toEqual([]);
    expect(cursor.take([event(1, 'play'), event(2, 'play'), event(3, 'take')], true, 1100)).toEqual([
      event(3, 'take'),
    ]);
    expect(cursor.take([event(4, 'play')], false, 1200)).toEqual([]);
    // Первый снимок после возвращения связи тоже ставит курсор, а не звучит.
    expect(cursor.take([event(4, 'play'), event(5, 'play')], true, 1300)).toEqual([]);
    expect(cursor.take([event(6, 'discard', 1400)], true, 1400)).toEqual([event(6, 'discard', 1400)]);
  });

  it('старое событие не звучит, даже если оно новое для курсора', () => {
    const cursor = new EventCursor();
    cursor.take([event(1, 'play')], true, 1000);
    expect(cursor.take([event(2, 'play', 1000)], true, 1000 + RECENT_MS + 1)).toEqual([]);
  });
});

describe('шахматы и Gartic', () => {
  const chess = (ply: number, san: string | null, result: string | null = null) =>
    ({
      id: 'g',
      ply,
      moves: san ? [{ ply, uci: 'e2e4', san, fen: '', at: 0 }] : [],
      result,
    }) as unknown as ChessTable;

  it('ход, взятие, шах и мат различаются по записи хода', () => {
    expect(chessCue(chess(0, null), chess(1, 'e4'))).toBe('move');
    expect(chessCue(chess(1, 'e4'), chess(2, 'exd5'))).toBe('capture');
    expect(chessCue(chess(2, 'exd5'), chess(3, 'Bb5+'))).toBe('check');
    expect(chessCue(chess(3, 'Bb5+'), chess(4, 'Qxf7#'))).toBe('mate');
    expect(chessCue(chess(4, 'Qxf7#'), chess(4, 'Qxf7#'))).toBeNull();
    expect(chessCue(null, chess(1, 'e4'))).toBeNull();
  });

  it('конец партии без мата — колокольчик', () => {
    expect(chessCue(chess(4, 'e4'), chess(4, 'e4', 'resign'))).toBe('round');
  });

  const gartic = (phase: string, guesses: { id: number; correct: boolean }[] = []) =>
    ({ gameId: 'g', phase, guesses, revealAlbum: 0, revealEntry: 0 }) as unknown as GarticTable;

  it('раунд, верная догадка и конец игры', () => {
    expect(garticCues(gartic('choosing'), gartic('drawing'))).toEqual(['round']);
    expect(
      garticCues(
        gartic('drawing', [{ id: 1, correct: false }]),
        gartic('drawing', [
          { id: 1, correct: false },
          { id: 2, correct: true },
        ]),
      ),
    ).toEqual(['correct']);
    expect(garticCues(gartic('round-reveal'), gartic('finished'))).toEqual(['win']);
    expect(garticCues(null, gartic('drawing'))).toEqual([]);
  });
});

it('часы тикают только последние пять секунд', () => {
  expect(tickSecond(10_000, 4_000)).toBeNull();
  expect(tickSecond(10_000, 5_000)).toBe(5);
  expect(tickSecond(10_000, 9_100)).toBe(1);
  expect(tickSecond(10_000, 10_000)).toBeNull();
});
