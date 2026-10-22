import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
