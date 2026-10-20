import { expect, it } from 'vitest';
import css from './integrations.css?raw';
import styles from '../styles.css?raw';
import layout from '../room-layout.css?raw';

/*
  Витрина и музыка написаны на токенах E16 сразу (§7 «Миграция»: экран, который эпик переписывает
  целиком, пишется на наборе). Литерал цвета, размер шрифта мимо шкалы, сырой цвет палитры или
  `!important` — и тест падает.
*/
const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '');

it('только токены: ни hex, ни rgb(), ни палитры, ни !important', () => {
  expect(declarations).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  expect(declarations).not.toMatch(/\brgba?\(/);
  expect(declarations).not.toMatch(/--palette-/);
  expect(declarations).not.toMatch(/!important/);
});

it('размер шрифта — только шкалой --text-*', () => {
  const sizes = [...declarations.matchAll(/font-size:\s*([^;]+);/g)].map((match) => match[1]!.trim());
  expect(sizes.length).toBeGreaterThan(20);
  for (const size of sizes) expect(size).toMatch(/^var\(--text-(xs|sm|base|md|lg|xl|2xl)\)$/);
});

it('прежние правила витрины и музыки удалены, а не перебиты', () => {
  for (const old of [
    '.service-card',
    '.now-playing',
    '.queue-track',
    '.integration-results',
    '.service-soon',
  ])
    expect(styles + layout).not.toContain(old);
});
