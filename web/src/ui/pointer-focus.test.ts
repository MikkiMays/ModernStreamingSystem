import { afterEach, beforeEach, expect, it } from 'vitest';
import styles from '../styles.css?raw';
import kit from './kit/kit.css?raw';
import { installPointerFocus } from './pointer-focus';

let windowFocused = true;
let uninstall = () => {};
beforeEach(() => {
  windowFocused = true;
  document.body.innerHTML = `
    <input id="volume" type="range" min="0" max="100" value="40" />
    <input id="name" type="text" />
    <button id="other">Другое</button>`;
  uninstall = installPointerFocus(document, () => windowFocused);
});
afterEach(() => uninstall());

const range = () => document.getElementById('volume') as HTMLInputElement;
const press = (target: Element) => target.dispatchEvent(new Event('pointerdown', { bubbles: true }));

it('помечает ползунок, взятый указателем, и только его', () => {
  press(range());
  expect(range().dataset.pointerFocus).toBe('');
  press(document.getElementById('name')!);
  expect(document.getElementById('name')!.dataset.pointerFocus).toBeUndefined();
});

it('снимает пометку, когда фокус уходит с ползунка внутри страницы', () => {
  press(range());
  range().focus();
  document.getElementById('other')!.focus();
  expect(range().dataset.pointerFocus).toBeUndefined();
});

it('держит пометку, когда фокус уходит вместе с окном (Alt+Tab)', () => {
  press(range());
  range().focus();
  windowFocused = false;
  range().blur();
  expect(range().dataset.pointerFocus).toBe('');
});

it('ползунок, до которого дошли с клавиатуры, пометки не получает — кольцо ему нужно', () => {
  range().focus();
  expect(range().dataset.pointerFocus).toBeUndefined();
});

it('CSS гасит кольцо помеченного ползунка сильнее любого правила кольца', () => {
  expect(styles).toMatch(/input\[type='range'\]\[data-pointer-focus\]:focus-visible \{\s*outline: none;/);
  // Кольцо остаётся только для клавиатуры — у ползунков набора и у прежних `.slider`.
  expect(kit).toMatch(/\.ui-slider:focus-visible \{/);
  expect(styles).toMatch(/\.slider:focus-visible \{/);
});

it('глобальное правило полей не перебивает классы ползунков и набора', () => {
  // Правило полей обёрнуто в :where() и не трогает range: «таблетка» с рамкой вокруг дорожки
  // была его заслугой (CONTEXT.md → «Грабли интерфейса»).
  expect(styles).toMatch(/:where\(input:not\(\[type='checkbox'\], \[type='radio'\], \[type='range'\]\)\)/);
  expect(styles).not.toMatch(/^input:not\(\[type='checkbox'\], \[type='radio'\]\),$/m);
});
