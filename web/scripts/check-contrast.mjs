#!/usr/bin/env node
/**
 * Контраст токенов по WCAG 2.2 AA в обеих темах и на медиасцене.
 *
 * Читает `src/styles/tokens.css`, собирает значения каждой темы, разворачивает `var()` и
 * считает контраст пар «текст — фон» (нужно ≥ 4,5) и «элемент управления — фон» (≥ 3).
 * Полупрозрачные цвета накладываются на фон. Любое нарушение — ненулевой код выхода.
 *
 *   node scripts/check-contrast.mjs          — таблица и итог
 *   node scripts/check-contrast.mjs --quiet  — только нарушения
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const TOKENS_PATH = join(fileURLToPath(import.meta.url), '..', '..', 'src', 'styles', 'tokens.css');

/** Объявления `--имя: значение` из всех блоков, чей селектор проходит фильтр. */
export function declarations(css, matches) {
  const vars = {};
  const block = /([^{}]+)\{([^{}]*)\}/g;
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const [, selector, body] of plain.matchAll(block)) {
    if (!matches(selector.trim())) continue;
    for (const line of body.split(';')) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const name = line.slice(0, i).trim();
      // Многострочные значения (тени) сравниваются без оглядки на отступы.
      if (name.startsWith('--'))
        vars[name] = line
          .slice(i + 1)
          .replace(/\s+/g, ' ')
          .trim();
    }
  }
  return vars;
}

/** Значения темы: сырые и шкалы из `:root`, смысловые из блока темы, компонентные из `:root`. */
export function theme(css, name) {
  // `:root` и всё, что объявлено вместе с ним (`:root,\n[data-theme='light']`, блок прежних имён).
  const root = declarations(css, (s) => s === ':root' || s.startsWith(':root,'));
  if (name === 'light') return root;
  const dark = { ...root, ...declarations(css, (s) => s === "[data-theme='dark']") };
  if (name === 'dark') return dark;
  if (name === 'stage') return { ...dark, ...declarations(css, (s) => s === '.media-stage') };
  throw new Error(`unknown theme ${name}`);
}

export function resolve(vars, value, depth = 0) {
  if (depth > 20) throw new Error(`cycle in ${value}`);
  return value.replace(/var\((--[\w-]+)(?:,\s*([^)]+))?\)/g, (_, name, fallback) => {
    const next = vars[name] ?? fallback;
    if (next === undefined) throw new Error(`unknown token ${name}`);
    return resolve(vars, next, depth + 1);
  });
}

/** Цвет → [r, g, b, a] в 0..1. Понимает #rgb, #rrggbb, #rrggbbaa и rgb(r g b / a). */
export function parse(value) {
  const v = value.trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(v);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    const n = parseInt(h, 16);
    if (h.length === 6) return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
    return [(n >>> 24) / 255, ((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)\s*(?:[/,]\s*([\d.]+%?))?\s*\)$/.exec(v);
  if (rgb) {
    const a = rgb[4] === undefined ? 1 : rgb[4].endsWith('%') ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4]);
    return [+rgb[1] / 255, +rgb[2] / 255, +rgb[3] / 255, a];
  }
  throw new Error(`not a colour: ${value}`);
}

const over = ([r, g, b, a], [br, bg, bb]) => [
  r * a + br * (1 - a),
  g * a + bg * (1 - a),
  b * a + bb * (1 - a),
  1,
];
const channel = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

/** Контраст переднего цвета над фоном; полупрозрачный передний цвет накладывается на фон. */
export function contrast(fg, bg) {
  const back = parse(bg);
  const front = over(parse(fg), back);
  const [l1, l2] = [luminance(front), luminance(back)].sort((a, b) => b - a);
  return (l1 + 0.05) / (l2 + 0.05);
}

/** Пары: [передний, фон, порог]. Текст — 4,5; элементы управления и кольца — 3. */
export const PAIRS = {
  light: [
    ['--text', '--bg', 4.5],
    ['--text', '--surface-1', 4.5],
    ['--text', '--surface-2', 4.5],
    ['--text', '--surface-3', 4.5],
    ['--text', '--accent-soft', 4.5],
    ['--text-secondary', '--bg', 4.5],
    ['--text-secondary', '--surface-1', 4.5],
    ['--text-secondary', '--surface-2', 4.5],
    ['--muted', '--bg', 4.5],
    ['--muted', '--surface-1', 4.5],
    ['--muted', '--surface-2', 4.5],
    // Меню, тосты и поднятые карточки — на `--surface-3`, подписи в них приглушённые.
    ['--muted', '--surface-3', 4.5],
    ['--accent', '--bg', 4.5],
    ['--accent', '--surface-1', 4.5],
    ['--accent', '--surface-2', 4.5],
    ['--accent', '--accent-soft', 4.5],
    ['--on-accent', '--accent-fill', 4.5],
    ['--on-accent', '--accent-fill-hover', 4.5],
    ['--on-accent', '--accent-fill-active', 4.5],
    ['--danger', '--bg', 4.5],
    ['--danger', '--surface-1', 4.5],
    ['--danger', '--danger-soft', 4.5],
    ['--on-danger', '--danger-fill', 4.5],
    ['--on-danger', '--danger-fill-hover', 4.5],
    ['--success', '--bg', 4.5],
    ['--success', '--surface-1', 4.5],
    ['--warning', '--bg', 4.5],
    ['--warning', '--surface-1', 4.5],
    ['--accent-fill', '--bg', 3],
    ['--accent-fill', '--surface-1', 3],
    ['--accent', '--bg', 3],
    ['--accent', '--surface-2', 3],
    ['--handle', '--surface-1', 3],
    ['--on-live', '--live', 4.5],
  ],
  dark: [
    ['--text', '--bg', 4.5],
    ['--text', '--surface-1', 4.5],
    ['--text', '--surface-2', 4.5],
    ['--text', '--surface-3', 4.5],
    ['--text', '--accent-soft', 4.5],
    ['--text-secondary', '--bg', 4.5],
    ['--text-secondary', '--surface-1', 4.5],
    ['--text-secondary', '--surface-2', 4.5],
    ['--muted', '--bg', 4.5],
    ['--muted', '--surface-1', 4.5],
    ['--muted', '--surface-2', 4.5],
    // Меню, тосты и поднятые карточки — на `--surface-3`, подписи в них приглушённые.
    ['--muted', '--surface-3', 4.5],
    ['--accent', '--bg', 4.5],
    ['--accent', '--surface-1', 4.5],
    ['--accent', '--surface-2', 4.5],
    ['--accent', '--accent-soft', 4.5],
    ['--on-accent', '--accent-fill', 4.5],
    ['--on-accent', '--accent-fill-hover', 4.5],
    ['--on-accent', '--accent-fill-active', 4.5],
    ['--danger', '--bg', 4.5],
    ['--danger', '--surface-1', 4.5],
    ['--danger', '--danger-soft', 4.5],
    ['--on-danger', '--danger-fill', 4.5],
    ['--on-danger', '--danger-fill-hover', 4.5],
    ['--success', '--bg', 4.5],
    ['--success', '--surface-1', 4.5],
    ['--warning', '--bg', 4.5],
    ['--warning', '--surface-1', 4.5],
    ['--accent-fill', '--bg', 3],
    ['--accent-fill', '--surface-1', 3],
    ['--accent', '--bg', 3],
    ['--accent', '--surface-2', 3],
    ['--handle', '--surface-1', 3],
    ['--on-live', '--live', 4.5],
  ],
  stage: [
    ['--text', '--bg', 4.5],
    ['--text', '--surface-1', 4.5],
    ['--text', '--surface-2', 4.5],
    ['--muted', '--bg', 4.5],
    ['--muted', '--surface-1', 4.5],
    ['--muted', '--surface-2', 4.5],
    ['--accent', '--surface-1', 4.5],
    ['--danger', '--surface-1', 4.5],
    ['--dock-text', '--dock-bg', 4.5],
    ['--tile-ring', '--stage-bg', 3],
    ['--tile-ring', '--stage-tile', 3],
    // Ступени громкости голоса (T23): каждая видна на сцене и на плитке.
    ['--voice-1', '--stage-bg', 3],
    ['--voice-1', '--stage-tile', 3],
    ['--voice-1', '--stage-tile-2', 3],
    ['--voice-2', '--stage-tile-2', 3],
    ['--voice-3', '--stage-tile-2', 3],
    ['--voice-4', '--stage-tile-2', 3],
    ['--warning', '--surface-1', 4.5],
    ['--accent-fill', '--stage-bg', 3],
    ['--on-live', '--live', 4.5],
  ],
};

export function check(css = readFileSync(TOKENS_PATH, 'utf8')) {
  const rows = [];
  for (const [name, pairs] of Object.entries(PAIRS)) {
    const vars = theme(css, name);
    for (const [fg, bg, min] of pairs) {
      const ratio = contrast(resolve(vars, vars[fg]), resolve(vars, vars[bg]));
      rows.push({ theme: name, fg, bg, min, ratio, ok: ratio >= min });
    }
  }
  return rows;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const quiet = process.argv.includes('--quiet');
  const rows = check();
  for (const row of rows) {
    if (quiet && row.ok) continue;
    console.log(
      `${row.ok ? ' ok ' : 'FAIL'} ${row.theme.padEnd(5)} ${row.fg.padEnd(20)} на ${row.bg.padEnd(18)} ${row.ratio.toFixed(2).padStart(6)} (нужно ${row.min})`,
    );
  }
  const failed = rows.filter((r) => !r.ok);
  console.log(`\n${rows.length} пар, нарушений: ${failed.length}`);
  process.exit(failed.length ? 1 : 0);
}
