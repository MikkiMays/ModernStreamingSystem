// Храповик переводов (E14-A): строк с кириллицей в коде не становится больше.
//
//   node scripts/i18n/check.mjs            # CI: падает, если в каком-то файле таких строк стало больше
//   node scripts/i18n/check.mjs --update   # записать нынешние числа как новую базу (после выноса строк)
//
// Текст интерфейса живёт в `src/i18n/locales/` (скилл `cord-i18n`). В коде кириллица остаётся только
// там, где это не текст интерфейса: разбор русского ввода, образцы витрины `/kit`, сравнение с тем, что
// прислал сервер. Считаются литералы — строки, шаблоны, текст JSX и регулярные выражения — разбором
// TypeScript, так что комментарии и `image/*` внутри строки счёт не путают. Новый файл с кириллицей и
// рост в старом — ошибка; уменьшение — повод записать базу заново. База — `baseline.json` рядом.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../../src/', import.meta.url));
const baselineFile = fileURLToPath(new URL('./baseline.json', import.meta.url));
const CYRILLIC = /[А-Яа-яЁё]/;
const LITERALS = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateExpression,
  ts.SyntaxKind.JsxText,
  ts.SyntaxKind.RegularExpressionLiteral,
]);

function* sources(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== 'i18n') yield* sources(full);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts'))
      yield full;
  }
}

/** Литералы с кириллицей; шаблон считается один раз, сколько бы частей в нём ни было. */
function count(file) {
  const text = readFileSync(file, 'utf8');
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  let n = 0;
  const visit = (node) => {
    if (LITERALS.has(node.kind)) {
      if (CYRILLIC.test(node.getText(source))) n++;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return n;
}

const current = {};
for (const file of sources(root)) {
  const n = count(file);
  if (n) current[path.relative(root, file).replaceAll('\\', '/')] = n;
}
const total = (counts) => Object.values(counts).reduce((a, b) => a + b, 0);

if (process.argv.includes('--update')) {
  const sorted = Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(baselineFile, JSON.stringify(sorted, null, 2) + '\n');
  console.log(`База: ${Object.keys(current).length} файлов, ${total(current)} строк`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(baselineFile, 'utf8'));
const grown = Object.entries(current).filter(([file, n]) => n > (baseline[file] ?? 0));
for (const [file, n] of grown)
  console.error(
    `${file}: строк с кириллицей ${n}, было ${baseline[file] ?? 0} — текст интерфейса выносится в src/i18n/locales (скилл cord-i18n)`,
  );
console.log(`Строк с кириллицей в коде: ${total(current)} (база ${total(baseline)})`);
process.exit(grown.length ? 1 : 0);
