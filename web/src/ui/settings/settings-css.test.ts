import { expect, it } from 'vitest';
import css from './settings.css?raw';
import { SHEET } from '../breakpoints';

/*
  Окно настроек написано на токенах E16 сразу (§7 «Миграция»: экраны, которые эпик переписывает
  целиком, пишутся на наборе). Тест держит это обещание: литерал цвета или размера шрифта,
  `!important` — и он падает.
*/
const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '');

it('только токены: ни hex, ни rgb(), ни !important', () => {
  expect(declarations).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  expect(declarations).not.toMatch(/\brgba?\(/);
  expect(declarations).not.toMatch(/!important/);
});

it('размер шрифта — только шкалой --text-*', () => {
  const sizes = [...declarations.matchAll(/font-size:\s*([^;]+);/g)].map((match) => match[1]!.trim());
  expect(sizes.length).toBeGreaterThan(10);
  for (const size of sizes) expect(size).toMatch(/^var\(--text-(xs|sm|base|md|lg|xl|2xl)\)$/);
});

it('телефонная раскладка начинается там же, где код переключает список и раздел', () => {
  expect(declarations).toContain(`@media ${SHEET} {`);
  expect(declarations).toMatch(/\.settings-window\[data-view='list'\] \.settings-pane/);
});
