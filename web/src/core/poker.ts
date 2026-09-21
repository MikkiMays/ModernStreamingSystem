import type { PokerAction, PokerMode, PokerResult, PokerSeat, PokerTable } from '../api/types';

/**
 * Стол, посчитанный до того, как его нарисовали.
 *
 * Здесь нет ни одного правила игры — они на сервере, и второй их копии быть не должно. Здесь
 * только то, что нужно, чтобы показать: где чьё место на овале, сколько осталось на ход, какие
 * ставки предложить одной кнопкой и насколько громко праздновать. Всё это считается из снимка и
 * **серверных часов**, поэтому у десяти человек получается одинаково, а не «примерно одинаково».
 */
export const SEATS = 10;

/** Сколько летят карты в начале раздачи. То же число, что и в ядре: {@code Table.DEAL_MS}. */
export const DEAL_MS = 1600;

/** Задержка между картами при раздаче: по ней и читается, что их раздают по одной. */
export const DEAL_STEP_MS = 90;

/** Сколько длится перелёт фишек в банк в конце круга. */
export const COLLECT_MS = 520;

export type SeatSide = 'bottom' | 'left' | 'right' | 'top';
export interface SeatSpot {
  index: number;
  /** Позиция на овале в процентах ширины и высоты стола. */
  x: number;
  y: number;
  /** Куда от места смотрит «наружу»: этим разворачиваются ставки, пузыри и подписи. */
  side: SeatSide;
  /** Место зрителя всегда внизу: 0 — оно и есть. */
  slot: number;
}

/**
 * Где какое место.
 *
 * ГЛАВНОЕ ПРАВИЛО: своё место — всегда внизу по центру. За настоящим столом человек сидит на
 * своём стуле, а не смотрит на себя со стороны; стол, который «прокручивается» под зрителя, —
 * это то, что отличает игру от таблицы с номерами мест.
 */
export function seatLayout(mySeat: number | null, seats = SEATS): SeatSpot[] {
  const anchor = mySeat ?? 0;
  return Array.from({ length: seats }, (_, index) => {
    const slot = (index - anchor + seats) % seats;
    const angle = (Math.PI / 2 + (slot * 2 * Math.PI) / seats) % (2 * Math.PI);
    const x = 50 + 46 * Math.cos(angle);
    const y = 50 + 43 * Math.sin(angle);
    const sin = Math.sin(angle);
    const cos = Math.cos(angle);
    const side: SeatSide = sin > 0.5 ? 'bottom' : sin < -0.5 ? 'top' : cos > 0 ? 'right' : 'left';
    return { index, x, y, side, slot };
  });
}

/**
 * Фишки словами.
 *
 * Разряды разделяются узким неразрывным пробелом, а не запятой: «1 250» читается с одного
 * взгляда, «1250» приходится разбирать. Сокращение появляется только там, где число перестаёт
 * помещаться в кружок места, — миллионы за домашним столом это уже не счёт, а масштаб.
 */
export function chips(amount: number): string {
  const value = Math.round(amount);
  if (!Number.isFinite(value)) return '0';
  if (Math.abs(value) >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${millions.toFixed(millions >= 10 ? 0 : 1).replace('.', ',')} млн`;
  }
  return value.toLocaleString('ru-RU').replace(/ /g, ' ');
}

const ACTIONS: Record<PokerAction, string> = {
  fold: 'Пас',
  check: 'Чек',
  call: 'Колл',
  bet: 'Ставка',
  raise: 'Рейз',
  allin: 'Ва-банк',
};

/** Как называется то, что человек сделал. Сумма добавляется только там, где она есть. */
export function actionLabel(action: string, amount = 0): string {
  const word = ACTIONS[action as PokerAction];
  if (!word) return '';
  if (action === 'fold' || action === 'check') return word;
  return amount > 0 ? `${word} ${chips(amount)}` : word;
}

const PHASES: Record<string, string> = {
  lobby: 'Ждём раздачу',
  preflop: 'Префлоп',
  flop: 'Флоп',
  turn: 'Тёрн',
  river: 'Ривер',
  showdown: 'Вскрытие',
  over: 'Игра окончена',
};

export function phaseLabel(phase: string): string {
  return PHASES[phase] ?? '';
}

export interface TurnClock {
  /** Сколько осталось, мс. */
  remaining: number;
  /** Доля от всего времени на ход: по ней рисуется кольцо. */
  fraction: number;
  total: number;
  /** Последние секунды: кольцо краснеет, и это единственное, что здесь про цвет. */
  urgent: boolean;
}

/**
 * Сколько осталось на ход — по часам сервера, а не по своим.
 *
 * Раздача началась с запасом на анимацию: первый ход ждёт, пока долетят карты, и часы всё это
 * время показывают полный круг. Считается это само собой, потому что и начало отсчёта, и конец
 * приехали из одного снимка.
 */
export function turnClock(table: PokerTable, serverNow: number): TurnClock {
  const total = Math.max(1, table.deadline - table.actionAt);
  const remaining = Math.max(0, table.deadline - serverNow);
  return {
    remaining,
    total,
    fraction: Math.max(0, Math.min(1, remaining / total)),
    urgent: remaining > 0 && remaining <= 5000,
  };
}

export interface BetStep {
  id: string;
  label: string;
  amount: number;
}

/**
 * Ставки в одно нажатие.
 *
 * Считаются от банка, как о них и думают за столом: «половину банка», «банк». Числа
 * округляются до малого блайнда — иначе кнопка предлагала бы поставить 337, и человек каждый
 * раз лез бы поправлять ползунок. Шаг, который не отличается от минимального повышения или от
 * ва-банка, не показывается: две кнопки с одинаковым действием хуже одной.
 */
export function betSteps(table: PokerTable): BetStep[] {
  const you = table.you;
  if (!you) return [];
  const opening = table.betToCall === 0;
  const live = table.pot + table.seats.reduce((sum, seat) => sum + seat.bet, 0);
  const afterCall = live + you.callAmount;
  const shares: [string, number, string][] = opening
    ? [
        ['third', 1 / 3, '⅓ банка'],
        ['half', 1 / 2, '½ банка'],
        ['pot', 1, 'Банк'],
      ]
    : [
        ['half', 1 / 2, '½ банка'],
        ['threequarters', 3 / 4, '¾ банка'],
        ['pot', 1, 'Банк'],
      ];
  const step = Math.max(1, table.smallBlind);
  const steps: BetStep[] = [];
  for (const [id, share, label] of shares) {
    const raw = table.betToCall + afterCall * share;
    const amount = Math.min(you.maxRaiseTo, Math.max(you.minRaiseTo, Math.round(raw / step) * step));
    if (amount >= you.maxRaiseTo) continue;
    if (steps.some((existing) => existing.amount === amount)) continue;
    steps.push({ id, label, amount });
  }
  steps.push({ id: 'allin', label: 'Ва-банк', amount: you.maxRaiseTo });
  return steps;
}

/**
 * Насколько крупно выиграли — и, значит, насколько громко это показывать.
 *
 * Решает **сервер**: у всех за столом должна сработать одна и та же анимация, а не у каждого
 * своя по своим числам. Здесь только слова к ней.
 */
export interface Celebration {
  level: 'normal' | 'big' | 'huge';
  /** Подпись над столом, или пусто — обычный банк объявлять незачем. */
  label: string;
  knockout: boolean;
}

export function celebration(result: PokerResult | null | undefined): Celebration | null {
  if (!result) return null;
  const knockout = result.busted.length > 0;
  const level = (result.drama as Celebration['level']) ?? 'normal';
  const label =
    level === 'huge' ? (knockout ? 'Вылет' : 'Огромный банк') : level === 'big' ? 'Крупный банк' : '';
  return { level, label, knockout };
}

/**
 * Режимы стола — те же, что знает ядро.
 *
 * Список повторён здесь ради одного: показать выбор **до** того, как стол создан, — сервер про
 * него в этот момент ещё ничего не знает. Правила из этих чисел не следуют: их применяет ядро,
 * а несовпадение ловится тестом, который пересчитывает блайнды теми же числами.
 */
export interface PokerModeInfo {
  id: PokerMode;
  name: string;
  hint: string;
  stack: number;
  /** Во сколько больших блайндов оценён стартовый стек: от него считаются блайнды. */
  depth: number;
  turnSeconds: number;
}

export const POKER_MODES: PokerModeInfo[] = [
  {
    id: 'friendly',
    name: 'Дружеская игра',
    hint: 'Блайнды стоят на месте, докупиться можно между раздачами. Никто не вылетает насовсем.',
    stack: 5000,
    depth: 100,
    turnSeconds: 45,
  },
  {
    id: 'tournament',
    name: 'Турнир',
    hint: 'Один стек на всю игру, блайнды растут каждые восемь минут. Проиграл — выбыл, и стол считает места.',
    stack: 10000,
    depth: 100,
    turnSeconds: 30,
  },
  {
    id: 'turbo',
    name: 'Блиц',
    hint: 'Тот же турнир, только быстрее: блайнды каждые три минуты и пятнадцать секунд на ход.',
    stack: 3000,
    depth: 30,
    turnSeconds: 15,
  },
];

export const MIN_STACK = 200;
export const MAX_STACK = 1_000_000;

/** Ровное число: 1, 2, 5 и их десятки. Тот же расчёт, что и в ядре. */
export function niceChips(value: number): number {
  if (value <= 1) return 1;
  let power = 1;
  while (power * 10 <= value) power *= 10;
  const lead = Math.floor(value / power);
  const rounded = lead >= 7 ? 10 : lead >= 4 ? 5 : lead >= 2 ? 2 : 1;
  return rounded * power;
}

/**
 * Какими будут блайнды при таком стеке.
 *
 * Меняют одно число — стек, — а блайнды считаются от него, сохраняя глубину режима. Иначе
 * «раздайте по десять тысяч» означало бы игру, в которой первая ставка ничего не решает.
 */
export function blindsFor(mode: PokerMode, stack: number): { small: number; big: number } {
  const preset = POKER_MODES.find((item) => item.id === mode) ?? POKER_MODES[0]!;
  const wanted = Math.max(MIN_STACK, Math.min(MAX_STACK, Math.round(stack) || preset.stack));
  const big = Math.max(2, niceChips(Math.floor(wanted / preset.depth)));
  return { small: Math.max(1, Math.floor(big / 2)), big };
}

/**
 * Фишки, как они лежат на сукне.
 *
 * ПОЧЕМУ НЕ ОДИН КРУЖОК С ЧИСЛОМ. За столом размер ставки узнают не чтением, а взглядом: по
 * высоте стопки и по цветам. Цвета взяты казиношные — те, к которым привыкли: белый единица,
 * красный пятёрка, синий десятка, зелёный четвертак, чёрный сотня, фиолетовый пятьсот, оранжевый
 * тысяча. Число рядом остаётся, потому что игровые стеки бывают любыми.
 */
export interface ChipDisc {
  value: number;
  tone: string;
}

const DENOMINATIONS: [number, string][] = [
  [25000, '#f2f4f8'],
  [5000, '#e8c33c'],
  [1000, '#e8862c'],
  [500, '#8a5cf6'],
  [100, '#23282f'],
  [25, '#1f9d63'],
  [10, '#3564f3'],
  [5, '#e04b4b'],
  [1, '#e9edf4'],
];

/**
 * Во что раскладывается сумма. Стопка ограничена по высоте: двадцать фишек в кружке места
 * нарисовать негде, а «много» читается и с шести.
 */
export function chipPile(amount: number, limit = 6): ChipDisc[] {
  const discs: ChipDisc[] = [];
  let left = Math.max(0, Math.round(amount));
  for (const [value, tone] of DENOMINATIONS) {
    while (left >= value && discs.length < limit) {
      discs.push({ value, tone });
      left -= value;
    }
    if (discs.length >= limit) break;
  }
  if (!discs.length && amount > 0) discs.push({ value: 1, tone: '#e9edf4' });
  return discs;
}

/**
 * Сколько стоит ответ относительно банка.
 *
 * Без жаргона: не «шансы банка 3 к 1», а доля банка, которую придётся доложить. Это то же
 * число, только его не нужно переводить в уме.
 */
export function callShare(table: PokerTable): number | null {
  const you = table.you;
  if (!you || you.callAmount <= 0) return null;
  const live = table.pot + table.seats.reduce((sum, seat) => sum + seat.bet, 0) + you.callAmount;
  if (live <= 0) return null;
  return Math.round((you.callAmount / live) * 100);
}

/**
 * Какие карты на вскрытии уже не играют.
 *
 * За настоящим столом лишние карты не подсвечивают — их просто убирают из поля зрения, а
 * комбинацию называют вслух. Здесь то же самое: всё, что не вошло в победную пятёрку, гаснет,
 * и смотреть остаётся ровно на то, чем выиграли.
 */
export function deadCards(table: PokerTable): Set<string> {
  const dead = new Set<string>();
  if (table.phase !== 'showdown') return dead;
  // Живо то, что вошло хоть в чью-нибудь пятёрку: общая карта может играть у одного и не
  // играть у другого, и гасить её, пока она кому-то нужна, нельзя.
  const alive = new Set<string>();
  for (const seat of table.seats) seat.handCards.forEach((card) => alive.add(card));
  if (!alive.size) return dead;
  for (const card of table.board) if (!alive.has(card)) dead.add(card);
  for (const seat of table.seats)
    if (seat.handCards.length)
      for (const card of seat.cards) if (!seat.handCards.includes(card)) dead.add(`${seat.index}:${card}`);
  return dead;
}

/** Карта разобранная: чем рисовать и каким цветом. */
export interface CardFace {
  rank: string;
  suit: '♠' | '♥' | '♦' | '♣';
  red: boolean;
}

const SUITS: Record<string, CardFace['suit']> = { s: '♠', h: '♥', d: '♦', c: '♣' };

export function cardFace(card: string): CardFace {
  const rank = card.slice(0, 1).replace('T', '10');
  const suit = SUITS[card.slice(1, 2)] ?? '♠';
  return { rank, suit, red: suit === '♥' || suit === '♦' };
}

/**
 * Кому какая карта прилетает и когда.
 *
 * Сдвиг считается от момента начала раздачи **по серверным часам**, поэтому у всех карты летят
 * одновременно, а тот, кто открыл вкладку в середине раздачи, видит их уже на месте: задержка
 * уходит в минус, и анимация начинается с конца. Это и есть весь секрет синхронности здесь —
 * ни одного сообщения «начать анимацию» в комнату не отправляется.
 */
export function dealDelay(table: PokerTable, seat: PokerSeat, cardIndex: number, serverNow: number): number {
  const order = dealOrder(table);
  const place = order.indexOf(seat.index);
  if (place < 0) return 0;
  const position = place + cardIndex * order.length;
  return position * DEAL_STEP_MS - Math.max(0, serverNow - table.handStartedAt);
}

/** Порядок сдачи: по одной, начиная слева от кнопки — как за настоящим столом. */
export function dealOrder(table: PokerTable): number[] {
  const order: number[] = [];
  for (let step = 1; step <= SEATS; step++) {
    const index = (table.button + step) % SEATS;
    if (table.seats[index]?.inHand) order.push(index);
  }
  return order;
}

/**
 * Кто платит блайнды в этой раздаче.
 *
 * Считается от кнопки, а не берётся из ленты: лента короткая и к риверу забывает начало
 * раздачи, а кнопка и состав играющих известны всегда. Голова к голове малый блайнд платит
 * сама кнопка — это то место в правилах, где все и ошибаются.
 */
export function blindSeats(table: PokerTable): { small: number; big: number } | null {
  const order = dealOrder(table);
  if (order.length < 2) return null;
  if (order.length === 2) return { small: table.button, big: order[0]! };
  return { small: order[0]!, big: order[1]! };
}

/** Идёт ли торговля: по этому решается, показывать ли кнопки и часы. */
export function playing(table: PokerTable): boolean {
  return ['preflop', 'flop', 'turn', 'river'].includes(table.phase);
}

/** Кто за столом прямо сейчас — те, у кого есть фишки и кого не выбило. */
export function players(table: PokerTable): PokerSeat[] {
  return table.seats.filter((seat) => seat.memberId);
}

// --- Честность --------------------------------------------------------------------------

/**
 * Та же тасовка, что и в ядре, — повторённая здесь, чтобы её можно было проверить.
 *
 * Байты берутся из `SHA-256(зерно:счётчик)`, склеенных подряд; перестановка — Фишер-Йетс с
 * конца, очередное число — четыре байта с отбрасыванием неровного хвоста. Слово в слово то же,
 * что в `Cards.java`: если эти двадцать строк разойдутся, проверка начнёт врать — поэтому на
 * них стоит тест с колодой, посчитанной ядром.
 */
export async function shuffle(seed: string): Promise<number[]> {
  const cards = Array.from({ length: 52 }, (_, card) => card);
  const stream = new ByteStream(seed);
  for (let i = 51; i > 0; i--) {
    const j = await stream.below(i + 1);
    const swap = cards[i]!;
    cards[i] = cards[j]!;
    cards[j] = swap;
  }
  return cards;
}

class ByteStream {
  private block = new Uint8Array(0);
  private offset = 0;
  private counter = 0;
  constructor(private seed: string) {}
  private async next(): Promise<number> {
    if (this.offset >= this.block.length) {
      const source = new TextEncoder().encode(`${this.seed}:${this.counter++}`);
      this.block = new Uint8Array(await crypto.subtle.digest('SHA-256', source));
      this.offset = 0;
    }
    return this.block[this.offset++]!;
  }
  async below(bound: number): Promise<number> {
    const limit = 2 ** 32 - (2 ** 32 % bound);
    for (;;) {
      const value =
        (await this.next()) * 2 ** 24 +
        (await this.next()) * 2 ** 16 +
        (await this.next()) * 2 ** 8 +
        (await this.next());
      if (value < limit) return value % bound;
    }
  }
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const RANKS = '23456789TJQKA';
const SUIT_ORDER = 'shdc';

export function cardText(card: number): string {
  if (card < 0 || card > 51) return '??';
  return `${RANKS[Math.floor(card / 4)]}${SUIT_ORDER[card % 4]}`;
}

export type Verdict =
  | { state: 'ok'; cards: number }
  | { state: 'mismatch'; reason: string }
  | { state: 'unavailable'; reason: string };

/**
 * Сошлась ли раздача с обещанием, данным до неё.
 *
 * Перед раздачей стол объявляет `commitment` — отпечаток зерна. После раздачи он показывает
 * само зерно. Здесь из зерна заново собирается колода, из неё — карты в том порядке, в каком
 * они сдавались, и всё это сверяется с тем, что видно на столе. Подменить карту посреди
 * раздачи сервер не может: отпечаток уже у всех на руках, а другое зерно даст другой отпечаток.
 */
export async function verifyDeal(table: PokerTable): Promise<Verdict> {
  if (!table.seed || !table.commitment)
    return { state: 'unavailable', reason: 'Зерно раскрывается, когда раздача сыграна' };
  if ((await sha256(table.seed)) !== table.commitment)
    return { state: 'mismatch', reason: 'Отпечаток зерна не совпал с объявленным до раздачи' };
  const deck = await shuffle(table.seed);
  const order = dealOrder(table);
  if (order.length < 2) return { state: 'unavailable', reason: 'Раздача ещё не начиналась' };
  let checked = 0;
  for (const [place, index] of order.entries()) {
    const seat = table.seats[index];
    if (!seat?.cards.length) continue;
    for (const [card, text] of seat.cards.entries()) {
      const expected = cardText(deck[place + card * order.length] ?? -1);
      if (expected !== text)
        return { state: 'mismatch', reason: `Карта ${text} не та, что следует из зерна` };
      checked++;
    }
  }
  // Борд лежит за картами игроков, и перед каждой улицей сжигается одна карта.
  const afterHoles = order.length * 2;
  const board = [1, 2, 3, 5, 7].map((shift) => deck[afterHoles + shift] ?? -1);
  for (const [index, text] of table.board.entries()) {
    if (cardText(board[index] ?? -1) !== text)
      return { state: 'mismatch', reason: `Карта стола ${text} не та, что следует из зерна` };
    checked++;
  }
  return { state: 'ok', cards: checked };
}
