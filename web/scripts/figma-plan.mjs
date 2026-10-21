#!/usr/bin/env node
// Что выгружать на страницу карты продукта (E15-B): карточки и кадры по каталогу, в порядке рядов.
//
//   node scripts/figma-plan.mjs --page Главная            — счёт и список файлов
//   node scripts/figma-plan.mjs --page Главная --json     — план раскладки для figma-place.js
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { PAGES } from './screens-catalog.mjs';

export const DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../backlog/screens/figma');

/** Кадры состояния: `<id>-<ширина>-<тема>.svg`, по ширине, светлая раньше тёмной. */
export function framesOf(id, dir = DIR) {
  const re = new RegExp(`^${id.replace(/[-]/g, '\\-')}-(\\d+)-(light|dark)\\.svg$`);
  return readdirSync(dir)
    .map((f) => re.exec(f))
    .filter(Boolean)
    .sort((a, b) => Number(a[1]) - Number(b[1]) || (a[2] === 'light' ? -1 : 1))
    .map((m) => m[0]);
}

/** Файлы страницы в порядке выгрузки: шапка, разделы, карточки, кадры (пути от DIR). */
export function filesFor(page, { skip = [] } = {}) {
  const p = PAGES[page];
  if (!p) throw new Error(`нет страницы «${page}»`);
  const files = [`cards/page-${p.slug}.svg`];
  p.sections.forEach((s, i) => files.push(`cards/section-${p.slug}-${i + 1}.svg`));
  for (const s of p.sections)
    for (const id of s.states) {
      if (existsSync(path.join(DIR, `cards/card-${id}.svg`))) files.push(`cards/card-${id}.svg`);
      files.push(...framesOf(id));
    }
  return files.filter((f) => !skip.includes(f));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n) => process.argv[process.argv.indexOf(`--${n}`) + 1];
  const page = arg('page');
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ page, slug: PAGES[page].slug, sections: PAGES[page].sections.map((s) => ({ name: s.name, states: s.states })) }));
  } else {
    const files = filesFor(page);
    const missing = PAGES[page].sections.flatMap((s) => s.states).filter((id) => framesOf(id).length === 0);
    console.log(`${files.length} файлов; без кадров: ${missing.join(', ') || 'нет'}`);
  }
}
