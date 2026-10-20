#!/usr/bin/env node
// Код для `use_figma` (E15-A): раздел страницы «Как есть» в Figma из manifest.json снимков
// `figma-screens.mjs`. Скрипт ничего не отправляет сам — он печатает JS для Plugin API, который
// агент передаёт инструменту `use_figma`; тот возвращает id кадров по порядку плана (--plan), по ним
// `upload_assets` выдаёт ссылки, а `figma-upload.mjs` кладёт PNG в кадры.
//
//   node scripts/figma-build.mjs --group 'Встреча' [--x 0 --y 2000]   → JS в stdout
//   node scripts/figma-build.mjs --groups                                → группы и число снимков
//   --plan /tmp/plan.json — ещё и порядок файлов для figma-upload.mjs; --rows a,b — только эти ряды
//
// Повторный запуск обновляет раздел: ряд с тем же именем пересоздаётся, остальные остаются.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (value.startsWith('--'))
      pairs.push([
        value.slice(2),
        all[index + 1] && !all[index + 1].startsWith('--') ? all[index + 1] : 'true',
      ]);
    return pairs;
  }, []),
);
const dir = path.resolve(args.dir ?? '../backlog/screens/figma');
const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')).filter((e) => e.file);
const catalog = JSON.parse(readFileSync(path.join(dir, 'titles.json'), 'utf8'));
// Порядок рядов — как в docs/screens.md; незнакомые состояния — в конец раздела.
const ORDER = [
  'loader',
  'loader-start',
  'loader-cards',
  'loader-slow',
  'connect-searching',
  'connect-manual',
  'connect-password',
  'connect-wrong-password',
  'connect-failed',
  'home',
  'home-favorites',
  'home-drawer',
  'home-room-menu',
  'home-active-elsewhere',
  'home-favorites-error',
  'room-not-found',
  'download',
  'download-unavailable',
  'desktop-home',
  'prejoin-create',
  'prejoin-join',
  'prejoin-settings',
  'prejoin-denied',
  'meeting-waiting',
  'meeting-solo',
  'meeting-grid',
  'meeting-speaker',
  'meeting-chat',
  'meeting-people',
  'meeting-participant-menu',
  'meeting-integrations',
  'meeting-more',
  'meeting-room-settings',
  'meeting-screen-tile',
  'meeting-screen',
  'meeting-control-lost',
  'meeting-recovering',
  'meeting-ended',
  'settings-list',
  'settings-01',
  'settings-02',
  'settings-03',
  'settings-04',
  'settings-04b',
  'settings-05',
  'settings-05b',
  'settings-06',
  'settings-07',
  'settings-08',
  'settings-search',
  'meeting-settings',
  'cinema-catalog',
  'cinema-detail',
  'cinema-player',
  'games-panel',
  'game-poker',
  'game-durak',
  'game-chess',
  'game-gartic',
  'games-history',
  'dialog-409',
  'dialog-favorites-full',
  'dialog-favorites-refused',
  'home-remove-confirm',
  'meeting-invite',
  'meeting-diagnostics',
  'avatar-cropper',
  'desktop-favorite-settings',
  'kit',
];
const order = (id) => (ORDER.includes(id) ? ORDER.indexOf(id) : 1000 + Object.keys(catalog).indexOf(id));
const COLUMNS = [
  [360, 'light'],
  [360, 'dark'],
  [1024, 'light'],
  [1024, 'dark'],
  [1440, 'light'],
  [1440, 'dark'],
];

if (args.groups) {
  const counts = {};
  for (const e of manifest) {
    const g = catalog[e.id]?.group ?? '?';
    counts[g] = (counts[g] ?? 0) + 1;
  }
  console.log(JSON.stringify(counts, null, 1));
  process.exit(0);
}

const group = args.group;
const ids = [...new Set(manifest.map((e) => e.id))]
  .filter((id) => catalog[id]?.group === group)
  .filter((id) => !args.rows || args.rows.split(',').includes(id))
  .sort((a, b) => order(a) - order(b));
const rows = ids.map((id) => ({
  id,
  title: catalog[id].title,
  note: catalog[id].note ?? '',
  src: catalog[id].src ?? '',
  shots: COLUMNS.map(([width, theme]) =>
    manifest.find((e) => e.id === id && e.width === width && e.theme === theme),
  )
    .filter(Boolean)
    .map((e) => [e.width, e.theme, e.cssWidth, Math.min(e.cssHeight, 3400), e.file]),
}));

const code = `
const G = ${JSON.stringify(group)};
const ROWS = ${JSON.stringify(rows.map((r) => ({ ...r, shots: r.shots.map((x) => x.slice(0, 4)) })))};
const ORDER = ${JSON.stringify(ORDER.filter((id) => ids.includes(id) || catalog[id]?.group === group))};
const rank = (id) => (ORDER.includes(id) ? ORDER.indexOf(id) : 999);
const page = figma.root.children.find((p) => p.name.startsWith('Как есть'));
await figma.setCurrentPageAsync(page);
await Promise.all(['Regular', 'Medium', 'Semi Bold', 'Bold'].map((style) => figma.loadFontAsync({ family: 'Inter', style })));
const ink = { r: 0.067, g: 0.078, b: 0.098 }, muted = { r: 0.38, g: 0.42, b: 0.48 };
const text = (chars, size, style, color = ink, width) => {
  const t = figma.createText();
  t.fontName = { family: 'Inter', style };
  t.fontSize = size;
  t.characters = chars;
  t.fills = [{ type: 'SOLID', color }];
  if (width) { t.resize(width, t.height); t.textAutoResize = 'HEIGHT'; }
  return t;
};
let section = page.children.find((n) => n.type === 'SECTION' && n.name === G);
if (!section) {
  section = figma.createSection();
  section.name = G;
  const bottom = Math.max(0, ...page.children.filter((n) => n !== section).map((n) => n.y + n.height));
  section.x = ${args.x ?? 0};
  section.y = ${args.y ?? 'bottom + 400'};
}
let stack = section.children.find((n) => n.name === G + ' · ряды');
if (!stack) {
  stack = figma.createAutoLayout('VERTICAL', { name: G + ' · ряды', itemSpacing: 200 });
  stack.fills = [];
  section.appendChild(stack);
  stack.x = 120; stack.y = 160;
  const head = text(G, 120, 'Bold');
  head.name = 'Заголовок';
  stack.appendChild(head);
}
const ids = [];
const label = { light: 'светлая', dark: 'тёмная' };
for (const row of ROWS) {
  const name = row.id + ' · ' + row.title;
  stack.children.find((n) => n.name === name)?.remove();
  const frame = figma.createAutoLayout('VERTICAL', { name, itemSpacing: 24 });
  frame.fills = [];
  // Ряд встаёт на своё место по порядку docs/screens.md, а не в конец раздела.
  const after = stack.children.findIndex((n) => n.name !== 'Заголовок' && rank(n.name.split(' · ')[0]) > rank(row.id));
  if (after >= 0) stack.insertChild(after, frame);
  else stack.appendChild(frame);
  frame.appendChild(text(row.title, 56, 'Bold'));
  const meta = [row.note, row.src ? 'Исходники: ' + row.src : '', 'Состояние: ' + row.id].filter(Boolean).join('\\n');
  frame.appendChild(text(meta, 22, 'Regular', muted, 2800));
  const cells = figma.createAutoLayout('HORIZONTAL', { name: 'кадры', itemSpacing: 64 });
  cells.fills = [];
  cells.counterAxisAlignItems = 'MIN';
  frame.appendChild(cells);
  for (const [width, theme, w, h] of row.shots) {
    const cell = figma.createAutoLayout('VERTICAL', { name: width + ' · ' + label[theme], itemSpacing: 16 });
    cell.fills = [];
    cells.appendChild(cell);
    cell.appendChild(text(width + ' px · ' + label[theme], 24, 'Semi Bold', muted));
    const shot = figma.createFrame();
    shot.name = row.id + ' / ' + width + ' / ' + theme;
    shot.resize(w, h);
    shot.clipsContent = true;
    shot.cornerRadius = width < 768 ? 24 : 8;
    shot.fills = [{ type: 'SOLID', color: { r: 0.85, g: 0.86, b: 0.88 } }];
    shot.effects = [{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.18 }, offset: { x: 0, y: 8 }, radius: 32, spread: 0, visible: true, blendMode: 'NORMAL' }];
    cell.appendChild(shot);
    ids.push(shot.id);
  }
}
section.resizeWithoutConstraints(stack.width + 240, stack.height + 280);
return { section: section.id, stack: stack.id, rows: ROWS.length, frames: ids.length, ids };
`;
// --plan: файлы в порядке создания кадров — `figma-upload.mjs` сопоставит их ссылкам по номеру.
if (args.plan)
  writeFileSync(args.plan, JSON.stringify(rows.flatMap((row) => row.shots.map((shot) => shot[4]))));
process.stdout.write(code);
