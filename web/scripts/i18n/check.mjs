// Храповик переводов (E14-A): русских строк интерфейса в коде не становится больше.
//
//   node scripts/i18n/check.mjs            # CI: падает, если в файле русских строк стало больше
//   node scripts/i18n/check.mjs --update   # записать нынешние числа как новую базу
//
// Строки выносятся в `src/i18n/locales/` эпиком, который переписывает экран (DECISIONS.md, решение
// архитектора 12), поэтому сразу «ноль» не требуется. Требуется другое: новый файл пишется через
// переводы, а в старом число строк с кириллицей только уменьшается. База — `baseline.json` рядом.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../src/', import.meta.url));
const baselineFile = fileURLToPath(new URL('./baseline.json', import.meta.url));
const CYRILLIC = /[А-Яа-яЁё]/;

function* sources(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== 'i18n') yield* sources(full);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) yield full;
  }
}

/** Строки с кириллицей вне комментариев: литералы и текст JSX. */
function count(text) {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  return code.split('\n').filter((line) => CYRILLIC.test(line)).length;
}

const current = {};
for (const file of sources(root)) {
  const n = count(readFileSync(file, 'utf8'));
  if (n) current[path.relative(root, file).replaceAll('\\', '/')] = n;
}

if (process.argv.includes('--update')) {
  writeFileSync(baselineFile, JSON.stringify(current, null, 2) + '\n');
  console.log(`База: ${Object.keys(current).length} файлов, ${Object.values(current).reduce((a, b) => a + b, 0)} строк`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(baselineFile, 'utf8'));
const grown = Object.entries(current).filter(([file, n]) => n > (baseline[file] ?? 0));
for (const [file, n] of grown)
  console.error(`${file}: русских строк ${n}, было ${baseline[file] ?? 0} — вынесите тексты в src/i18n/locales`);
const total = Object.values(current).reduce((a, b) => a + b, 0);
const before = Object.values(baseline).reduce((a, b) => a + b, 0);
console.log(`Русских строк в коде: ${total} (база ${before})`);
process.exit(grown.length ? 1 : 0);
