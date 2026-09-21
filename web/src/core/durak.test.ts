import { describe, expect, it } from 'vitest';
import type { DurakSeat, DurakTable } from '../api/types';
import {
  commandFor,
  dropFrom,
  faceOf,
  fanAngle,
  modeName,
  roomLeft,
  seatLayout,
  shuffle,
  tableSays,
  trumpName,
  verifyDeal,
} from './durak';

/**
 * Колода на 36 карт, посчитанная **ядром** на зерне `test-seed`.
 *
 * По ней и сверяется браузерная тасовка. Эти две реализации обязаны совпадать слово в слово:
 * разойдись они — проверка честности начнёт не молчать, а врать, и стол будет объявлять
 * подлогом каждую честную раздачу.
 */
const CORE_DECK_36 = [
  44, 20, 51, 47, 39, 46, 27, 24, 36, 33, 43, 25, 50, 41, 17, 35, 21, 30, 29, 32, 45, 23, 26, 16, 22, 19, 34,
  48, 38, 49, 37, 28, 40, 18, 42, 31,
];
const CORE_COMMITMENT = 'd63cd08d82aa4eb48e0cc64fb466e909bfc3879664c5caa8d8cdeda73c044190';

function seat(index: number, patch: Partial<DurakSeat> = {}): DurakSeat {
  return {
    index,
    memberId: `m${index}`,
    name: `Игрок ${index}`,
    held: 6,
    attacker: false,
    defender: false,
    passed: false,
    out: false,
    place: 0,
    away: false,
    fool: false,
    ...patch,
  };
}

function table(patch: Partial<DurakTable> = {}): DurakTable {
  return {
    mode: 'podkidnoy',
    modeName: 'Подкидной',
    phase: 'bout',
    hostId: 'm0',
    deckSize: 36,
    transfer: false,
    neighbours: false,
    firstFive: false,
    turnSeconds: 40,
    seatingOpen: true,
    revision: 1,
    handNumber: 1,
    trump: '9h',
    trumpSuit: 'h',
    deckLeft: 12,
    discarded: 0,
    attacker: 0,
    defender: 1,
    acting: [1],
    actionAt: 1000,
    deadline: 41000,
    taking: false,
    limit: 6,
    boutEnd: null,
    boutAt: 0,
    dealtAt: 0,
    table: [{ attack: '6s', beat: null }],
    seats: [
      seat(0, { attacker: true }),
      seat(1, { defender: true }),
      ...Array.from({ length: 4 }, (_, i) => seat(i + 2, { memberId: null, name: '', held: 0 })),
    ],
    log: [],
    you: null,
    score: [],
    result: null,
    commitment: CORE_COMMITMENT,
    seed: null,
    closesAt: 0,
    ...patch,
  };
}

describe('карта', () => {
  it('называется по-русски и знает свой цвет', () => {
    expect(faceOf('As')).toMatchObject({ rank: 'Т', glyph: '♠', red: false });
    expect(faceOf('Td')).toMatchObject({ rank: '10', glyph: '♦', red: true });
    expect(faceOf('Qh')).toMatchObject({ rank: 'Д', glyph: '♥', red: true });
    expect(faceOf('6c')).toMatchObject({ rank: '6', glyph: '♣', red: false });
  });

  it('читается голосом целиком: и номинал, и масть', () => {
    expect(faceOf('Jc').label).toBe('валет, трефы');
    expect(faceOf('7h').label).toBe('7, черви');
  });
});

describe('веер', () => {
  it('разворачивается от середины и сужается, когда карт много', () => {
    const six = Array.from({ length: 6 }, (_, i) => fanAngle(i, 6).angle);
    expect(six[0]).toBeLessThan(0);
    expect(six[5]).toBeGreaterThan(0);
    expect(six[0]! + six[5]!).toBeCloseTo(0);
    // Тринадцать карт с тем же шагом уехали бы за край стола, поэтому разворот упирается в предел.
    const wide = fanAngle(0, 13).angle;
    expect(Math.abs(wide)).toBeLessThanOrEqual(23);
  });

  it('поднимает середину выше краёв — так карты и держат', () => {
    expect(fanAngle(2, 5).lift).toBeGreaterThan(fanAngle(0, 5).lift);
  });

  it('одну карту не разворачивает вовсе', () => {
    expect(fanAngle(0, 1)).toEqual({ angle: 0, lift: 0 });
  });
});

describe('места', () => {
  it('сажают зрителя вниз по центру', () => {
    const spots = seatLayout(3);
    expect(spots[3]!.slot).toBe(0);
    expect(spots[3]!.side).toBe('bottom');
    // Своё место — ровно посередине ширины стола.
    expect(spots[3]!.x).toBeCloseTo(50);
  });

  it('раскладывает шестерых по кругу без повторов', () => {
    const slots = seatLayout(0).map((spot) => spot.slot);
    expect(new Set(slots).size).toBe(6);
  });

  /**
   * Места стоят ровно: шесть шагов по шестьдесят градусов.
   *
   * Сравниваются углы, а не расстояния: точки лежат на овале, и по нему равные углы дают разные
   * хорды. Раньше здесь была дуга над столом — четверо сидели тесно наверху, пока половина сукна
   * пустовала.
   */
  it('расставляет места равными шагами по овалу', () => {
    const spots = seatLayout(2);
    const angle = (spot: (typeof spots)[number]) => Math.atan2((spot.y - 50) / 42, (spot.x - 50) / 43);
    // Место зрителя поджато к центру под веер, поэтому угол берётся у остальных пяти.
    const around = spots.filter((spot) => spot.slot > 0).sort((a, b) => a.slot - b.slot);
    for (let index = 1; index < around.length; index++) {
      const step = angle(around[index]!) - angle(around[index - 1]!);
      const wrapped = ((step % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      expect(wrapped).toBeCloseTo(Math.PI / 3, 5);
    }
  });

  /** Своё место — внизу по центру и поджато к сукну: под ним лежит веер. */
  it('поджимает своё место под веер', () => {
    const mine = seatLayout(4).find((spot) => spot.slot === 0)!;
    expect(mine.index).toBe(4);
    expect(mine.x).toBeCloseTo(50);
    expect(mine.y).toBeLessThan(50 + 42);
    expect(mine.y).toBeGreaterThan(50);
  });
});

describe('бросок карты', () => {
  /** Крошечная подделка элемента: `closest` — единственное, чем пользуется разбор зоны. */
  function zone(drop?: string, under?: string): Element {
    const element = { dataset: { drop, under } } as unknown as HTMLElement;
    return {
      closest: (selector: string) => (drop && selector === '[data-drop]' ? element : null),
    } as unknown as Element;
  }

  it('на чужой карте означает «бью именно её»', () => {
    expect(dropFrom(zone('pair', '6s'))).toEqual({ kind: 'beat', under: '6s' });
    expect(commandFor({ kind: 'beat', under: '6s' }, false)).toEqual({ option: 'beat', under: '6s' });
  });

  it('на сукне означает ход, а у защитника — перевод', () => {
    expect(dropFrom(zone('table'))).toEqual({ kind: 'table' });
    expect(commandFor({ kind: 'table' }, false)).toEqual({ option: 'attack' });
    expect(commandFor({ kind: 'table' }, true)).toEqual({ option: 'transfer' });
  });

  it('мимо стола не означает ничего', () => {
    expect(dropFrom(zone())).toBeNull();
    expect(dropFrom(null)).toBeNull();
    expect(commandFor(null, false)).toBeNull();
  });

  /** Пара без карты — это не зона: бить нечего, и команду собирать не из чего. */
  it('пара без карты зоной не считается', () => {
    expect(dropFrom(zone('pair'))).toBeNull();
  });
});

describe('что говорит стол', () => {
  it('зовёт по имени того, кто отбивается', () => {
    expect(tableSays(table(), null)).toBe('Игрок 1 отбивается');
  });

  it('обращается к вам, когда ход ваш', () => {
    expect(tableSays(table(), 1)).toBe('Ваш ход: отбивайтесь или берите');
    expect(tableSays(table({ acting: [0], table: [] }), 0)).toBe('Ваш ход: заходите');
    expect(tableSays(table({ acting: [0] }), 0)).toBe('Ваш ход: подкиньте или скажите «бито»');
  });

  it('объявляет конец боя одним словом', () => {
    expect(tableSays(table({ boutEnd: 'beaten' }), 0)).toBe('Бито');
    expect(tableSays(table({ boutEnd: 'taken' }), 0)).toBe('Игрок 1 забирает');
  });

  it('называет дурака и признаёт ничью', () => {
    const over = table({
      phase: 'over',
      result: { at: 1, foolSeat: 1, foolName: 'Игрок 1', draw: false, bouts: 4, places: [] },
    });
    expect(tableSays(over, 0)).toBe('Игрок 1 — дурак');
    const draw = table({
      phase: 'over',
      result: { at: 1, foolSeat: -1, foolName: '', draw: true, bouts: 4, places: [] },
    });
    expect(tableSays(draw, 0)).toBe('Ничья — карт не осталось ни у кого');
  });

  it('ждёт раздачи, пока её не начали', () => {
    expect(tableSays(table({ phase: 'lobby' }), 0)).toBe('Стол ждёт раздачи');
  });
});

describe('бой', () => {
  it('считает, сколько ещё можно подкинуть', () => {
    expect(roomLeft(table({ limit: 6 }))).toBe(5);
    expect(roomLeft(table({ limit: 1 }))).toBe(0);
    // Предел уже выбран — отрицательного остатка не бывает.
    expect(roomLeft(table({ limit: 0 }))).toBe(0);
  });
});

describe('подписи', () => {
  it('называет вариант правил', () => {
    expect(modeName('podkidnoy')).toBe('Подкидной');
    expect(modeName('perevodnoy')).toBe('Переводной');
  });

  it('называет козырную масть словом', () => {
    expect(trumpName(table())).toBe('черви');
    expect(trumpName(table({ trumpSuit: null }))).toBe('');
  });
});

describe('честность раздачи', () => {
  it('тасует ровно так же, как ядро', async () => {
    expect(await shuffle('test-seed', 36)).toEqual(CORE_DECK_36);
  });

  it('молчит, пока зерно не раскрыто', async () => {
    expect(await verifyDeal(table())).toMatchObject({ state: 'unavailable' });
  });

  it('ловит подменённое зерно', async () => {
    const verdict = await verifyDeal(table({ seed: 'не то зерно' }));
    expect(verdict).toMatchObject({ state: 'mismatch' });
  });

  /**
   * Козырь — единственное, что видно всем и на что нельзя повлиять по ходу партии. Подменить его
   * значило бы подменить зерно, а отпечаток объявлен до раздачи.
   */
  it('сверяет козырь с тем, что следует из зерна', async () => {
    const bottom = CORE_DECK_36[CORE_DECK_36.length - 1]!;
    const trump = `${'23456789TJQKA'[Math.floor(bottom / 4)]}${'shdc'[bottom % 4]}`;
    const honest = await verifyDeal(
      table({ seed: 'test-seed', commitment: CORE_COMMITMENT, trump, trumpSuit: trump[1]! }),
    );
    expect(honest).toMatchObject({ state: 'ok', cards: 36 });
    const cheated = await verifyDeal(
      table({ seed: 'test-seed', commitment: CORE_COMMITMENT, trump: '6s', trumpSuit: 's' }),
    );
    expect(cheated).toMatchObject({ state: 'mismatch' });
  });
});
