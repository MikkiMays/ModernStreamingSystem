import type { DurakTable } from '../api/types';
import { sha256 } from './poker';

/**
 * Стол дурака, посчитанный до того, как его нарисовали.
 *
 * Здесь нет ни одного правила игры — они на сервере, и второй их копии быть не должно. Больше
 * того: у дурака сервер присылает не только законные действия, но и **законные карты** (`you.attacks`,
 * `you.beats`, `you.transfers`), поэтому здесь нет даже вопроса «бьёт ли дама валета».
 *
 * Остаётся только то, что нужно, чтобы показать: где чьё место на овале, под каким углом лежит
 * карта в веере, сколько осталось на ход и как назвать то, что произошло.
 */
export const SEATS = 6;

/** Сколько летят карты при раздаче. То же число, что в ядре: `Durak.DEAL_MS`. */
export const DEAL_MS = 1400;

/** Задержка между картами при раздаче: по ней и читается, что их раздают по одной. */
export const DEAL_STEP_MS = 70;

/** Сколько закончившийся бой лежит на столе. То же число, что в ядре: `Durak.BOUT_MS`. */
export const BOUT_MS = 1300;

export type SeatSide = 'bottom' | 'left' | 'right' | 'top';

export interface SeatSpot {
  index: number;
  /** Позиция на овале в процентах ширины и высоты стола. */
  x: number;
  y: number;
  side: SeatSide;
  /** Место зрителя всегда внизу: 0 — оно и есть. */
  slot: number;
}

/**
 * Где какое место.
 *
 * ДУГА, А НЕ ОВАЛ, И ЭТО ГЛАВНОЕ ОТЛИЧИЕ ОТ ПОКЕРА. За покерным столом своё место такой же стул
 * на овале, как остальные. В дураке своё место — это рука: шесть карт веером, которые занимают
 * всю нижнюю полосу. Посадить туда ещё и кружок с собственным лицом значит наложить его на свои
 * же карты — ровно это и случилось в первой версии: лицо уезжало за край сукна, а имя обрезалось.
 *
 * Поэтому остальные садятся дугой над столом — слева, через верх, направо, — а низ отдан руке.
 * Место {@code slot 0} (своё) уводится за нижний край: его рисует не сукно, а полоса под столом.
 *
 * Зритель, который не сидит, видит всех шестерых на той же дуге: прятать от него нижнее место
 * было бы враньём — оно занято, просто не им.
 */
export function seatLayout(mySeat: number | null, seats = SEATS): SeatSpot[] {
  const seated = mySeat !== null;
  const anchor = mySeat ?? 0;
  const places = seated ? seats - 1 : seats;
  return Array.from({ length: seats }, (_, index) => {
    const slot = (index - anchor + seats) % seats;
    if (seated && slot === 0) return { index, x: 50, y: 104, side: 'bottom' as const, slot };
    const step = seated ? slot - 1 : slot;
    const share = places === 1 ? 0.5 : step / (places - 1);
    const angle = Math.PI * (1 - share);
    const x = 50 + 30 * Math.cos(angle);
    /*
      Число — это ВЕРХ места, а не его середина.

      Место выше карты: кружок, имя, роль и рубашки. Считая от середины, верхний игрок дуги
      уезжал шапкой за край сукна, а крайние ложились на колоду. От верха это считается один
      раз и одинаково для всех шестерых.
    */
    const y = 22 - 18 * Math.sin(angle);
    const side: SeatSide = share < 0.28 ? 'left' : share > 0.72 ? 'right' : 'top';
    return { index, x, y, side, slot };
  });
}

/**
 * Под каким углом лежит карта в веере и насколько она приподнята.
 *
 * Веер, а не ряд, и это не украшение: шесть карт в ряд читаются как панель кнопок, а веер — как
 * рука. Угол растёт от середины к краям, подъём — наоборот: середина веера выше краёв, ровно как
 * у карт, зажатых в пальцах.
 *
 * Разворот сужается, когда карт много: тринадцать карт с тем же шагом уехали бы за край стола.
 */
export function fanAngle(index: number, count: number): { angle: number; lift: number } {
  if (count <= 1) return { angle: 0, lift: 0 };
  const spread = Math.min(46, count * 7);
  const step = spread / (count - 1);
  const angle = -spread / 2 + index * step;
  const middle = (count - 1) / 2;
  const away = Math.abs(index - middle) / middle;
  return { angle, lift: Math.round((1 - away * away) * 14) };
}

const SUITS: Record<string, { glyph: string; red: boolean; name: string }> = {
  s: { glyph: '♠', red: false, name: 'пики' },
  h: { glyph: '♥', red: true, name: 'черви' },
  d: { glyph: '♦', red: true, name: 'бубны' },
  c: { glyph: '♣', red: false, name: 'трефы' },
};

const RANKS: Record<string, string> = {
  T: '10',
  J: 'В',
  Q: 'Д',
  K: 'К',
  A: 'Т',
};

export interface CardFace {
  /** Номинал так, как его читают вслух по-русски: `В`, `Д`, `К`, `Т`, `10`, `6`. */
  rank: string;
  suit: string;
  glyph: string;
  red: boolean;
  /** Как карту называют голосом — для экранных читалок. */
  label: string;
}

/** Карта из провода (`As`, `7h`) в то, что рисуется и читается. */
export function faceOf(card: string): CardFace {
  const rank = card.charAt(0);
  const suit = SUITS[card.charAt(1)] ?? SUITS.s!;
  const shown = RANKS[rank] ?? rank;
  const spoken =
    rank === 'T'
      ? 'десятка'
      : rank === 'J'
        ? 'валет'
        : rank === 'Q'
          ? 'дама'
          : rank === 'K'
            ? 'король'
            : rank === 'A'
              ? 'туз'
              : shown;
  return {
    rank: shown,
    suit: card.charAt(1),
    glyph: suit.glyph,
    red: suit.red,
    label: `${spoken}, ${suit.name}`,
  };
}

/** Козырь этой раздачи одной буквой масти — для подписи «козыри бубны». */
export function trumpName(table: DurakTable): string {
  const suit = table.trumpSuit ? SUITS[table.trumpSuit] : undefined;
  return suit ? suit.name : '';
}

/** Число со словом по русскому счёту. То же правило, что в `core/poker.ts`. */
export function plural(count: number, one: string, few: string, many: string): string {
  const tail = count % 10;
  const teen = count % 100;
  if (teen >= 11 && teen <= 14) return `${count} ${many}`;
  if (tail === 1) return `${count} ${one}`;
  if (tail >= 2 && tail <= 4) return `${count} ${few}`;
  return `${count} ${many}`;
}

/** Как называется вариант правил. */
export function modeName(mode: DurakTable['mode']): string {
  return mode === 'perevodnoy' ? 'Переводной' : 'Подкидной';
}

/**
 * Что стол говорит прямо сейчас, одной строкой.
 *
 * ОДНА СТРОКА, А НЕ ТРИ ФЛАГА НА ЭКРАНЕ. «Кто ходит», «что от него ждут» и «чем кончился бой» —
 * это один вопрос, который задают, подняв глаза от своих карт. Ответ собирается из снимка, и
 * решает его сервер: здесь только слова.
 */
export function tableSays(table: DurakTable, mySeat: number | null): string {
  if (table.phase === 'lobby') return 'Стол ждёт раздачи';
  if (table.phase === 'over') {
    if (table.result?.draw) return 'Ничья — карт не осталось ни у кого';
    return table.result ? `${table.result.foolName} — дурак` : 'Партия сыграна';
  }
  if (table.boutEnd === 'taken') {
    const taker = table.seats[table.defender]?.name ?? '';
    return `${taker} забирает`;
  }
  if (table.boutEnd === 'beaten') return 'Бито';
  const waiting = table.acting;
  if (!waiting.length) return 'Стол раздаёт';
  if (mySeat !== null && waiting.includes(mySeat)) {
    if (mySeat === table.defender && !table.taking) return 'Ваш ход: отбивайтесь или берите';
    return table.table.length ? 'Ваш ход: подкиньте или скажите «бито»' : 'Ваш ход: заходите';
  }
  const names = waiting.map((index) => table.seats[index]?.name).filter(Boolean);
  if (!names.length) return 'Стол думает';
  if (waiting.length === 1 && waiting[0] === table.defender) return `${names[0]} отбивается`;
  return names.length === 1 ? `Ждём ${names[0]}` : `Подкидывают: ${names.join(', ')}`;
}

/** Сколько ещё карт влезает в бой. Ноль — больше ничего не подкинуть. */
export function roomLeft(table: DurakTable): number {
  return Math.max(0, table.limit - table.table.length);
}

export type Verdict =
  | { state: 'ok'; cards: number }
  | { state: 'mismatch'; reason: string }
  | { state: 'unavailable'; reason: string };

/**
 * Сошлась ли раздача с обещанием, данным до неё.
 *
 * То же самое, что у покера, и намеренно теми же десятью строками: стол объявляет отпечаток
 * зерна до раздачи и раскрывает зерно, когда партия сыграна. Здесь колода собирается заново и
 * сверяется с козырной картой — единственным, что видно всем и на что нельзя повлиять по ходу
 * игры. Чужих карт в браузере нет, поэтому проверять по ним нечего, а козыря достаточно:
 * подменить его значило бы подменить и зерно, а отпечаток уже у всех на руках.
 */
export async function verifyDeal(table: DurakTable): Promise<Verdict> {
  if (!table.seed || !table.commitment)
    return { state: 'unavailable', reason: 'Зерно раскрывается, когда партия сыграна' };
  if ((await sha256(table.seed)) !== table.commitment)
    return { state: 'mismatch', reason: 'Отпечаток зерна не совпал с объявленным до раздачи' };
  if (!table.trump) return { state: 'unavailable', reason: 'Раздача ещё не начиналась' };
  const deck = await shuffle(table.seed, table.deckSize);
  const bottom = deck[deck.length - 1];
  if (bottom === undefined || cardText(bottom) !== table.trump)
    return { state: 'mismatch', reason: `Козырь ${table.trump} не тот, что следует из зерна` };
  return { state: 'ok', cards: deck.length };
}

const RANK_ORDER = '23456789TJQKA';
const SUIT_ORDER = 'shdc';

export function cardText(card: number): string {
  if (card < 0 || card > 51) return '??';
  return `${RANK_ORDER[Math.floor(card / 4)]}${SUIT_ORDER[card % 4]}`;
}

/**
 * Та же тасовка, что в ядре, — для колоды любой длины.
 *
 * Повторена слово в слово с `Cards.shuffle`: Фишер-Йетс с конца, поток байт из `SHA-256(зерно:N)`,
 * отбрасывание неровного хвоста. Разойдись эти две реализации — проверка честности начала бы
 * врать, а не молчать, поэтому на их совпадение стоит тест.
 */
export async function shuffle(seed: string, size: number): Promise<number[]> {
  const skip = (52 - size) / 4;
  const cards = Array.from({ length: size }, (_, index) => skip * 4 + index);
  const stream = new ByteStream(seed);
  for (let i = cards.length - 1; i > 0; i--) {
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
