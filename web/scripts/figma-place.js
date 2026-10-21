// Раскладка страницы карты продукта (E15-B) — код для `use_figma` после `figma-layers.js`.
// PLAN — вывод `figma-plan.mjs --page <страница> --json`. Шапка страницы сверху, дальше разделы
// (узлы SECTION): шапка раздела, под ней ряды — карточка описания и кадры 360 → 1440, светлая →
// тёмная, у каждого кадра подпись. Повторный запуск раскладывает заново то, что уже стоит.
const PLAN = __PLAN__;
const page = figma.root.children.find((p) => p.name === PLAN.page);
await figma.setCurrentPageAsync(page);
await figma.loadFontAsync({ family: 'Inter', style: 'Medium' });
await figma.loadFontAsync({ family: 'Inter', style: 'Semi Bold' });
const all = page.children.flatMap((n) =>
  n.type === 'SECTION'
    ? n.children.flatMap((c) =>
        c.name.startsWith('ряд · ')
          ? c.children.flatMap((k) => (k.type === 'FRAME' && k.name.startsWith('кадр · ') ? k.children : [k]))
          : [c],
      )
    : [n],
);
const byName = new Map();
for (const n of all) byName.set(n.name, n);
const GAP = 64;
const header = byName.get(`страница · ${PLAN.slug}`);
if (header) {
  page.appendChild(header);
  header.x = 0;
  header.y = 0;
}
let y = header ? header.height + 160 : 0;
const created = [];
const THEME = { light: 'светлая', dark: 'тёмная' };
for (const [i, s] of PLAN.sections.entries()) {
  const name = `${i + 1}. ${s.name}`;
  let section = page.children.find((n) => n.type === 'SECTION' && n.name === name);
  if (!section) {
    section = figma.createSection();
    section.name = name;
    created.push(section.id);
  }
  section.x = 0;
  section.y = y;
  let sy = 80;
  const head = byName.get(`раздел · ${PLAN.slug} · ${i + 1}`);
  if (head) {
    section.appendChild(head);
    head.x = 80;
    head.y = sy;
    sy += head.height + 80;
  }
  let maxW = 1400;
  for (const id of s.states) {
    const frames = [...byName.values()]
      .filter(
        (n) =>
          n.type === 'FRAME' &&
          n.name.startsWith(`${id} · `) &&
          /^\S+ · \d+ · (светлая|тёмная)$/.test(n.name),
      )
      .filter((n) => n.name.split(' · ')[0] === id)
      .sort(
        (a, b) =>
          Number(a.name.split(' · ')[1]) - Number(b.name.split(' · ')[1]) ||
          (a.name.endsWith('светлая') ? -1 : 1),
      );
    const card = byName.get(`карточка · ${id}`);
    if (!frames.length && !card) continue;
    let row = section.children.find((n) => n.name === `ряд · ${id}`);
    if (!row) {
      row = figma.createAutoLayout('HORIZONTAL', { name: `ряд · ${id}`, itemSpacing: GAP });
      row.fills = [];
      row.clipsContent = false;
      section.appendChild(row);
      created.push(row.id);
    }
    row.counterAxisAlignItems = 'MIN';
    if (card) row.appendChild(card);
    for (const f of frames) {
      const [, w, theme] = f.name.split(' · ');
      let col = row.children.find((n) => n.name === `кадр · ${f.name}`);
      if (!col) {
        col = figma.createAutoLayout('VERTICAL', { name: `кадр · ${f.name}`, itemSpacing: 12 });
        col.fills = [];
        col.clipsContent = false;
        const cap = figma.createText();
        cap.fontName = { family: 'Inter', style: 'Medium' };
        cap.fontSize = 14;
        cap.characters = `${w} px · ${theme}`;
        cap.fills = [{ type: 'SOLID', color: { r: 0.37, g: 0.41, b: 0.47 } }];
        col.appendChild(cap);
      }
      row.appendChild(col);
      col.appendChild(f);
      f.clipsContent = true;
    }
    row.x = 80;
    row.y = sy;
    sy += row.height + 120;
    maxW = Math.max(maxW, row.width + 160);
  }
  if (head) head.resize(Math.max(head.width, 1200), head.height);
  section.resizeWithoutConstraints(maxW, sy);
  y += sy + 200;
}
const rows = page.findAll((n) => n.name.startsWith('ряд · ')).length;
const shots = page.findAll((n) => n.type === 'FRAME' && /^\S+ · \d+ · (светлая|тёмная)$/.test(n.name)).length;
return {
  sections: PLAN.sections.length,
  rows,
  frames: shots,
  created: created.length,
  height: Math.round(y),
};
