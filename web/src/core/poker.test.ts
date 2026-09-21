import { describe, expect, it } from 'vitest';
import type { PokerSeat, PokerTable } from '../api/types';
import {
  actionLabel,
  betSpot,
  betSteps,
  callShare,
  chipColumns,
  chipPile,
  deadCards,
  cardFace,
  cardText,
  celebration,
  chips,
  dealDelay,
  dealOrder,
  seatLayout,
  sha256,
  shuffle,
  turnClock,
  verifyDeal,
} from './poker';

/** Колода, посчитанная ядром на зерне `test-seed`: по ней и сверяется браузерная тасовка. */
const CORE_DECK = [
  4, 34, 47, 9, 40, 14, 27, 25, 23, 37, 46, 33, 11, 19, 51, 48, 8, 2, 28, 22, 31, 26, 35, 10, 18, 3, 24, 5,
  17, 7, 29, 21, 36, 39, 6, 32, 30, 38, 41, 45, 44, 1, 0, 20, 13, 16, 15, 49, 42, 12, 50, 43,
];
const CORE_COMMITMENT = 'd63cd08d82aa4eb48e0cc64fb466e909bfc3879664c5caa8d8cdeda73c044190';

function seat(index: number, patch: Partial<PokerSeat> = {}): PokerSeat {
  return {
    index,
    memberId: `p${index}`,
    name: `Игрок ${index}`,
    stack: 5000,
    bet: 0,
    committed: 0,
    buyIn: 5000,
    cards: [],
    held: 0,
    inHand: false,
    folded: false,
    allIn: false,
    waiting: false,
    away: false,
    leaving: false,
    busted: false,
    place: 0,
    lastAction: '',
    lastActionAmount: 0,
    wonAmount: 0,
    handName: '',
    handCards: [],
    timeBankMs: 60000,
    ...patch,
  };
}

function table(patch: Partial<PokerTable> = {}): PokerTable {
  return {
    mode: 'friendly',
    modeName: 'Дружеская игра',
    phase: 'preflop',
    hostId: 'p0',
    handNumber: 1,
    revision: 1,
    button: 0,
    smallBlind: 25,
    bigBlind: 50,
    ante: 0,
    level: 1,
    levelUpAt: 0,
    turnSeconds: 45,
    seatingOpen: true,
    autoDeal: true,
    paused: false,
    rebuy: true,
    startingStack: 5000,
    pot: 0,
    betToCall: 50,
    actor: 0,
    actionAt: 1000,
    deadline: 46000,
    streetAt: 1000,
    handStartedAt: 1000,
    board: [],
    seats: Array.from({ length: 10 }, (_, index) =>
      seat(index, { memberId: index < 3 ? `p${index}` : null }),
    ),
    pots: [],
    log: [],
    result: null,
    you: null,
    commitment: '',
    seed: '',
    closesAt: 0,
    summary: null,
    ...patch,
  };
}

describe('место за столом', () => {
  it('сажает зрителя вниз по центру, а остальных — по кругу от него', () => {
    const mine = seatLayout(4)[4]!;
    expect(mine.slot).toBe(0);
    expect(Math.round(mine.x)).toBe(50);
    expect(mine.y).toBeGreaterThan(90);
    expect(mine.side).toBe('bottom');
    // Следующий по часовой стрелке — слева внизу, а не справа: стол разворачивается целиком.
    const next = seatLayout(4)[5]!;
    expect(next.slot).toBe(1);
    expect(next.x).toBeLessThan(50);
  });

  it('у того, кто не сидит, стол не крутится', () => {
    expect(seatLayout(null)[0]!.slot).toBe(0);
    expect(seatLayout(null)[9]!.slot).toBe(9);
  });

  it('разводит места по сторонам, чтобы ставки не легли поверх соседей', () => {
    const spots = seatLayout(0);
    expect(spots[0]!.side).toBe('bottom');
    expect(spots[5]!.side).toBe('top');
    expect(new Set(spots.map((spot) => spot.side)).size).toBeGreaterThan(2);
  });
});

describe('числа и подписи', () => {
  it('разделяет разряды и сокращает только миллионы', () => {
    expect(chips(0)).toBe('0');
    expect(chips(1250)).toBe('1\u202f250');
    expect(chips(125000)).toBe('125\u202f000');
    expect(chips(2400000)).toBe('2,4 млн');
  });

  it('называет действие так, как его называют за столом', () => {
    expect(actionLabel('fold')).toBe('Пас');
    expect(actionLabel('check')).toBe('Чек');
    expect(actionLabel('call', 200)).toBe('Колл 200');
    expect(actionLabel('allin', 5000)).toBe('Ва-банк 5\u202f000');
    expect(actionLabel('nonsense')).toBe('');
  });

  it('разбирает карту на то, чем её рисовать', () => {
    expect(cardFace('Td')).toEqual({ rank: '10', suit: '♦', red: true });
    expect(cardFace('As')).toEqual({ rank: 'A', suit: '♠', red: false });
  });
});

describe('фишки на сукне', () => {
  it('раскладывает сумму по номиналам, от старших к младшим', () => {
    expect(chipPile(0)).toEqual([]);
    expect(chipPile(1).map((disc) => disc.value)).toEqual([1]);
    expect(chipPile(130).map((disc) => disc.value)).toEqual([100, 25, 5]);
    // Стопка не растёт бесконечно: шести фишек хватает, чтобы прочитать «много».
    expect(chipPile(99999).length).toBeLessThanOrEqual(6);
    expect(chipPile(26, 2).map((disc) => disc.value)).toEqual([25, 1]);
  });

  it('разменивает стек так, чтобы пятёрка осталась пятёркой, а пять тысяч читались взглядом', () => {
    expect(chipColumns(0)).toEqual([]);
    // Мелкая сумма — это ровно те фишки, которые за неё дают.
    expect(chipColumns(5)).toEqual([{ value: 5, count: 1, tone: '#e04b4b' }]);
    expect(chipColumns(7).map((column) => [column.value, column.count])).toEqual([
      [1, 2],
      [5, 1],
    ]);
    // Крупная — крупными номиналами, и не больше четырёх столбиков: мелочь глазу не говорит
    // ничего, а точное число написано рядом.
    const big = chipColumns(5000);
    expect(big.length).toBeLessThanOrEqual(4);
    expect(big.at(-1)?.value).toBe(5000);
    expect(chipColumns(12345).map((column) => column.value)).toEqual([25, 100, 1000, 5000]);
    expect(chipColumns(12345, 2).map((column) => column.value)).toEqual([1000, 5000]);
    // Фишек одного номинала бывает много — это столбик со счётчиком, а не сто фишек в ряд.
    expect(chipColumns(4000).map((column) => [column.value, column.count])).toEqual([[1000, 4]]);
  });

  it('двигает ставку к линии, а не в середину стола', () => {
    expect(betSpot({ x: 50, y: 93 })).toEqual({ x: 50, y: 93 - 43 * 0.22 });
    // Из середины двигать некуда.
    expect(betSpot({ x: 50, y: 50 })).toEqual({ x: 50, y: 50 });
  });

  it('считает, какую долю банка стоит ответ', () => {
    const idle = table();
    expect(callShare(idle)).toBeNull();
    const facing = table({
      pot: 300,
      you: {
        seat: 0,
        cards: [],
        hand: '',
        actions: ['call'],
        callAmount: 100,
        minRaiseTo: 200,
        maxRaiseTo: 5000,
        timeBankMs: 0,
        turn: true,
      },
    });
    // Сто в банк из четырёхсот — четверть.
    expect(callShare(facing)).toBe(25);
  });
});

describe('вскрытие', () => {
  it('гасит карты, которые больше не играют, и не трогает чужие закрытые', () => {
    const state = table({
      phase: 'showdown',
      board: ['As', '7d', '9s', 'Jh', '4c'],
      seats: table().seats.map((one) =>
        seat(one.index, {
          memberId: one.memberId,
          cards: one.index === 0 ? ['Ah', '2c'] : one.index === 1 ? ['Kd', 'Kc'] : [],
          handCards:
            one.index === 0
              ? ['As', 'Ah', 'Jh', '9s', '7d']
              : one.index === 1
                ? ['Kd', 'Kc', 'As', 'Jh', '9s']
                : [],
        }),
      ),
    });
    const dead = deadCards(state);
    // Четвёрка не вошла ни в одну пятёрку — она и гаснет.
    expect(dead.has('4c')).toBe(true);
    expect(dead.has('As')).toBe(false);
    // Лишняя карта в чужой руке гаснет вместе с ней, но только у своего места.
    expect(dead.has('0:2c')).toBe(true);
    expect(dead.has('0:Ah')).toBe(false);
    // Пока раздача идёт, не гаснет ничего.
    expect(deadCards({ ...state, phase: 'river' }).size).toBe(0);
  });
});

describe('часы хода', () => {
  it('меряет остаток по серверным часам и краснеет к концу', () => {
    const state = table();
    expect(turnClock(state, 1000).fraction).toBe(1);
    expect(turnClock(state, 23500).fraction).toBeCloseTo(0.5, 1);
    expect(turnClock(state, 43000).urgent).toBe(true);
    expect(turnClock(state, 99000).remaining).toBe(0);
  });
});

describe('ставки в одно нажатие', () => {
  it('считает от банка, округляет до блайнда и не предлагает дважды одно и то же', () => {
    const state = table({
      pot: 300,
      betToCall: 100,
      you: {
        seat: 0,
        cards: ['As', 'Ah'],
        hand: 'Пара тузов',
        actions: ['fold', 'call', 'raise', 'allin'],
        callAmount: 100,
        minRaiseTo: 200,
        maxRaiseTo: 5000,
        timeBankMs: 60000,
        turn: true,
      },
    });
    const steps = betSteps(state);
    expect(steps.map((step) => step.id)).toEqual(['half', 'threequarters', 'pot', 'allin']);
    expect(steps.every((step) => step.amount % state.smallBlind === 0)).toBe(true);
    expect(steps.at(-1)).toEqual({ id: 'allin', label: 'Ва-банк', amount: 5000 });
    // Шаг, который не отличается от ва-банка, не показывается вовсе.
    const short = betSteps({ ...state, you: { ...state.you!, maxRaiseTo: 260 } });
    expect(short.map((step) => step.id)).toEqual(['allin']);
  });

  it('зрителю не предлагает ничего', () => {
    expect(betSteps(table())).toEqual([]);
  });
});

describe('раздача', () => {
  it('сдаёт по одной слева от кнопки и только тем, кто в раздаче', () => {
    const state = table({
      button: 8,
      seats: table().seats.map((one) =>
        seat(one.index, { memberId: one.memberId, inHand: [0, 2, 8].includes(one.index) }),
      ),
    });
    expect(dealOrder(state)).toEqual([0, 2, 8]);
  });

  it('тому, кто пришёл в середине раздачи, карты уже лежат', () => {
    const state = table({
      seats: table().seats.map((one) => seat(one.index, { memberId: one.memberId, inHand: one.index < 3 })),
    });
    const early = dealDelay(state, state.seats[2]!, 1, state.handStartedAt);
    expect(early).toBeGreaterThan(0);
    // Опоздавший получает отрицательную задержку: анимация начинается с конца.
    expect(dealDelay(state, state.seats[2]!, 1, state.handStartedAt + 9000)).toBeLessThan(0);
  });
});

describe('праздник', () => {
  it('громкость выбирает сервер, а не каждый сам', () => {
    expect(celebration(null)).toBeNull();
    expect(
      celebration({ at: 1, showdown: true, pot: 100, drama: 'normal', awards: [], busted: [] })?.label,
    ).toBe('');
    expect(
      celebration({ at: 1, showdown: true, pot: 100, drama: 'big', awards: [], busted: [] })?.label,
    ).toBe('Крупный банк');
    const knockout = celebration({ at: 1, showdown: true, pot: 100, drama: 'huge', awards: [], busted: [3] });
    expect(knockout).toEqual({ level: 'huge', label: 'Вылет', knockout: true });
  });
});

describe('честность', () => {
  it('тасует ровно так же, как ядро', async () => {
    expect(await sha256('test-seed')).toBe(CORE_COMMITMENT);
    expect(await shuffle('test-seed')).toEqual(CORE_DECK);
    expect(cardText(CORE_DECK[0]!)).toBe('3s');
  });

  it('сверяет карты с обещанием, данным до раздачи', async () => {
    const order = [1, 2];
    const state = table({
      button: 0,
      seed: 'test-seed',
      commitment: CORE_COMMITMENT,
      board: [1, 2, 3, 5, 7].map((shift) => cardText(CORE_DECK[4 + shift]!)),
      seats: table().seats.map((one) =>
        seat(one.index, {
          memberId: one.memberId,
          inHand: order.includes(one.index),
          cards: order.includes(one.index)
            ? [
                cardText(CORE_DECK[order.indexOf(one.index)]!),
                cardText(CORE_DECK[order.indexOf(one.index) + 2]!),
              ]
            : [],
        }),
      ),
    });
    expect(await verifyDeal(state)).toEqual({ state: 'ok', cards: 9 });

    // Подменённая карта видна сразу — в этом весь смысл обещания.
    const tampered = {
      ...state,
      seats: state.seats.map((one) => (one.index === 1 ? { ...one, cards: ['As', 'Ah'] } : one)),
    };
    expect((await verifyDeal(tampered)).state).toBe('mismatch');
    // Другое зерно не даст того же отпечатка.
    expect((await verifyDeal({ ...state, seed: 'other-seed' })).state).toBe('mismatch');
    // Пока раздача идёт, зерна нет ни у кого — и проверять нечего.
    expect((await verifyDeal({ ...state, seed: '' })).state).toBe('unavailable');
  });
});
