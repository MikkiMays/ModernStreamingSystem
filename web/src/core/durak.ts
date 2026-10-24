import type { DurakTable } from '../api/types';
import type { Translate } from '../i18n';
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
 * РОВНЫЙ ОВАЛ, ШЕСТЬ ШАГОВ ПО ШЕСТЬДЕСЯТ ГРАДУСОВ. Здесь была дуга над столом — она освобождала
 * низ под руку, но делала стол несимметричным: четверо сидели тесно наверху, а половина сукна
 * пустовала. Теперь места стоят так, как стоят стулья: через равные промежутки по всему кругу.
 *
 * СВОЁ МЕСТО — ВСЕГДА ВНИЗУ. За настоящим столом человек сидит на своём стуле, а не смотрит на
 * себя со стороны. Оно поджато к центру: под ним лежит веер, и кружок с лицом не должен
 * оказаться под собственными картами.
 */
export function seatLayout(mySeat: number | null, seats = SEATS): SeatSpot[] {
  const anchor = mySeat ?? 0;
  return Array.from({ length: seats }, (_, index) => {
    const slot = (index - anchor + seats) % seats;
    const angle = Math.PI / 2 + (slot * 2 * Math.PI) / seats;
    const reach = slot === 0 ? 0.55 : 1;
    const x = 50 + 43 * Math.cos(angle);
    const y = 50 + 42 * Math.sin(angle) * reach;
    const sin = Math.sin(angle);
    const cos = Math.cos(angle);
    const side: SeatSide = sin > 0.5 ? 'bottom' : sin < -0.5 ? 'top' : cos > 0 ? 'right' : 'left';
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

type Suit = 's' | 'h' | 'd' | 'c';

const SUITS: Record<Suit, { glyph: string; red: boolean }> = {
  s: { glyph: '♠', red: false },
  h: { glyph: '♥', red: true },
  d: { glyph: '♦', red: true },
  c: { glyph: '♣', red: false },
};

function isSuit(suit: string): suit is Suit {
  return suit in SUITS;
}

/** Старшие карты: буква на лице и имя вслух — из каталога (`durak.ranks`, `durak.spoken`). */
type Face = 'J' | 'Q' | 'K' | 'A';

function isFace(rank: string): rank is Face {
  return rank === 'J' || rank === 'Q' || rank === 'K' || rank === 'A';
}

export interface CardFace {
  /** Номинал так, как его читают вслух на языке каталога: по-русски `В`, `Д`, `К`, `Т`, `10`, `6`. */
  rank: string;
  suit: string;
  glyph: string;
  red: boolean;
  /** Как карту называют голосом — для экранных читалок. */
  label: string;
}

/** Карта из провода (`As`, `7h`) в то, что рисуется и читается. */
export function faceOf(t: Translate, card: string): CardFace {
  const rank = card.charAt(0);
  const code = card.charAt(1);
  const suit: Suit = isSuit(code) ? code : 's';
  const shown = isFace(rank) ? t(($) => $.durak.ranks[rank]) : rank === 'T' ? '10' : rank;
  const spoken = isFace(rank) || rank === 'T' ? t(($) => $.durak.spoken[rank]) : shown;
  return {
    rank: shown,
    suit: code,
    glyph: SUITS[suit].glyph,
    red: SUITS[suit].red,
    label: t(($) => $.durak.cardLabel, { rank: spoken, suit: t(($) => $.durak.suits[suit]) }),
  };
}

/** Козырь этой раздачи одной буквой масти — для подписи «козыри бубны». */
export function trumpName(t: Translate, table: DurakTable): string {
  const suit = table.trumpSuit;
  return suit && isSuit(suit) ? t(($) => $.durak.suits[suit]) : '';
}

/** Как называется вариант правил. */
export function modeName(t: Translate, mode: DurakTable['mode']): string {
  return mode === 'perevodnoy' ? t(($) => $.durak.modes.perevodnoy) : t(($) => $.durak.modes.podkidnoy);
}

/**
 * Что стол говорит прямо сейчас, одной строкой.
 *
 * ОДНА СТРОКА, А НЕ ТРИ ФЛАГА НА ЭКРАНЕ. «Кто ходит», «что от него ждут» и «чем кончился бой» —
 * это один вопрос, который задают, подняв глаза от своих карт. Ответ собирается из снимка, и
 * решает его сервер: здесь только слова.
 */
export function tableSays(t: Translate, table: DurakTable, mySeat: number | null): string {
  if (table.phase === 'lobby') return t(($) => $.durak.says.lobby);
  if (table.phase === 'over') {
    // Ничьей нет (R111): у каждой партии есть дурак. Без имени — только запись прежнего ядра.
    return table.result?.foolName
      ? t(($) => $.durak.fool, { name: table.result.foolName })
      : t(($) => $.durak.says.over);
  }
  if (table.boutEnd === 'taken') {
    const taker = table.seats[table.defender]?.name ?? '';
    return t(($) => $.durak.says.taken, { name: taker });
  }
  if (table.boutEnd === 'beaten') return t(($) => $.durak.says.beaten);
  const waiting = table.acting;
  if (!waiting.length) return t(($) => $.durak.says.dealing);
  /*
    Здесь нет «нечем отбиться» и «нечего подкинуть» (R108, отменило T07): стол не рассказывает,
    что у кого в руке. Ждут всех, от кого ждут, — и называет он их всех одинаково.
  */
  if (mySeat !== null && waiting.includes(mySeat)) {
    if (mySeat === table.defender && !table.taking) return t(($) => $.durak.says.defend);
    return table.table.length ? t(($) => $.durak.says.throw) : t(($) => $.durak.says.lead);
  }
  const names = waiting.map((index) => table.seats[index]?.name).filter(Boolean);
  if (!names.length) return t(($) => $.durak.says.thinking);
  if (waiting.length === 1 && waiting[0] === table.defender)
    return t(($) => $.durak.says.defends, { name: names[0] });
  return names.length === 1
    ? t(($) => $.durak.says.waiting, { name: names[0] })
    : t(($) => $.durak.says.throwing, { names: names.join(', ') });
}

/** Сколько ещё карт влезает в бой. Ноль — больше ничего не подкинуть. */
export function roomLeft(table: DurakTable): number {
  return Math.max(0, table.limit - table.table.length);
}

/**
 * Куда карту уронили.
 *
 * ЖЕСТ РЕШАЕТ, ЧТО ЗА ХОД, И БОЛЬШЕ НИЧЕГО. Уронил на карту противника — значит бьёшь именно её;
 * уронил на сукно — значит кладёшь новую. Это единственное, что браузер знает о ходе: законен ли
 * он, решает сервер, и узнаём мы об этом, отпустив карту.
 */
export type Drop = { kind: 'beat'; under: string } | { kind: 'table' } | null;

/** Разобрать точку броска: ближайшая зона сброса вверх по дереву. */
export function dropFrom(element: Element | null | undefined): Drop {
  const zone = element?.closest?.('[data-drop]') as HTMLElement | null | undefined;
  if (!zone) return null;
  if (zone.dataset.drop === 'pair') {
    const under = zone.dataset.under;
    return under ? { kind: 'beat', under } : null;
  }
  return zone.dataset.drop === 'table' ? { kind: 'table' } : null;
}

/**
 * Во что превращается бросок: слово команды и карта, которую бьют.
 *
 * Защитник, бросающий на сукно, — это перевод; все остальные — заход или подкидывание, и стол
 * различает их сам. Незаконный ход здесь не отсеивается: он уходит на сервер и возвращается
 * отказом, а карта — в руку.
 */
export function commandFor(drop: Drop, defending: boolean): { option: string; under?: string } | null {
  if (!drop) return null;
  if (drop.kind === 'beat') return { option: 'beat', under: drop.under };
  return { option: defending ? 'transfer' : 'attack' };
}

/** Итог проверки. Причина — код, а не текст: слова к ней подбирает {@link verdictReason}. */
export type Verdict =
  | { state: 'ok'; cards: number }
  | { state: 'mismatch'; reason: 'commitment' }
  | { state: 'mismatch'; reason: 'trump'; card: string }
  | { state: 'unavailable'; reason: 'unrevealed' | 'notStarted' };

/** Почему проверка не сошлась или ещё невозможна — словами. */
export function verdictReason(t: Translate, verdict: Exclude<Verdict, { state: 'ok' }>): string {
  if (verdict.reason === 'trump') return t(($) => $.durak.verdict.trump, { card: verdict.card });
  return t(($) => $.durak.verdict[verdict.reason]);
}

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
  if (!table.seed || !table.commitment) return { state: 'unavailable', reason: 'unrevealed' };
  if ((await sha256(table.seed)) !== table.commitment) return { state: 'mismatch', reason: 'commitment' };
  if (!table.trump) return { state: 'unavailable', reason: 'notStarted' };
  const deck = await shuffle(table.seed, table.deckSize);
  const bottom = deck[deck.length - 1];
  if (bottom === undefined || cardText(bottom) !== table.trump)
    return { state: 'mismatch', reason: 'trump', card: table.trump };
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
