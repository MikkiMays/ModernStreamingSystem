#!/usr/bin/env node
// docs/screens.md из каталога (`screens-catalog.mjs`) и файлов Figma (E15-B, T57): у каждого состояния —
// описание, исходники, как открыть и ссылка на его ряд в карте продукта. Узлы рядов («ряд · <id>»)
// читаются REST API с personal-токеном из .local/figma.env (В-4); токен не печатается.
//
//   node scripts/screens-doc.mjs [--out ../docs/screens.md]
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PAGES, STATES, FILES, COVER } from './screens-catalog.mjs';

const KEYS = {
  map1: 'tC9u0tOLZ28FwcB8PT5v6U',
  map2: '0twoxdjTpxbDluBJfVxK6G',
  map3: 'Lrzdrqv6gQsDafGfiQnDqU',
  map4: 'iCNC53lDOA6gJDSjsl7sh4',
  asis: 'X7lD00UAOuZfH4hL0S4bxA',
};
const env = Object.fromEntries(
  readFileSync(process.env.FIGMA_ENV ?? '/opt/ModernStreamingSystem/.local/figma.env', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [
      l.slice(0, l.indexOf('=')).trim(),
      l
        .slice(l.indexOf('=') + 1)
        .trim()
        .replace(/^['"]|['"]$/g, ''),
    ]),
);
const get = async (p) => {
  // 429 — подождать, сколько просит Figma (Retry-After), и повторить.
  for (let attempt = 1; ; attempt++) {
    const r = await fetch('https://api.figma.com/v1' + p, { headers: { 'X-Figma-Token': env.FIGMA_TOKEN } });
    if (r.ok) return r.json();
    if (r.status !== 429 || attempt >= 2) throw new Error(`${r.status} ${p}`);
    const wait = Math.min(120, Number(r.headers.get('retry-after')) || 30 * attempt);
    console.error(`429, жду ${wait} с`);
    await new Promise((resolve) => setTimeout(resolve, wait * 1000));
  }
};
const link = (key, id) => `https://www.figma.com/design/${key}/?node-id=${id.replace(':', '-')}`;

// Узлы: страница → разделы → ряды и кадры. Снимок узлов (`--nodes`, его пишет чтение файлов через
// use_figma) — первым: REST на Starter быстро упирается в 429. Недостающее — REST, если пустит.
const nodesFile = process.argv.includes('--nodes') ? process.argv[process.argv.indexOf('--nodes') + 1] : null;
const nodes = nodesFile ? JSON.parse(readFileSync(nodesFile, 'utf8')) : {};
const counts = {};
for (const [name, n] of Object.entries(nodes))
  counts[name] = { rows: n.rowCount ?? Object.keys(n.rows).length, frames: n.frames };
for (const f of FILES.filter((x) => x.key !== 'asis')) {
  if (f.pages.every((p) => nodes[p] && Object.keys(nodes[p].rows).length)) continue;
  const key = KEYS[f.key];
  try {
    const doc = await get(`/files/${key}?depth=4`);
    for (const page of doc.document.children) {
      nodes[page.name] = { key, page: page.id, sections: {}, rows: {} };
      let frames = 0;
      for (const s of page.children ?? []) {
        if (s.type === 'SECTION') nodes[page.name].sections[s.name] = s.id;
        for (const r of s.children ?? [])
          if (r.name?.startsWith('ряд · ')) {
            nodes[page.name].rows[r.name.slice(6)] = r.id;
            frames += (r.children ?? []).filter((c) => c.name?.startsWith('кадр · ')).length;
          }
      }
      counts[page.name] = { rows: Object.keys(nodes[page.name].rows).length, frames };
    }
    if (nodesFile) writeFileSync(nodesFile, JSON.stringify(nodes, null, 1));
  } catch (error) {
    console.error(`${f.name}: ${error.message} — ссылки на страницы`);
  }
}
// Страницы файла E15-A известны: «Как есть» 0:1, «Флоу» 3:4, «Движение» 3:5.
const flowsPage = { id: '3:4' };
const motionPage = { id: '3:5' };

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|');
const total = Object.values(counts).reduce(
  (a, c) => ({ rows: a.rows + c.rows, frames: a.frames + c.frames }),
  { rows: 0, frames: 0 },
);
let md = `# Экраны Cord: карта продукта, описания, рецепты

Каждый экран и состояние Cord — что это, кто и откуда сюда попадает, правила, задачи владельца, компоненты набора,
исходники, как открыть и где он в Figma. Карта продукта E15-B (T57, T29) на 21.10.2026: снято со стенда
https://cord.nikg.tech (\`main\`), невыкаченное на стенд (E13, E14-B, E01-B2) — dev-сервером ветки с прокси к стенду.
Файл генерируется: \`node web/scripts/screens-doc.mjs\` из \`web/scripts/screens-catalog.mjs\` и узлов Figma —
правится каталог, а не этот файл.

> ${COVER.lead}

## Где что в Figma

План Starter даёт три страницы на файл (решение В-4: при нехватке — новые файлы в черновиках), поэтому карта —
четыре файла; «как есть», флоу и движение — в файле E15-A.

| Файл | Страницы |
| --- | --- |
${FILES.map((f) => `| [${esc(f.name)}](https://www.figma.com/design/${KEYS[f.key]}) | ${f.pages.map((p) => (nodes[p] ? `[${p}](${link(nodes[p].key, nodes[p].page)})` : p === 'Флоу' ? `[Флоу](${link(KEYS.asis, flowsPage.id)})` : p === 'Движение' ? `[Движение](${link(KEYS.asis, motionPage.id)})` : p)).join(', ')} |`).join('\n')}

- **Счёт:** ${Object.keys(STATES).length} состояний в каталоге, ${total.rows} рядов и ${total.frames} кадров на страницах карты
  (${Object.entries(counts)
    .filter(([, c]) => c.rows)
    .map(([p, c]) => `${p} — ${c.rows}/${c.frames}`)
    .join('; ')}); 18 флоу с
  прототипом; 136 строк движения и 8 прототипов Smart Animate.
- **Кадр** — слои (SVG из живой страницы, \`web/scripts/dom-svg.mjs\`): текст — текстом Inter, цвета привязаны к
  переменным «Цвет · светлая/тёмная», значки — векторами. Ширины 360 / 1024 / 1440 (окна клиента — свои размеры), обе
  темы; оболочка Electron — только тёмная, как в продукте.
- **Ряд** — карточка описания слева и кадры; ссылка «ряд» ниже ведёт на него.
- **Снять заново:** из \`web/\` — \`node --experimental-transform-types scripts/figma-screens.mjs --svg --toggle-theme
  [--only id,…]\`; встреча — сценарии \`meeting\` и \`meeting-b\` (одна созданная встреча на сценарий: ядро считает
  10 новых встреч в час с адреса). Выгрузка — \`figma-plan.mjs\` → \`figma-svg-upload.mjs\` → \`figma-layers.js\` и
  \`figma-place.js\` (код для \`use_figma\`); карточки — \`figma-cards.mjs\`; аудит — \`figma-audit.mjs\`.
`;

for (const [page, p] of Object.entries(PAGES)) {
  const n = nodes[page];
  md += `\n## ${page}\n\n${p.about}${n ? ` [Страница в Figma](${link(n.key, n.page)}).` : ''}\n`;
  p.sections.forEach((s, i) => {
    const sid = n?.sections[`${i + 1}. ${s.name}`];
    md += `\n### ${s.name}${sid ? ` · [раздел](${link(n.key, sid)})` : ''}\n\n| Состояние | Что это · кто и откуда | Правила и состояния | Задачи | Набор | Исходники · как открыть | Figma |\n| --- | --- | --- | --- | --- | --- | --- |\n`;
    for (const id of s.states) {
      const st = STATES[id];
      const row = n?.rows[id];
      md += `| **${esc(st.title)}** \`${id}\` | ${esc(st.what)} ${esc(st.who)} | ${esc(st.rules)} | ${esc(st.tasks)} | ${esc(st.kit)} | ${esc(st.src)}. ${esc(st.how)} | ${row ? `[ряд](${link(n.key, row)})` : '—'} |\n`;
    }
  });
}

md += `
## Чего здесь нет и почему

- **Музыка — найденное и «Сейчас играет»**: поле поиска и плеер появляются, когда музыку добавили во встречу; бот
  музыки держит комнату на стенде открытой, поэтому снята только встреча без бота (выбор площадки, вкладки, «Свои
  файлы», «Яндекс Музыка»).
- **«Встреча завершится в …»** (E11-B): \`endsAt\` ядро присылает только за 15 минут до 24-часового потолка; подставить
  его в снимок встречи не удалось — ряд с описанием без кадров.
- **Окно выбора источника показа в вебе клиента** (E01-B2): ему нужна встреча с медиа, а E01-B2 на стенде ещё не
  выкачен; через dev-сервер медиа не поднимается — ряд с описанием, вид окна — «Что показать» оболочки.
- **Игровые листы и окна** (настройки стола, счёт, итог партии, превращение пешки, реакции), установщик Windows и
  уведомление Android-приложения — не сняты (нет повторяемого рецепта / не веб).
`;
const out = path.resolve(
  process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : '../docs/screens.md',
);
writeFileSync(out, md);
console.log(`${out}: ${Object.keys(STATES).length} состояний, рядов ${total.rows}, кадров ${total.frames}`);
console.log(JSON.stringify(counts));
