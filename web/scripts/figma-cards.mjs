#!/usr/bin/env node
// Карточки-описания для карты продукта в Figma (E15-B, T57): каждое состояние из `screens-catalog.mjs`
// — карточка «что это / кто и откуда / правила / задачи / компоненты / исходники / как открыть»,
// у раздела и страницы — шапка с коротким описанием, у файла — обложка. HTML верстается здесь же,
// браузер раскладывает текст, `dom-svg.mjs` превращает в SVG со слоями (текст остаётся текстом).
//
//   node scripts/figma-cards.mjs [--only id,id] → ../backlog/screens/figma/cards/*.svg
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { domToSvg } from './dom-svg.mjs';
import { STATES, PAGES, COVER, FILES } from './screens-catalog.mjs';

const require = createRequire(import.meta.url);
const font = path.dirname(require.resolve('@fontsource-variable/inter/files/inter-cyrillic-wght-normal.woff2'));
const out = path.resolve('../backlog/screens/figma/cards');
mkdirSync(out, { recursive: true });
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1].split(',') : null;

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const CSS = `
@font-face { font-family: 'Inter'; src: url('file://${font}/inter-cyrillic-wght-normal.woff2') format('woff2'); font-weight: 100 900; unicode-range: U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116; }
@font-face { font-family: 'Inter'; src: url('file://${font}/inter-latin-wght-normal.woff2') format('woff2'); font-weight: 100 900; }
* { box-sizing: border-box; margin: 0; }
html, body { background: transparent; }
body { font-family: Inter, sans-serif; color: #1b1f27; padding: 0; }
.card { width: 440px; background: #ffffff; border-radius: 16px; padding: 24px; box-shadow: inset 0 0 0 1px #e1e4eb; }
.id { font: 500 12px/1.4 Inter; color: #5f6878; letter-spacing: 0.02em; }
h2 { font: 600 20px/1.25 Inter; letter-spacing: -0.01em; margin: 6px 0 16px; }
dl { display: grid; gap: 10px; }
dt { font: 600 11px/1.3 Inter; text-transform: uppercase; letter-spacing: 0.06em; color: #2d59df; }
dd { font: 400 13px/1.45 Inter; color: #1b1f27; margin-top: 2px; }
dd.code { color: #4d5566; font-size: 12px; }
.frames { margin-top: 16px; padding-top: 12px; box-shadow: inset 0 1px 0 #e1e4eb; font: 400 12px/1.4 Inter; color: #5f6878; }
.head { width: 1200px; padding: 40px 48px; border-radius: 24px; background: #111419; color: #eef0f4; }
.head .kicker { font: 600 13px/1.3 Inter; text-transform: uppercase; letter-spacing: 0.08em; color: #7d9bff; }
.head h1 { font: 600 44px/1.15 Inter; letter-spacing: -0.02em; margin: 10px 0 14px; }
.head p { font: 400 18px/1.5 Inter; color: #b3bbc9; max-width: 1040px; }
.head ol { margin-top: 18px; padding-left: 22px; font: 400 15px/1.6 Inter; color: #d3d8e1; columns: 2; }
.section { width: 1200px; padding: 20px 28px; border-radius: 16px; background: #eaf0ff; color: #1c2a4e; }
.section h3 { font: 600 26px/1.2 Inter; letter-spacing: -0.01em; }
.section p { font: 400 15px/1.5 Inter; margin-top: 6px; color: #2347b8; }
.cover { width: 1600px; height: 1000px; padding: 96px; border-radius: 0; background: radial-gradient(80% 70% at 30% 20%, #1a2547 0%, #111419 70%); color: #eef0f4; display: grid; align-content: space-between; }
.cover .mark { width: 88px; height: 88px; border-radius: 22px; background: #3564f3; display: grid; place-items: center; }
.cover h1 { font: 600 96px/1 Inter; letter-spacing: -0.03em; margin-top: 48px; }
.cover p { font: 400 26px/1.5 Inter; color: #d3d8e1; max-width: 1180px; margin-top: 28px; }
.cover .map { display: grid; grid-template-columns: repeat(5, 1fr); gap: 20px; }
.cover .file { padding: 20px; border-radius: 16px; background: rgb(255 255 255 / 0.06); box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.08); }
.cover .file b { display: block; font: 600 15px/1.35 Inter; color: #ffffff; }
.cover .file span { display: block; margin-top: 8px; font: 400 14px/1.5 Inter; color: #b3bbc9; }
.cover .date { font: 500 14px/1.4 Inter; color: #939daf; margin-top: 24px; }
`;
const MARK = `<svg viewBox="0 0 30 30" width="46" height="46"><g fill="#fff"><rect x="2" y="6" width="6" height="18" rx="3" transform="rotate(-15 5 15)"/><rect x="12" y="0.5" width="6" height="29" rx="3" transform="rotate(-15 15 15)"/><rect x="22" y="4" width="6" height="22" rx="3" transform="rotate(-15 25 15)"/></g></svg>`;

function card(id, s) {
  const rows = [
    ['Что это', s.what],
    ['Кто и откуда', s.who],
    ['Правила и состояния', s.rules],
    ['Задачи', s.tasks],
    ['Компоненты набора', s.kit],
    ['Исходники', s.src, 'code'],
    ['Как открыть', s.how],
  ];
  return `<div class="card"><div class="id">${esc(id)}</div><h2>${esc(s.title)}</h2><dl>${rows
    .map(([k, v, cls]) => `<div><dt>${esc(k)}</dt><dd${cls ? ` class="${cls}"` : ''}>${esc(v)}</dd></div>`)
    .join('')}</dl></div>`;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1200 } });
async function render(name, html) {
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>${html}</body></html>`);
  await page.evaluate(() => document.fonts.ready);
  const box = await page.locator('body > *').first().boundingBox();
  await page.setViewportSize({ width: Math.ceil(box.width), height: Math.ceil(box.height) });
  const { svg } = await page.evaluate(domToSvg, { fullPage: false });
  writeFileSync(path.join(out, `${name}.svg`), svg.replace('<rect id="фон страницы"', '<rect id="фон страницы" fill-opacity="0"'));
  await page.setViewportSize({ width: 1700, height: 1200 });
}

let n = 0;
for (const [id, s] of Object.entries(STATES)) {
  if (only && !only.includes(id)) continue;
  await render(`card-${id}`, card(id, s));
  n++;
}
if (!only) {
  for (const [name, p] of Object.entries(PAGES)) {
    const file = FILES.find((f) => f.pages.includes(name));
    const count = p.sections.reduce((a, x) => a + x.states.length, 0);
    await render(
      `page-${p.slug}`,
      `<div class="head"><div class="kicker">${esc(file.name)}</div><h1>${esc(name)}</h1><p>${esc(p.about)}</p><ol>${p.sections
        .map((x) => `<li>${esc(x.name)} — ${x.states.length}</li>`)
        .join('')}</ol><p style="margin-top:14px;font-size:14px">Состояний: ${count}. Ряд — одно состояние: карточка описания слева, кадры 360 / 1024 / 1440 в светлой и тёмной теме. Кадры — слои из живого стенда (SVG), цвета привязаны к переменным «Цвет · светлая/тёмная».</p></div>`,
    );
    for (const [i, x] of p.sections.entries())
      await render(`section-${p.slug}-${i + 1}`, `<div class="section"><h3>${esc(x.name)}</h3><p>${esc(x.states.map((id) => STATES[id]?.title ?? id).join(' · '))}</p></div>`);
    n += 1 + p.sections.length;
  }
  await render(
    'cover',
    `<div class="cover"><div><div class="mark">${MARK}</div><h1>${esc(COVER.title)}</h1><p>${esc(COVER.lead)}</p></div><div><div class="map">${FILES.map(
      (f) => `<div class="file"><b>${esc(f.name)}</b><span>${f.pages.map(esc).join('<br>')}</span></div>`,
    ).join('')}</div><div class="date">Карта продукта · E15-B · 20.10.2026 · снято со стенда, main</div></div></div>`,
  );
  n++;
}
await browser.close();
console.log(`${n} карточек → ${out}`);
