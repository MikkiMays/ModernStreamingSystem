import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Шкала размеров (R28, DESIGN → «Шкала размеров») держится тестом, а не глазами: владелец увидел
 * «одни тоньше, другие толще» именно потому, что каждый экран писал свои числа — рамку 1,5 рядом с 1,
 * кольцо 3 рядом с 2, значки 13, 17, 19 и 22 в одной строке. Здесь любое такое число в CSS и TSX —
 * падение, кроме мест из списка исключений: у каждого есть причина, и каждое обязано существовать
 * (устаревшее исключение — тоже падение, иначе список только растёт).
 *
 * Что проверяется:
 * - толщина рамок и обводок (`border*`, `outline*`) — только `--hairline`, `--hairline-strong`,
 *   `--focus-outline`, `--voice-ring-*` и другие токены, не число;
 * - кольца тенью `0 0 0 Npx` — так же;
 * - отступ кольца фокуса — `--focus-offset` / `--focus-offset-inset`;
 * - радиусы — токены `--radius-*`;
 * - зазоры `gap` — шкала `--space-*` (текучие `clamp()` раскладки — можно);
 * - высота кнопок (`button`, `.icon-button`, `*-button`, `*-toggle`, `*-tab`, `*-chip`) — `--control-*`,
 *   `--touch-target`;
 * - размер значка в CSS (`svg`, `.lucide`) — `--icon-*`;
 * - значки lucide в TSX: `size` только 12 / 16 / 20 / 24 (интерфейс) и 32 / 40 (иллюстрации),
 *   `strokeWidth` — только у рисунков со своей линией (`data-own-stroke`).
 */
const root = join(process.cwd(), 'src');

function walk(dir: string, ext: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, ext, out);
    else if (name.endsWith(ext) && !name.includes('.test.')) out.push(path);
  }
  return out;
}

/** Файлы, где числа — источник или зеркало, а не экран. */
const SKIP_FILES: Record<string, string> = {
  'styles/tokens.css': 'источник шкалы: здесь числа и живут',
  'ui/loader/loader.css':
    'сцена загрузки повторена литералами в index.html до JS; совпадение сверяет loader.test.ts',
};

interface Declaration {
  file: string;
  line: number;
  selector: string;
  prop: string;
  value: string;
}

/** Объявления CSS со своим селектором (вложенность `&` и `@media` — через стек) и строкой. */
function declarations(file: string, text: string): Declaration[] {
  // Комментарии — пробелами той же длины: строки и смещения не съезжают.
  const plain = text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
  const out: Declaration[] = [];
  const stack: string[] = [];
  let buffer = '';
  let start = 1;
  let line = 1;
  const flush = () => {
    const body = buffer.trim();
    const colon = body.indexOf(':');
    if (colon > 0) {
      const prop = body.slice(0, colon).trim();
      if (/^[a-z-]+$/.test(prop))
        out.push({
          file,
          line: start,
          selector: stack.filter((part) => !part.startsWith('@')).join(' » '),
          prop,
          value: body
            .slice(colon + 1)
            .trim()
            .replace(/\s+/g, ' '),
        });
    }
    buffer = '';
  };
  for (const ch of plain) {
    if (ch === '\n') line++;
    if (ch === '{') {
      stack.push(buffer.trim().replace(/\s+/g, ' '));
      buffer = '';
    } else if (ch === '}') {
      flush();
      stack.pop();
    } else if (ch === ';') flush();
    else {
      if (!buffer.trim()) start = line;
      buffer += ch;
    }
  }
  return out;
}

const PX = /(?<![\w.-])-?\d*\.?\d+px\b/;
const RULES: { name: string; test: (d: Declaration) => boolean }[] = [
  {
    name: 'толщина линии',
    test: ({ prop, value }) =>
      /^(border(-(top|right|bottom|left|inline|block)(-(start|end))?)?(-width)?|outline(-width)?|column-rule(-width)?)$/.test(
        prop,
      ) &&
      PX.test(value) &&
      !/^0(px)?$/.test(value),
  },
  {
    name: 'кольцо тенью',
    test: ({ prop, value }) => prop === 'box-shadow' && /\b0 0 0 -?\d*\.?\d+px/.test(value),
  },
  { name: 'отступ кольца', test: ({ prop, value }) => prop === 'outline-offset' && PX.test(value) },
  {
    name: 'радиус',
    test: ({ prop, value }) =>
      /^border(-[a-z]+)*-radius$/.test(prop) && PX.test(value) && !/clamp\(/.test(value),
  },
  {
    name: 'зазор',
    test: ({ prop, value }) => /^(row-|column-)?gap$/.test(prop) && PX.test(value) && !/clamp\(/.test(value),
  },
  {
    name: 'высота кнопки',
    test: ({ prop, value, selector }) => {
      const last = selector.split(' » ').pop() ?? '';
      return (
        /^(min-)?height$/.test(prop) &&
        PX.test(value) &&
        /(^|[\s>+~(,.])(button|icon-button)\b|-button\b|-btn\b|-toggle\b|-tab\b|-chip\b/.test(last) &&
        !/::?(after|before)|(^|\s|>)i$|svg/.test(last)
      );
    },
  },
  {
    name: 'размер значка',
    test: ({ prop, value, selector }) =>
      /^(width|height|inline-size|block-size)$/.test(prop) &&
      PX.test(value) &&
      /(^|[\s>+~(,])svg\b|\.lucide\b/.test(selector.split(' » ').pop() ?? ''),
  },
];

/**
 * Исключения: файл, часть селектора, правило — и почему число здесь своё. Рисунки (сукно, карты,
 * кольцо хода, бегунок полосы прокрутки) и вспышки анимаций не элементы управления: их толщина —
 * часть рисунка, а не шкалы.
 */
const ALLOWED: { file: string; selector: string; rule: string; why: string }[] = [
  {
    file: 'styles.css',
    selector: '::-webkit-scrollbar-thumb',
    rule: 'толщина линии',
    why: 'прозрачная рамка задаёт поле бегунка полосы прокрутки (S2)',
  },
  {
    file: 'styles.css',
    selector: '.avatar-crop-mask',
    rule: 'кольцо тенью',
    why: 'затемнение вокруг круга обрезки — тень на 9999',
  },
  {
    file: 'ui/kit/kit.css',
    selector: ':active::-webkit-slider-thumb',
    rule: 'кольцо тенью',
    why: 'ореол нажатого бегунка ползунка',
  },
  {
    file: 'ui/kit/kit.css',
    selector: '[data-coachmark-target]',
    rule: 'кольцо тенью',
    why: 'подсветка цели шага знакомства',
  },
  {
    file: 'ui/kit/kit.css',
    selector: '[data-coachmark-target]',
    rule: 'отступ кольца',
    why: 'подсветка цели шага знакомства, а не фокус',
  },
  {
    file: 'ui/shell.css',
    selector: 'summary::after',
    rule: 'толщина линии',
    why: 'треугольник «раскрыть» нарисован рамкой',
  },
  {
    file: 'ui/home/home.css',
    selector: '.home-here__pulse',
    rule: 'кольцо тенью',
    why: 'ореол точки «вы здесь»',
  },
  {
    file: 'ui/cinema/theater.css',
    selector: '.watch-live-dot',
    rule: 'кольцо тенью',
    why: 'ореол точки «в эфире»',
  },
  { file: 'ui/integrations.css', selector: '.music-eq > i', rule: 'радиус', why: 'столбики эквалайзера' },
  {
    file: 'ui/stage-overlay.css',
    selector: '.stage-chip__eq > i',
    rule: 'радиус',
    why: 'столбики эквалайзера',
  },
  {
    file: 'ui/settings/settings.css',
    selector: '.setting-meter',
    rule: 'зазор',
    why: 'шкала уровня: столбики 5 через 3',
  },
  {
    file: 'ui/settings/settings.css',
    selector: '.overlay-corner-icon',
    rule: 'радиус',
    why: 'нарисованный значок угла экрана',
  },
  {
    file: 'chess.css',
    selector: '[data-target][data-occupied]::after',
    rule: 'толщина линии',
    why: 'кольцо взятия на клетке доски',
  },
  { file: 'durak.css', selector: '.durak-felt', rule: 'толщина линии', why: 'кромка сукна стола' },
  {
    file: 'durak.css',
    selector: '.durak-card[data-back]',
    rule: 'толщина линии',
    why: 'белая кайма рубашки карты',
  },
  {
    file: 'durak.css',
    selector: '.durak-seat-count i',
    rule: 'радиус',
    why: 'мини-карта в счётчике карт на руках',
  },
  { file: 'durak.css', selector: '0%, 100%', rule: 'кольцо тенью', why: 'вспышка хода (анимация)' },
  { file: 'durak.css', selector: '50%', rule: 'кольцо тенью', why: 'вспышка хода (анимация)' },
  { file: 'poker.css', selector: '.poker-deck', rule: 'кольцо тенью', why: 'кайма и стопка колоды' },
  {
    file: 'poker.css',
    selector: '.playing-card[data-back]',
    rule: 'кольцо тенью',
    why: 'кайма рубашки карты',
  },
  { file: 'poker.css', selector: '40%', rule: 'кольцо тенью', why: 'вспышка банка (анимация)' },
  { file: 'poker.css', selector: '50%', rule: 'кольцо тенью', why: 'вспышка победителя (анимация)' },
  {
    file: 'durak.css',
    selector: '.durak-toggle, & .durak-settings-action',
    rule: 'высота кнопки',
    why: 'строка-карточка настройки стола: заголовок и подпись в две строки',
  },
  {
    file: 'game-polish.css',
    selector: '.durak-reaction-picker button',
    rule: 'высота кнопки',
    why: 'плитки реакций с крупным эмодзи',
  },
  {
    file: 'gartic.css',
    selector: '.gartic-palette button',
    rule: 'высота кнопки',
    why: 'образцы цвета палитры на узком экране — 12 в ряд',
  },
];

const css = walk(root, '.css')
  .map((path) => ({ file: relative(root, path).split('\\').join('/'), text: readFileSync(path, 'utf8') }))
  .filter(({ file }) => !(file in SKIP_FILES));

describe('шкала размеров в CSS (R28)', () => {
  const found = css.flatMap(({ file, text }) =>
    declarations(file, text).flatMap((d) =>
      RULES.filter((rule) => rule.test(d)).map((rule) => ({ ...d, rule: rule.name })),
    ),
  );
  const allowed = (d: (typeof found)[number]) =>
    ALLOWED.find((a) => a.file === d.file && a.rule === d.rule && d.selector.includes(a.selector));

  it('рамки, кольца, радиусы, зазоры и значки — токенами шкалы', () => {
    const wrong = found.filter((d) => !allowed(d));
    expect(
      wrong.map((d) => `${d.file}:${d.line} ${d.rule}: ${d.selector} { ${d.prop}: ${d.value} }`),
    ).toEqual([]);
  });

  it('каждое исключение ещё нужно', () => {
    const stale = ALLOWED.filter((a) => !found.some((d) => allowed(d) === a));
    expect(stale.map((a) => `${a.file} ${a.selector} — ${a.rule}`)).toEqual([]);
  });
});

/** Имена значков файла: импорт из lucide-react (с `as`), `<x.icon>` и `<Icon>` из реестров. */
function iconTags(text: string) {
  const names = new Set<string>();
  for (const match of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]lucide-react['"]/g))
    for (const part of match[1]!.split(',')) {
      const name = part.trim();
      if (!name || name.startsWith('type ')) continue;
      const [original, alias] = name.split(/\s+as\s+/);
      names.add((alias ?? original)!.trim());
    }
  return [...text.matchAll(/<([A-Za-z][\w.]*)\b([^<>]*?)\/?>/gs)]
    .filter(([, tag]) => names.has(tag!) || /^[a-z]\w*\.icon$/.test(tag!) || tag === 'Icon')
    .map((match) => ({
      tag: match[1]!,
      attrs: match[2]!,
      line: text.slice(0, match.index).split('\n').length,
    }));
}

const SIZES = [12, 16, 20, 24, 32, 40];
const tsx = walk(root, '.tsx').map((path) => ({
  file: relative(root, path).split('\\').join('/'),
  text: readFileSync(path, 'utf8'),
}));

describe('значки lucide в TSX (R28)', () => {
  const icons = tsx.flatMap(({ file, text }) => iconTags(text).map((icon) => ({ file, ...icon })));

  it('находит значки: проверка не пустая', () => {
    expect(icons.length).toBeGreaterThan(300);
  });

  it('размер — 12 / 16 / 20 / 24 или иллюстрация 32 / 40', () => {
    const wrong = icons.filter(({ attrs }) => {
      const size = /\bsize=\{([^}]*)\}/.exec(attrs)?.[1];
      if (!size) return false;
      // В условии вида `size={lg ? 32 : 16}` — каждое число.
      return [...size.matchAll(/\d+(\.\d+)?/g)].some(([n]) => !SIZES.includes(Number(n)));
    });
    expect(wrong.map(({ file, line, tag, attrs }) => `${file}:${line} <${tag}${attrs}>`)).toEqual([]);
  });

  it('толщина линии своя только у рисунков с data-own-stroke', () => {
    const wrong = icons.filter(
      ({ attrs }) => /\bstrokeWidth=/.test(attrs) && !/\bdata-own-stroke\b/.test(attrs),
    );
    expect(wrong.map(({ file, line, tag }) => `${file}:${line} <${tag}>`)).toEqual([]);
  });
});
