// Полнота переводов (E14-B): каждый ключ ru есть в языке, вставки и разметка те же, формы числа — свои.
//
//   node scripts/i18n/coverage.mjs   # CI: падает, если у языка из TRANSLATED чего-то не хватает
//
// Язык попадает в `TRANSLATED` (`src/i18n/languages.ts`) — и браузер с этим языком получает его сам —
// только когда здесь у него ноль замечаний. Новый ключ ru без переводов роняет проверку: его переводят
// на все языки из `TRANSLATED` в том же изменении (скилл `cord-i18n`).
//
// Что сверяется по каждому ключу ru:
// - ключ есть и не пустой (пустой ru `""` — осознанное «нет текста» — пустой и в языке);
// - вставки `{{name}}` — те же имена (у форм числа — объединение по формам);
// - разметка `<b>…</b>`, `<time/>` для `<Trans>` — те же теги;
// - формы числа: у группы ru `x_one/_few/_many/_other` в языке ровно формы его `Intl.PluralRules`
//   (en, de — one/other; es, fr, it, pt-BR — one/many/other; zh-Hans — other). Ключ ru без форм, но
//   с `{{count}}`, язык может дать формами: русскому они были не нужны («52 карт» не склонялось);
// - лишних ключей нет; кириллицы в тексте нет (кроме `CYRILLIC_ALLOWED` — русский пример по смыслу).
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const PLURAL = /_(zero|one|two|few|many|other)$/;
const CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'];
const CYRILLIC = /[А-Яа-яЁё]/;
/** Ключи, где кириллица в другом языке — по смыслу (пусто, пока такого нет). */
export const CYRILLIC_ALLOWED = new Set([]);

const locales = new URL('../../src/i18n/locales/', import.meta.url);

/** Листья каталога: `путь.ключа` → текст. */
export function leaves(node, prefix = '', out = new Map()) {
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') leaves(value, path, out);
    else out.set(path, value);
  }
  return out;
}

const variables = (text) => [...String(text).matchAll(/\{\{\s*([^}\s,]+)[^}]*\}\}/g)].map((m) => m[1]);
const tags = (text) => [...String(text).matchAll(/<\/?[a-zA-Z][\w-]*\s*\/?>/g)].map((m) => m[0].replace(/\s/g, ''));
const sameSet = (a, b) => {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
};
const sameBag = (a, b) => [...a].sort().join('|') === [...b].sort().join('|');

/** Формы числа языка — так их выбирает i18next (`Intl.PluralRules` по коду языка). */
export function pluralCategories(language) {
  const found = new Intl.PluralRules(language).resolvedOptions().pluralCategories;
  return CATEGORIES.filter((category) => found.includes(category));
}

/**
 * Сверка каталога языка с ru. `problems` — по строке на замечание; `total` — ключей (групп форм) в ru,
 * `covered` — сколько из них в языке есть полностью и без замечаний.
 */
export function audit(ruCatalog, catalog, language) {
  const ru = leaves(ruCatalog);
  const target = leaves(catalog);
  const categories = pluralCategories(language);
  const problems = [];
  const used = new Set();
  // Ключи ru по основам: `x_one`, `x_few` … → основа `x`.
  const groups = new Map();
  for (const [key, text] of ru) {
    const base = PLURAL.test(key) ? key.replace(PLURAL, '') : key;
    const group = groups.get(base) ?? { plural: false, texts: [] };
    if (PLURAL.test(key)) group.plural = true;
    group.texts.push(text);
    groups.set(base, group);
  }
  let covered = 0;
  for (const [base, group] of groups) {
    const before = problems.length;
    const forms = categories.map((category) => `${base}_${category}`);
    const hasForms = forms.some((key) => target.has(key));
    const pluralHere = group.plural || (hasForms && group.texts.some((t) => variables(t).includes('count')));
    const keys = pluralHere ? forms : [base];
    const texts = [];
    for (const key of keys) {
      if (!target.has(key)) {
        problems.push(`${key}: нет перевода`);
        continue;
      }
      used.add(key);
      const text = target.get(key);
      if (typeof text !== 'string') problems.push(`${key}: не строка`);
      else texts.push([key, text]);
    }
    if (texts.length < keys.length) continue;
    const ruText = group.texts.join('\n');
    const ruEmpty = group.texts.every((t) => t === '');
    for (const [key, text] of texts) {
      if (ruEmpty !== (text === '')) problems.push(`${key}: ${ruEmpty ? 'в ru пусто' : 'пусто'}`);
      if (CYRILLIC.test(text) && !CYRILLIC_ALLOWED.has(key)) problems.push(`${key}: кириллица «${text}»`);
      const extra = variables(text).filter((name) => !variables(ruText).includes(name));
      if (extra.length) problems.push(`${key}: лишние вставки ${extra.join(', ')}`);
    }
    const all = texts.map(([, text]) => text).join('\n');
    if (!sameSet(variables(all), variables(ruText)))
      problems.push(`${base}: вставки ${[...new Set(variables(all))]} вместо ${[...new Set(variables(ruText))]}`);
    const ruTags = group.texts.flatMap(tags);
    if (group.plural || pluralHere) {
      if (!sameSet(texts.flatMap(([, t]) => tags(t)), ruTags)) problems.push(`${base}: разметка не та`);
    } else if (!sameBag(tags(all), ruTags)) problems.push(`${base}: разметка ${tags(all)} вместо ${ruTags}`);
    if (problems.length === before) covered++;
  }
  for (const key of target.keys()) if (!used.has(key)) problems.push(`${key}: лишний ключ (в ru нет)`);
  return { total: groups.size, covered, problems };
}

/** `LANGUAGES` и `TRANSLATED` из `src/i18n/languages.ts` — без своей копии списка. */
export async function languages() {
  const source = readFileSync(new URL('../../src/i18n/languages.ts', import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const module = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
  return { LANGUAGES: module.LANGUAGES, TRANSLATED: module.TRANSLATED, SOURCE: module.SOURCE_LANGUAGE };
}

export function catalog(language) {
  return JSON.parse(readFileSync(new URL(`${language}.json`, locales), 'utf8'));
}

async function main() {
  const { LANGUAGES, TRANSLATED, SOURCE } = await languages();
  const ru = catalog(SOURCE);
  let failed = false;
  for (const language of LANGUAGES) {
    if (language === SOURCE) continue;
    const { total, covered, problems } = audit(ru, catalog(language), language);
    const translated = TRANSLATED.includes(language);
    const mark = problems.length ? (translated ? 'ОШИБКА' : 'не готов') : 'готов';
    console.log(`${language}: ${covered}/${total} ключей, замечаний ${problems.length} — ${mark}${translated ? ' (TRANSLATED)' : ''}`);
    if (problems.length && translated) {
      failed = true;
      for (const problem of problems.slice(0, 50)) console.error(`  ${language} ${problem}`);
      if (problems.length > 50) console.error(`  … и ещё ${problems.length - 50}`);
    }
  }
  if (failed)
    console.error(
      'Языку из TRANSLATED не хватает перевода: переведите новые ключи ru на все языки (скилл cord-i18n) или уберите язык из TRANSLATED.',
    );
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
export const localesDir = fileURLToPath(locales);
