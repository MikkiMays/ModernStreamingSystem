#!/usr/bin/env node
// Чтение файла Figma через REST API (E15-B): структура, счёт кадров, рендеры для сверки.
// Токен — из .local/figma.env основного checkout (FIGMA_TOKEN, FIGMA_FILE, решение В-4); не печатается.
//
//   node scripts/figma-rest.mjs pages                 — страницы и число детей верхнего уровня
//   node scripts/figma-rest.mjs count [pageName]      — кадры (FRAME/COMPONENT/INSTANCE верхних секций) по страницам
//   node scripts/figma-rest.mjs node <id,id>          — краткое дерево узлов (глубина 2)
//   node scripts/figma-rest.mjs render <id,id> <dir>  — PNG рендеры узлов в каталог (scale 0.5)
//   node scripts/figma-rest.mjs file <key> pages      — то же для другого файла
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ENV = process.env.FIGMA_ENV ?? '/opt/ModernStreamingSystem/.local/figma.env';
const env = Object.fromEntries(
  readFileSync(ENV, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [
        l.slice(0, i).trim(),
        l
          .slice(i + 1)
          .trim()
          .replace(/^['"]|['"]$/g, ''),
      ];
    }),
);
const TOKEN = env.FIGMA_TOKEN;
let FILE = env.FIGMA_FILE;
if (!TOKEN) throw new Error('FIGMA_TOKEN не найден в ' + ENV);

let args = process.argv.slice(2);
if (args[0] === 'file') {
  FILE = args[1];
  args = args.slice(2);
}
const [cmd, a1, a2] = args;

async function get(path) {
  const r = await fetch('https://api.figma.com/v1' + path, { headers: { 'X-Figma-Token': TOKEN } });
  if (!r.ok) throw new Error(`${r.status} ${path}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

function walk(n, f, depth = 0) {
  f(n, depth);
  for (const c of n.children ?? []) walk(c, f, depth + 1);
}

if (cmd === 'pages') {
  const d = await get(`/files/${FILE}?depth=2`);
  console.log(d.name, '·', d.lastModified, '·', d.editorType);
  for (const p of d.document.children) console.log(p.id, JSON.stringify(p.name), p.children?.length ?? 0);
} else if (cmd === 'count') {
  const d = await get(`/files/${FILE}?depth=4`);
  for (const p of d.document.children) {
    if (a1 && p.name !== a1) continue;
    const kinds = {};
    let frames = 0;
    walk(p, (n, depth) => {
      kinds[n.type] = (kinds[n.type] ?? 0) + 1;
      if (depth >= 1 && n.type === 'FRAME' && n.name?.includes('·')) frames++;
    });
    console.log(
      p.id,
      JSON.stringify(p.name),
      'top',
      p.children?.length ?? 0,
      'frames·',
      frames,
      JSON.stringify(kinds),
    );
  }
} else if (cmd === 'node') {
  const d = await get(`/files/${FILE}/nodes?ids=${encodeURIComponent(a1)}&depth=2`);
  for (const [id, v] of Object.entries(d.nodes)) {
    walk(v.document, (n, depth) => console.log('  '.repeat(depth) + n.id, n.type, JSON.stringify(n.name)));
  }
} else if (cmd === 'render') {
  const dir = a2 ?? '/tmp/figma-render';
  mkdirSync(dir, { recursive: true });
  const d = await get(`/images/${FILE}?ids=${encodeURIComponent(a1)}&format=png&scale=0.5`);
  for (const [id, url] of Object.entries(d.images)) {
    if (!url) {
      console.log(id, 'нет рендера');
      continue;
    }
    const r = await fetch(url);
    const out = join(dir, id.replace(/[:;]/g, '-') + '.png');
    writeFileSync(out, Buffer.from(await r.arrayBuffer()));
    console.log(id, out);
  }
} else {
  console.log('команды: pages | count [page] | node <ids> | render <ids> <dir> | file <key> …');
}
