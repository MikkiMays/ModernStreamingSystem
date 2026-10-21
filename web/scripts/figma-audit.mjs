#!/usr/bin/env node
// Аудит чёткости (E15 B5, T29) по снимкам E15-B: `auditPage()` из dom-svg.mjs записан в manifest.json
// у каждого кадра. Скрипт сводит классы, отделяет ожидаемое (окно поверх страницы, отключённое,
// намеренное многоточие) и рисует отчёт карточкой для Figma (SVG) и таблицей в stdout.
//
//   node scripts/figma-audit.mjs [--svg]   → ../backlog/screens/figma/cards/audit.svg
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { domToSvg } from './dom-svg.mjs';

const dir = path.resolve('../backlog/screens/figma');
const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')).filter((e) => e.audit);

// Перекрытия окном, меню или подложкой — ожидаемы: под открытым окном кнопки и должны быть недоступны.
const EXPECTED_COVER = /ui-dialog|modal|backdrop|settings-|\.fl\b|watch-video|menu|sheet/;
const EXPECTED_CONTRAST =
  /Недоступно|Громкость микрофона|ui-switch-row__label|setting-row__label|chess-coordinate|poker-puck|«♠»|«♣»|«♥»|«♦»/;
const CLASSES = [
  ['overflowX', 'Горизонтальное переполнение страницы'],
  ['offscreen', 'Элементы управления за краем экрана'],
  ['clipped', 'Обрезанный текст без многоточия'],
  ['truncated', 'Текст с многоточием (намеренно)'],
  ['covered', 'Кнопка перекрыта другим слоем'],
  ['blurry', 'Растровая картинка мельче, чем на экране × DPR'],
  ['fractional', 'Тонкие линии на дробном пикселе'],
  ['contrast', 'Контраст текста ниже WCAG AA'],
];

const rows = [];
for (const [key, title] of CLASSES) {
  const frames = manifest.filter((e) => (key === 'overflowX' ? e.audit.overflowX > 0 : e.audit[key].n > 0));
  const samples = new Map();
  let expected = 0;
  let found = 0;
  for (const e of frames) {
    const list = key === 'overflowX' ? [`ширина +${e.audit.overflowX} px`] : e.audit[key].samples;
    for (const s of list) {
      const isExpected =
        (key === 'covered' && EXPECTED_COVER.test(s.split(' ← ')[1] ?? '')) ||
        (key === 'contrast' && EXPECTED_CONTRAST.test(s)) ||
        key === 'truncated' ||
        (key === 'overflowX' && e.id.startsWith('loader-')) ||
        (key === 'blurry' && e.id.startsWith('cinema-'));
      if (isExpected) expected++;
      else found++;
      const label = s.replace(/«(.{0,28}).*?»/, '«$1»').replace(/ [\d.]+:1$/, '');
      const k = `${isExpected ? '·' : '!'} ${label}`;
      const item = samples.get(k) ?? { n: 0, where: new Set(), ratio: /([\d.]+):1$/.exec(s)?.[1] };
      item.n++;
      item.where.add(`${e.id}@${e.width}`);
      samples.set(k, item);
    }
  }
  rows.push({
    key,
    title,
    frames: frames.length,
    found,
    expected,
    top: [...samples.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 8),
  });
}

for (const r of rows) {
  console.log(`\n## ${r.title} — кадров ${r.frames}, к правке ${r.found}, ожидаемо ${r.expected}`);
  for (const [k, v] of r.top)
    console.log(`  ${k}${v.ratio ? ` (${v.ratio}:1)` : ''} ×${v.n} — ${[...v.where].slice(0, 4).join(', ')}`);
}

if (process.argv.includes('--svg')) {
  const require = createRequire(import.meta.url);
  const font = path.dirname(
    require.resolve('@fontsource-variable/inter/files/inter-cyrillic-wght-normal.woff2'),
  );
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: Inter; src: url('file://${font}/inter-cyrillic-wght-normal.woff2'); font-weight: 100 900; unicode-range: U+0400-045F; }
@font-face { font-family: Inter; src: url('file://${font}/inter-latin-wght-normal.woff2'); font-weight: 100 900; }
* { box-sizing: border-box; margin: 0; } body { font-family: Inter; background: transparent; }
.r { width: 1600px; padding: 56px; background: #fff; color: #1b1f27; border-radius: 24px; }
h1 { font: 600 40px/1.2 Inter; letter-spacing: -0.02em; } .lead { font: 400 17px/1.5 Inter; color: #4d5566; margin: 12px 0 28px; max-width: 1400px; }
.c { padding: 20px 24px; border-radius: 16px; background: #f6f7fa; margin-bottom: 16px; }
.c h2 { font: 600 20px/1.3 Inter; } .c .n { font: 500 14px/1.4 Inter; color: #5f6878; margin: 4px 0 10px; }
.c li { font: 400 14px/1.55 Inter; list-style: none; } .c li b { color: #c21f29; font-weight: 600; } .c li i { color: #5f6878; font-style: normal; }
</style></head><body><div class="r"><h1>Аудит чёткости · T29 · ${manifest.length} кадров</h1>
<p class="lead">Проверено автоматически на каждом кадре E15-B (dom-svg.mjs → auditPage): переполнение, элементы за краем, обрезанный текст, перекрытые кнопки (elementFromPoint), мутные растры (меньше размера × DPR), дробные тонкие линии, контраст по WCAG AA. «!» — к правке (E16, E03, E04), «·» — ожидаемо: под открытым окном, отключённое, намеренное многоточие, источник картинки. Код продукта в E15-B не менялся — найденное передано в бэклог.</p>
${rows
  .map(
    (r) =>
      `<div class="c"><h2>${esc(r.title)}</h2><div class="n">кадров с находками: ${r.frames} · к правке: ${r.found} · ожидаемо: ${r.expected}</div><ul>${
        r.top
          .map(
            ([k, v]) =>
              `<li>${k.startsWith('!') ? '<b>!</b>' : '<i>·</i>'} ${esc(k.slice(2))}${v.ratio ? ` (${v.ratio}:1)` : ''} ×${v.n} <i>— ${esc([...v.where].slice(0, 4).join(', '))}</i></li>`,
          )
          .join('') || '<li><i>нет</i></li>'
      }</ul></div>`,
  )
  .join('')}</div></body></html>`;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  await page.setContent(html);
  await page.evaluate(() => document.fonts.ready);
  const box = await page.locator('.r').boundingBox();
  await page.setViewportSize({ width: 1600, height: Math.ceil(box.height) });
  const { svg } = await page.evaluate(domToSvg, { fullPage: false });
  writeFileSync(
    path.join(dir, 'cards/audit.svg'),
    svg.replace('<rect id="фон страницы"', '<rect id="фон страницы" fill-opacity="0"'),
  );
  await browser.close();
  console.log('\n→ cards/audit.svg');
}
