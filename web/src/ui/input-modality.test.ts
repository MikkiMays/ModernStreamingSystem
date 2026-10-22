import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import tokens from '../styles/tokens.css?raw';
import styles from '../styles.css?raw';
import chess from '../chess.css?raw';
import durak from '../durak.css?raw';
import gartic from '../gartic.css?raw';
import gamePeople from '../game-people.css?raw';
import gamePolish from '../game-polish.css?raw';
import cinema from './cinema/cinema.css?raw';
import kit from './kit/kit.css?raw';
import { installInputModality } from './input-modality';

/*
  Модальность ввода (S1, R26): кольцо фокуса рисуется только тому, кто ходит клавиатурой. Режим —
  атрибут `html[data-input]`; CSS гасит токен `--focus-outline`, пока режим не `keyboard`.
*/

let uninstall = () => {};
const mode = () => document.documentElement.dataset.input;
const key = (init: KeyboardEventInit) =>
  document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
const point = () => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));

beforeEach(() => {
  delete document.documentElement.dataset.input;
  uninstall = installInputModality(document);
});
afterEach(() => uninstall());

describe('installInputModality', () => {
  it('начинает с указателя: кольца нет, пока человек не пошёл клавиатурой', () => {
    expect(mode()).toBe('pointer');
  });

  it.each([
    'Tab',
    'ArrowDown',
    'ArrowUp',
    'ArrowLeft',
    'ArrowRight',
    'Home',
    'End',
    'PageUp',
    'PageDown',
    'F6',
  ])('%s — навигация: режим клавиатуры', (name) => {
    key({ key: name });
    expect(mode()).toBe('keyboard');
  });

  it('Shift+Tab и Shift+стрелка — тоже навигация', () => {
    key({ key: 'Tab', shiftKey: true });
    expect(mode()).toBe('keyboard');
    point();
    key({ key: 'ArrowRight', shiftKey: true });
    expect(mode()).toBe('keyboard');
  });

  it.each([
    ['Shift', {}],
    ['Control', { ctrlKey: true }],
    ['Alt', { altKey: true }],
    ['Meta', { metaKey: true }],
    ['Escape', {}],
    ['Enter', {}],
    [' ', {}],
    ['a', {}],
    ['A', { shiftKey: true }],
    ['7', {}],
  ] as const)('%s не включает кольцо', (name, modifiers) => {
    key({ key: name, ...modifiers });
    expect(mode()).toBe('pointer');
  });

  it('сочетания не включают кольцо: микрофон Ctrl+Shift+M, Alt+Tab, Ctrl+Tab, Meta+стрелка', () => {
    key({ key: 'M', ctrlKey: true, shiftKey: true });
    key({ key: 'Tab', altKey: true });
    key({ key: 'Tab', ctrlKey: true });
    key({ key: 'ArrowLeft', metaKey: true });
    expect(mode()).toBe('pointer');
  });

  it('нажатие указателем возвращает режим указателя', () => {
    key({ key: 'Tab' });
    point();
    expect(mode()).toBe('pointer');
  });

  it('после клавиатуры Shift и Esc режим не сбрасывают — кольцо остаётся у того, кто идёт Tab-ом', () => {
    key({ key: 'Tab' });
    key({ key: 'Shift', shiftKey: true });
    key({ key: 'Escape' });
    expect(mode()).toBe('keyboard');
  });

  it('слушает фазу перехвата: остановленное всплытие режим не теряет', () => {
    const stopper = (event: Event) => event.stopPropagation();
    document.body.addEventListener('keydown', stopper);
    document.body.addEventListener('pointerdown', stopper);
    try {
      key({ key: 'Tab' });
      expect(mode()).toBe('keyboard');
      point();
      expect(mode()).toBe('pointer');
    } finally {
      document.body.removeEventListener('keydown', stopper);
      document.body.removeEventListener('pointerdown', stopper);
    }
  });

  it('снятие отключает слушателей', () => {
    uninstall();
    key({ key: 'Tab' });
    expect(mode()).toBe('pointer');
  });
});

/** Блоки правил, у которых в селекторе есть `:focus-visible`: `селектор { тело }`. */
function focusRules(css: string) {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...plain.matchAll(/([^{}]*:focus-visible[^{}]*)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selector: selector!.trim(),
    body: body!,
  }));
}

describe('CSS: одно кольцо на токене', () => {
  it('вне режима клавиатуры токен кольца пуст — и в корне, и во вложенных темах и на сцене', () => {
    // `none`, а не `0 solid transparent`: у погашенного кольца `outline-style` — `none` (Ц7).
    expect(tokens).toMatch(
      /:root:not\(\[data-input='keyboard'\]\),\s*:root:not\(\[data-input='keyboard'\]\) :is\(\[data-theme\], \.media-stage\) \{\s*--focus-outline: none;/,
    );
  });

  it('глобальное правило — нулевого веса и не ловит контейнеры с tabindex=-1', () => {
    const plain = styles.replace(/\s+/g, ' ');
    expect(plain).toMatch(
      /:where\( button, a, input, select, textarea, \[tabindex\]:not\(\[tabindex='-1'\]\), \[role='tab'\],[^)]*\):focus-visible \{ outline: var\(--focus-outline\); outline-offset: var\(--focus-offset\);/,
    );
    expect(styles).not.toMatch(/^\[tabindex\]:focus-visible/m);
  });

  it('окна, меню и старый .modal кольца не получают никогда; вкладки рядов с tabindex=-1 — получают', () => {
    const plain = styles.replace(/\s+/g, ' ');
    // Контейнер — `tabindex=-1`, но не кнопка и не вкладка «roving tabindex» (вкладки кинозала).
    expect(plain).toMatch(
      /:where\( \[tabindex='-1'\]:not\( button, a, input, select, textarea, \[role='tab'\], \[role='radio'\], \[role='option'\], \[role='gridcell'\], \[role='treeitem'\] \), \[role='dialog'\], \[role='alertdialog'\], \[role='menu'\] \):focus-visible, \.modal:focus-visible \{ outline: none; \}/,
    );
  });

  it('пункт меню — без кольца; в режиме клавиатуры подсвеченный обведён внутри (R75)', () => {
    expect(kit).toMatch(/\.ui-menu__item:focus-visible \{\s*outline: none;/);
    expect(kit).toMatch(
      /:root\[data-input='keyboard'\] \.ui-menu__item\[data-highlighted\] \{\s*box-shadow: inset 0 0 0 var\(--hairline-strong\) var\(--accent\);/,
    );
  });

  it('литеральных колец фокуса нет: только var(--focus-outline)', () => {
    const files = { styles, chess, durak, gartic, gamePeople, gamePolish, cinema, kit };
    for (const [name, css] of Object.entries(files))
      for (const rule of focusRules(css))
        expect(rule.body, `${name}: ${rule.selector}`).not.toMatch(/outline:\s*\d+px\s+solid/);
  });

  it('поле ввода в фокусе подсвечено рамкой в любом режиме — это состояние поля, не кольцо', () => {
    expect(styles).toMatch(
      /input:not\(\[type='checkbox'\], \[type='radio'\], \[type='range'\], \[disabled\]\):focus,\s*:is\(select, textarea\):not\(\[disabled\]\):focus \{\s*border-color: var\(--accent\);/,
    );
  });

  it('прежний обход для ползунков снят: модальность закрывает и их (T31)', () => {
    expect(styles).not.toMatch(/data-pointer-focus/);
  });

  it('правило полей по-прежнему нулевого веса и не трогает range', () => {
    // «Таблетка» с рамкой вокруг дорожки была его заслугой (CONTEXT.md → «Грабли интерфейса»).
    expect(styles).toMatch(/:where\(input:not\(\[type='checkbox'\], \[type='radio'\], \[type='range'\]\)\)/);
  });
});
