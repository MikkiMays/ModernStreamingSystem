import type { CSSProperties } from 'react';
import { DOT_PATH, WORD_PATH, WORD_RIGHT } from './wordmark-paths';
import './brand.css';

/**
 * Марка Cord — рисунок, а не текст (T24): три полосы под −15° и слово «cord.», обведённое из Inter
 * Variable (`web/scripts/brand/wordmark.py`). Пропорции — прежнего текстового логотипа: знак 30 px,
 * 13 px до слова, базовая линия на 25.5 px, — поэтому замена ничего не сдвигает.
 *
 * Цвета берутся из токенов: полосы и точка — `--brand-accent`, слово — цвет текста вокруг.
 */

/** Полосы знака в квадрате 30×30: левый край, высота; ширина 6, центр по вертикали — 15. */
const BARS = [
  { x: 2, height: 18 },
  { x: 12, height: 29 },
  { x: 22, height: 22 },
] as const;

function Bars({ fill }: { fill: string }) {
  return (
    <g fill={fill}>
      {BARS.map(({ x, height }) => (
        <rect
          key={x}
          x={x}
          y={15 - height / 2}
          width={6}
          height={height}
          rx={3}
          transform={`rotate(-15 ${x + 3} 15)`}
        />
      ))}
    </g>
  );
}

/** Знак без слова: шапки на телефоне, значки, кнопки. */
export function CordMark({ size = 30, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 30 30"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <Bars fill="var(--brand-accent, currentColor)" />
    </svg>
  );
}

const WORD_WIDTH = Math.ceil(WORD_RIGHT) - 43;

/** Слово «cord.» той же высоты строки, что и знак. */
export function CordWordmark({ height = 30, className }: { height?: number; className?: string }) {
  return (
    <svg
      className={className}
      viewBox={`43 0 ${WORD_WIDTH} 30`}
      height={height}
      width={(height * WORD_WIDTH) / 30}
      aria-hidden="true"
      focusable="false"
    >
      <path d={WORD_PATH} fill="currentColor" />
      <path d={DOT_PATH} fill="var(--brand-accent, currentColor)" />
    </svg>
  );
}

/**
 * Логотип целиком: знак и слово. Это два рисунка, а не один, чтобы узкий экран мог спрятать
 * слово правилом CSS (`.brand-word`), не перерисовывая знак. Для чтения с экрана — одно имя.
 * Размер задаёт CSS (`--brand-h` у `.brand`); `height` — только для мест вне общих правил.
 */
export function Logo({ height, className }: { height?: number; className?: string }) {
  return (
    <span
      className={className ? `brand ${className}` : 'brand'}
      role="img"
      aria-label="Cord"
      style={height === undefined ? undefined : ({ '--brand-h': `${height}px` } as CSSProperties)}
    >
      <svg className="brand-mark" viewBox="0 0 30 30" aria-hidden="true" focusable="false">
        <Bars fill="var(--brand-accent, currentColor)" />
      </svg>
      <svg className="brand-word" viewBox={`43 0 ${WORD_WIDTH} 30`} aria-hidden="true" focusable="false">
        <path d={WORD_PATH} fill="currentColor" />
        <path d={DOT_PATH} fill="var(--brand-accent, currentColor)" />
      </svg>
    </span>
  );
}

/**
 * Значок приложения: белые полосы на плитке акцентного цвета — как `Cord.ico`, иконки PWA и
 * установщика. Рисуется, а не грузится: чёткий в любом размере и без второго запроса.
 */
export function AppIcon({ size = 64 }: { size?: number }) {
  return (
    <svg
      className="app-icon"
      viewBox="0 0 48 48"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <rect width="48" height="48" rx="11" fill="var(--brand-accent, #3564f3)" />
      <g transform="translate(9 9)">
        <Bars fill="#fff" />
      </g>
    </svg>
  );
}
