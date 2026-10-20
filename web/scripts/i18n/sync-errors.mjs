// Переносит русские тексты ошибок из реестра ядра (contracts/errors.json) в каталог `ru`.
//
//   node scripts/i18n/sync-errors.mjs          # обновить web/src/i18n/locales/ru.json
//   node scripts/i18n/sync-errors.mjs --check  # CI: каталог совпадает с реестром
//
// Вставки ядра (`{}` в реестре) в каталоге не нужны: по-русски показывается `detail` ядра как
// есть, а для других языков — общий текст по коду, без чисел из сообщения.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const registry = JSON.parse(readFileSync(new URL('../../../contracts/errors.json', import.meta.url), 'utf8'));
const target = fileURLToPath(new URL('../../src/i18n/locales/ru.json', import.meta.url));
const catalog = JSON.parse(readFileSync(target, 'utf8'));
const errors = Object.fromEntries(
  Object.entries(registry).map(([code, entry]) => [code, entry.ru.replaceAll('{}', '…').replace(/\s+…/g, ' …')]),
);
const next = JSON.stringify({ ...catalog, errors }, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== next) {
    console.error('ru.json отстал от contracts/errors.json: node scripts/i18n/sync-errors.mjs');
    process.exit(1);
  }
} else writeFileSync(target, next);
