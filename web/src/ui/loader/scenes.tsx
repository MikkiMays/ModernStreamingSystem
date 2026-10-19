import type { CSSProperties } from 'react';

/** Пользовательские свойства CSS как `style`: у `CSSProperties` для них нет имён. */
const cssVars = (values: Record<string, string | number>) => values as unknown as CSSProperties;

/**
 * Сцены загрузки. Каждая — данные плюс общие кадры из `loader.css`; новых зависимостей нет.
 * Разметка сцены марки повторяется в `index.html` дословно (сверяет `loader.test.ts`).
 */

/** Полосы знака как в `AppIcon` (квадрат 48, полосы в 30): плита занимает 60 % сцены,
    поэтому левый край = 20 % + 0,6·(9 + x)/48, высота = 0,6·h/48, ширина 7,5 %. */
export const CORD_BARS = [
  { i: 0, x: '33.75%', h: '22.5%' },
  { i: 1, x: '46.25%', h: '36.25%' },
  { i: 2, x: '58.75%', h: '27.5%' },
] as const;

export function CordScene() {
  return (
    <div className="fl__scene fl-cord">
      <i className="fl__shadow" />
      <i className="fl-cord__plate" />
      {CORD_BARS.map((bar) => (
        <i
          key={bar.i}
          className="fl-cord__bar"
          style={cssVars({ '--i': bar.i, '--x': bar.x, '--h': bar.h })}
        />
      ))}
    </div>
  );
}

export type Deck = 'poker' | 'durak';

const DECKS: Record<Deck, { rank: string; suit: string }[]> = {
  poker: [
    { rank: 'A', suit: '♠' },
    { rank: 'J', suit: '♠' },
    { rank: 'Q', suit: '♥' },
    { rank: 'K', suit: '♣' },
    { rank: '10', suit: '♦' },
    { rank: 'A', suit: '♥' },
    { rank: '9', suit: '♣' },
  ],
  durak: [
    { rank: '6', suit: '♠' },
    { rank: '9', suit: '♥' },
    { rank: 'Q', suit: '♣' },
    { rank: 'K', suit: '♦' },
    { rank: 'A', suit: '♠' },
    { rank: '7', suit: '♥' },
    { rank: 'J', suit: '♦' },
  ],
};

/** Семь карт: откуда взлетает (`x0`), куда (`x1`, `y1`), повороты и место в веере покоя. */
const FLIGHTS = [
  {
    '--x0': '-96px',
    '--x1': '-70px',
    '--y1': '-120px',
    '--r0': '-24deg',
    '--r1': '-8deg',
    '--fx': '-84px',
    '--fr': '-28deg',
  },
  {
    '--x0': '-64px',
    '--x1': '-40px',
    '--y1': '-140px',
    '--r0': '-14deg',
    '--r1': '4deg',
    '--fx': '-56px',
    '--fr': '-18deg',
  },
  {
    '--x0': '-32px',
    '--x1': '-10px',
    '--y1': '-150px',
    '--r0': '-6deg',
    '--r1': '10deg',
    '--fx': '-28px',
    '--fr': '-8deg',
  },
  {
    '--x0': '0px',
    '--x1': '14px',
    '--y1': '-156px',
    '--r0': '2deg',
    '--r1': '-6deg',
    '--fx': '0px',
    '--fr': '2deg',
  },
  {
    '--x0': '32px',
    '--x1': '40px',
    '--y1': '-146px',
    '--r0': '10deg',
    '--r1': '18deg',
    '--fx': '28px',
    '--fr': '12deg',
  },
  {
    '--x0': '64px',
    '--x1': '70px',
    '--y1': '-132px',
    '--r0': '18deg',
    '--r1': '-4deg',
    '--fx': '56px',
    '--fr': '22deg',
  },
  {
    '--x0': '96px',
    '--x1': '92px',
    '--y1': '-116px',
    '--r0': '26deg',
    '--r1': '12deg',
    '--fx': '84px',
    '--fr': '32deg',
  },
] as const;

function CardBack() {
  return (
    <svg viewBox="0 0 30 30" aria-hidden="true" focusable="false">
      <g fill="currentColor">
        <rect x="2" y="6" width="6" height="18" rx="3" transform="rotate(-15 5 15)" />
        <rect x="12" y="0.5" width="6" height="29" rx="3" transform="rotate(-15 15 15)" />
        <rect x="22" y="4" width="6" height="22" rx="3" transform="rotate(-15 25 15)" />
      </g>
    </svg>
  );
}

export function CardsScene({ deck = 'poker' }: { deck?: Deck }) {
  return (
    <div className="fl__scene fl-cards">
      <i className="fl__shadow" />
      {FLIGHTS.map((flight, i) => {
        const card = DECKS[deck][i]!;
        const red = card.suit === '♥' || card.suit === '♦';
        return (
          <div key={i} className="fl-card" style={cssVars({ '--i': i, ...flight })}>
            <span className="fl-card__face" data-red={red || undefined}>
              {card.rank}
              {card.suit}
            </span>
            <span className="fl-card__back">
              <CardBack />
            </span>
          </div>
        );
      })}
    </div>
  );
}
