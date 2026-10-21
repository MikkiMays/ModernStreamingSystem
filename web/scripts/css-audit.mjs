#!/usr/bin/env node
/**
 * Сколько разных литералов живёт в CSS: цвета, радиусы, тени, размеры шрифта, z-index,
 * `!important`, длительности. Цифры «до» и «после» миграции на токены (E16, шаг 5).
 *
 *   node scripts/css-audit.mjs            — сводка по web/src
 *   node scripts/css-audit.mjs --per-file — плюс таблица по файлам
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..', 'src');
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (name.endsWith('.css')) files.push(path);
  }
})(root);

// Комментарии не считаются: в них живут объяснения вида «`z-index: 12` у полосы», а не правила.
const sources = files.map((path) => ({
  path: relative(root, path),
  text: readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''),
}));
const normalize = (value) => value.replace(/\s+/g, ' ').trim().toLowerCase();

function count(pattern) {
  const distinct = new Set();
  const perFile = {};
  let total = 0;
  for (const { path, text } of sources) {
    const matches = text.match(pattern) ?? [];
    total += matches.length;
    perFile[path] = matches.length;
    for (const match of matches) distinct.add(normalize(match));
  }
  return { distinct: distinct.size, total, perFile, values: distinct };
}

const report = {
  'hex-цвета': count(/#[0-9a-f]{3,8}\b/gi),
  'rgb/hsl': count(/(?:rgb|hsl)a?\([^)]*\)/gi),
  'border-radius': count(/border-radius:\s*[^;]+/g),
  'box-shadow': count(/box-shadow:\s*[^;]+/g),
  'font-size': count(/font-size:\s*[^;]+/g),
  'z-index': count(/z-index:\s*[^;]+/g),
  '!important': count(/!important/g),
  transition: count(/transition:\s*[^;]+/g),
  длительности: count(/\b\d+(?:\.\d+)?m?s\b/g),
};

const lines = sources.reduce((sum, { text }) => sum + text.split('\n').length, 0);
console.log(`Файлов CSS: ${files.length}, строк: ${lines}`);
console.log('вид'.padEnd(16) + 'разных'.padStart(8) + 'всего'.padStart(8));
for (const [kind, { distinct, total }] of Object.entries(report))
  console.log(kind.padEnd(16) + String(distinct).padStart(8) + String(total).padStart(8));

if (process.argv.includes('--per-file')) {
  console.log(
    '\nфайл'.padEnd(32) + 'hex'.padStart(6) + 'font'.padStart(6) + '!imp'.padStart(6) + 'z'.padStart(4),
  );
  for (const { path } of sources)
    console.log(
      path.padEnd(32) +
        String(report['hex-цвета'].perFile[path]).padStart(6) +
        String(report['font-size'].perFile[path]).padStart(6) +
        String(report['!important'].perFile[path]).padStart(6) +
        String(report['z-index'].perFile[path]).padStart(4),
    );
}
if (process.argv.includes('--values')) {
  for (const kind of ['border-radius', 'box-shadow', 'font-size', 'z-index'])
    console.log(`\n${kind}:`, [...report[kind].values].sort().join(' | '));
}
