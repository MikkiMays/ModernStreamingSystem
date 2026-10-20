#!/usr/bin/env node
// Код для `use_figma` (E15-A): страница «Движение» из инвентаря
// `docs/superpowers/specs/2026-10-20-motion-inventory.md` — таблицы по областям слоями текста.
//
//   node scripts/figma-motion.mjs --areas 1,2,3      → JS разделов 3.1–3.3 в stdout
//   node scripts/figma-motion.mjs --list             → области и число строк
//
// Повторный запуск пересоздаёт раздел с тем же именем.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = readFileSync(path.join(root, 'docs/superpowers/specs/2026-10-20-motion-inventory.md'), 'utf8');

/** Markdown-строку таблицы — в ячейки без разметки (`код`, **жирный**). */
const cells = (line) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\*\*/g, '').replace(/`/g, '').replace(/\\\|/g, '|'));

const areas = [];
let current = null;
let heading = null;
for (const line of source.split('\n')) {
  const head = /^### 3\.(\d+) (.+)$/.exec(line);
  if (head) {
    heading = { n: Number(head[1]), title: head[2] };
    current = { n: Number(head[1]), title: head[2], rows: [], header: null, notes: [] };
    areas.push(current);
    continue;
  }
  if (/^## 4\./.test(line)) current = null;
  if (!current) continue;
  const sub = /^#### (.+)$/.exec(line);
  if (sub) {
    // Подраздел (игры): своя таблица с тем же номером области.
    if (!current.rows.length) areas.splice(areas.indexOf(current), 1);
    current = {
      n: heading.n,
      title: `${heading.title} — ${sub[1]}`,
      sub: true,
      rows: [],
      header: null,
      notes: [],
    };
    areas.push(current);
    continue;
  }
  if (line.startsWith('|')) {
    if (/^\|\s*-{3}/.test(line)) continue;
    const row = cells(line);
    if (!current.header) current.header = row;
    else if (row.join() !== current.header.join()) current.rows.push(row);
  } else if (line.trim() && current.rows.length && !line.startsWith('#')) {
    current.notes.push(line.trim().replace(/`/g, '').replace(/\*\*/g, ''));
  }
}

if (args.list) {
  for (const a of areas) console.log(`${a.n} ${a.title}: ${a.rows.length}`);
  console.log(
    'всего',
    areas.reduce((s, a) => s + a.rows.length, 0),
  );
  process.exit(0);
}

const chosen = args.areas.split(',').map(Number);
const data = areas
  .filter((a) => chosen.includes(a.n))
  .map((a) => ({ title: `3.${a.n} ${a.title}`, header: a.header, rows: a.rows, notes: a.notes.join(' ') }));

const code = `
const AREAS = ${JSON.stringify(data)};
const page = figma.root.children.find((p) => p.name === 'Движение');
await figma.setCurrentPageAsync(page);
await Promise.all(['Regular', 'Medium', 'Semi Bold', 'Bold'].map((style) => figma.loadFontAsync({ family: 'Inter', style })));
const ink = { r: 0.067, g: 0.078, b: 0.098 }, muted = { r: 0.38, g: 0.42, b: 0.48 }, line = { r: 0.88, g: 0.89, b: 0.92 }, warn = { r: 0.75, g: 0.2, b: 0.15 };
const W = [460, 420, 420, 240, 260, 300, 460];
const text = (chars, size, style, color = ink, width) => {
  const t = figma.createText();
  t.fontName = { family: 'Inter', style }; t.fontSize = size; t.characters = chars || '—';
  t.fills = [{ type: 'SOLID', color }];
  t.lineHeight = { unit: 'PERCENT', value: 135 };
  if (width) { t.resize(width, t.height); t.textAutoResize = 'HEIGHT'; }
  return t;
};
const out = [];
let y = Math.max(0, ...page.children.filter((n) => n.type === 'SECTION').map((n) => n.y + n.height)) + 240;
for (const area of AREAS) {
  page.children.find((n) => n.type === 'SECTION' && n.name === area.title)?.remove();
  const section = figma.createSection();
  section.name = area.title;
  section.x = 0; section.y = y;
  const table = figma.createAutoLayout('VERTICAL', { name: 'Таблица · ' + area.title, itemSpacing: 0 });
  table.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  table.cornerRadius = 16; table.clipsContent = true;
  table.strokes = [{ type: 'SOLID', color: line }]; table.strokeWeight = 1;
  section.appendChild(table);
  table.x = 80; table.y = 220;
  const head = text(area.title, 56, 'Bold'); section.appendChild(head); head.x = 80; head.y = 80;
  const rowFrame = (values, header) => {
    const row = figma.createAutoLayout('HORIZONTAL', { name: header ? 'Заголовок' : (values[0].match(/^\\S+/) || ['строка'])[0] });
    row.fills = header ? [{ type: 'SOLID', color: { r: 0.95, g: 0.96, b: 0.98 } }] : [];
    row.strokes = [{ type: 'SOLID', color: line }]; row.strokeBottomWeight = 1; row.strokeTopWeight = 0; row.strokeLeftWeight = 0; row.strokeRightWeight = 0;
    table.appendChild(row);
    values.forEach((value, i) => {
      const cell = figma.createAutoLayout('VERTICAL', { name: header ? value : 'ячейка' });
      cell.paddingLeft = 16; cell.paddingRight = 16; cell.paddingTop = 14; cell.paddingBottom = 14; cell.fills = [];
      row.appendChild(cell);
      const bad = !header && i === 6 && /не обработано/i.test(value);
      cell.appendChild(text(value, header ? 18 : 16, header ? 'Semi Bold' : i === 0 ? 'Medium' : 'Regular', bad ? warn : header ? muted : ink, W[i] - 32));
    });
    row.counterAxisAlignItems = 'MIN';
  };
  rowFrame(area.header, true);
  for (const r of area.rows) rowFrame(r, false);
  let bottom = table.y + table.height;
  if (area.notes) { const n = text(area.notes, 20, 'Regular', muted, 2400); section.appendChild(n); n.x = 80; n.y = bottom + 40; bottom = n.y + n.height; }
  section.resizeWithoutConstraints(Math.max(table.width, 2400) + 160, bottom + 120);
  out.push({ area: area.title, section: section.id, rows: area.rows.length });
  y = section.y + section.height + 240;
}
return out;
`;
process.stdout.write(code);
