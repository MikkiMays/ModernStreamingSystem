/**
 * Флаг страны узла (R200, `server-selection.md` §3.5) — рисунок, не эмодзи.
 *
 * Эмодзи-флаги не отображаются системными шрифтами Windows (там вместо флага две буквы), а узлы
 * смотрят в клиенте Windows чаще всего. Поэтому флаг рисуется SVG по коду страны ISO 3166-1 alpha-2:
 * полосы и скандинавский крест покрывают все страны, где у Cord могут стоять узлы; неизвестная страна
 * — две буквы кода на нейтральной плашке, честно и читаемо. Флаг — украшение к названию города рядом
 * (`aria-hidden`); если текста рядом нет, передайте `label`.
 */
import type { CSSProperties } from 'react';

type Stripes = { dir: 'h' | 'v'; colors: string[] };
type Cross = { cross: string; field: string };
type Shape = Stripes | Cross;

/** Цвета — по официальным палитрам, упрощённые до трёх полос. */
const FLAGS: Record<string, Shape> = {
  DE: { dir: 'h', colors: ['#000000', '#DD0000', '#FFCE00'] },
  RU: { dir: 'h', colors: ['#FFFFFF', '#0039A6', '#D52B1E'] },
  NL: { dir: 'h', colors: ['#AE1C28', '#FFFFFF', '#21468B'] },
  AT: { dir: 'h', colors: ['#ED2939', '#FFFFFF', '#ED2939'] },
  EE: { dir: 'h', colors: ['#0072CE', '#000000', '#FFFFFF'] },
  LT: { dir: 'h', colors: ['#FDB913', '#006A44', '#C1272D'] },
  LV: { dir: 'h', colors: ['#9E3039', '#FFFFFF', '#9E3039'] },
  PL: { dir: 'h', colors: ['#FFFFFF', '#DC143C'] },
  UA: { dir: 'h', colors: ['#0057B7', '#FFD700'] },
  BG: { dir: 'h', colors: ['#FFFFFF', '#00966E', '#D62612'] },
  HU: { dir: 'h', colors: ['#CE2939', '#FFFFFF', '#477050'] },
  FR: { dir: 'v', colors: ['#0055A4', '#FFFFFF', '#EF4135'] },
  IT: { dir: 'v', colors: ['#009246', '#FFFFFF', '#CE2B37'] },
  BE: { dir: 'v', colors: ['#000000', '#FDDA24', '#EF3340'] },
  IE: { dir: 'v', colors: ['#169B62', '#FFFFFF', '#FF883E'] },
  FI: { cross: '#002F6C', field: '#FFFFFF' },
  SE: { cross: '#FECC02', field: '#006AA7' },
  NO: { cross: '#BA0C2F', field: '#FFFFFF' },
  DK: { cross: '#FFFFFF', field: '#C8102E' },
};

export interface FlagProps {
  /** ISO 3166-1 alpha-2: `DE`, `FI`, `RU`. Пусто или неизвестно — плашка с буквами. */
  country?: string | null;
  /** Подпись для диктора, когда рядом нет названия; без неё флаг — украшение. */
  label?: string;
  className?: string;
  style?: CSSProperties;
}

const W = 20;
const H = 14;

export function Flag({ country, label, className, style }: FlagProps) {
  const code = (country ?? '').trim().toUpperCase();
  const shape = FLAGS[code];
  const a11y = label ? { role: 'img' as const, 'aria-label': label } : { 'aria-hidden': true as const };
  const classes = ['ui-flag', className].filter(Boolean).join(' ');
  if (!shape) {
    return (
      <span className={classes} data-country={code || undefined} data-fallback="" style={style} {...a11y}>
        {code.slice(0, 2) || '·'}
      </span>
    );
  }
  return (
    <svg
      className={classes}
      data-country={code}
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      style={style}
      focusable="false"
      {...a11y}
    >
      {'cross' in shape ? (
        <>
          <rect width={W} height={H} fill={shape.field} />
          {/* Скандинавский крест: вертикаль ближе к древку, как у всех четырёх. */}
          <rect x={6} y={0} width={3.5} height={H} fill={shape.cross} />
          <rect x={0} y={5.25} width={W} height={3.5} fill={shape.cross} />
        </>
      ) : (
        shape.colors.map((color, i) =>
          shape.dir === 'h' ? (
            <rect
              key={i}
              x={0}
              y={(H / shape.colors.length) * i}
              width={W}
              height={H / shape.colors.length}
              fill={color}
            />
          ) : (
            <rect
              key={i}
              x={(W / shape.colors.length) * i}
              y={0}
              width={W / shape.colors.length}
              height={H}
              fill={color}
            />
          ),
        )
      )}
    </svg>
  );
}

/** Есть ли у страны рисунок (для тестов и витрины). */
export const knownFlag = (country: string | null | undefined) => !!FLAGS[(country ?? '').toUpperCase()];
