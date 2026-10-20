// Голос продукта (T54): в том, что видит человек, нет ссылок на исходники и «поставь себе».
//
//   node scripts/product-voice.mjs        # CI: находки — ошибка, по строке на каждую
//
// Cord — продукт, а не open-source (решение владельца 18.10.2026): репозитории приватные, и ссылка
// на них для человека — 404. Проверяются тексты, которые человек читает: каталоги переводов веба,
// `index.html`, манифест и `robots.txt`, тексты отказов ядра (`contracts/errors.json`), строки
// Telegram-бота и адреса в коде веба. Внутренние `docs/` и комментарии не проверяются — их не видят.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Что не говорит продукт — и почему. Слова — корнями: «свой сервер», «своего сервера». */
export const FORBIDDEN = [
  [/github\.com|gitlab\.com|bitbucket\.org|codeberg\.org/i, "ссылка на хостинг исходников"],
  [/исходн\S*\s+код|исходник/i, "«исходный код»"],
  [/open[\s-]?source|опен[\s-]?сорс|открыт\S*\s+исходн/i, "«open-source»"],
  [/постав\S*\s+(себе|у себя)|установ\S*\s+(себе|у себя)\s+(сервер|cord)/i, "«поставь себе»"],
  [/(^|[^а-яё])сво(й|его|ём|ем|ему|им)\s+сервер/i, "«свой сервер»"],
  [/адрес\S*\s+сервер/i, "«адрес сервера»"],
  [/setup\.sh|update\.sh/i, "скрипты развёртывания"],
  [/репозитори/i, "«репозиторий»"],
];

/** Находки в одной строке текста: `[{reason, text}]`. */
export function check(text) {
  return FORBIDDEN.filter(([pattern]) => pattern.test(text)).map(([, reason]) => ({
    reason,
    text,
  }));
}

/** Все строковые значения JSON с путём ключа. */
export function* jsonStrings(value, at = "") {
  if (typeof value === "string") yield [at, value];
  else if (Array.isArray(value))
    for (const [i, item] of value.entries()) yield* jsonStrings(item, `${at}[${i}]`);
  else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value))
      yield* jsonStrings(item, at ? `${at}.${key}` : key);
}

/** Строки Python без комментариев: то, что бот может сказать человеку. */
export function pythonText(source) {
  return source
    .split("\n")
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => !line.trimStart().startsWith("#"));
}

function* files(dir, test) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== "node_modules") yield* files(full, test);
    } else if (test(full)) yield full;
  }
}

/** Все находки по репозиторию: `[{where, reason, text}]`. */
export function findings(root) {
  const out = [];
  const add = (where, text) => {
    for (const found of check(text)) out.push({ where, ...found });
  };
  const rel = (file) => path.relative(root, file).replaceAll("\\", "/");

  const locales = path.join(root, "web/src/i18n/locales");
  for (const file of files(locales, (f) => f.endsWith(".json")))
    for (const [key, text] of jsonStrings(JSON.parse(readFileSync(file, "utf8"))))
      add(`${rel(file)}: ${key}`, text);

  const errors = path.join(root, "contracts/errors.json");
  for (const [key, text] of jsonStrings(JSON.parse(readFileSync(errors, "utf8"))))
    add(`${rel(errors)}: ${key}`, text);

  for (const page of ["web/index.html", "web/public/manifest.webmanifest", "web/public/robots.txt"]) {
    const file = path.join(root, page);
    if (!existsSync(file)) continue;
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => add(`${page}:${i + 1}`, line));
  }

  // Код веба: адреса, которые могли попасть в разметку мимо каталога. Только ссылки — слова в
  // комментариях кода человек не видит.
  for (const file of files(path.join(root, "web/src"), (f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f)))
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (FORBIDDEN[0][0].test(line) && !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
          out.push({ where: `${rel(file)}:${i + 1}`, reason: FORBIDDEN[0][1], text: line.trim() });
      });

  const bot = path.join(root, "services/cord_services/telegram.py");
  for (const [n, line] of pythonText(readFileSync(bot, "utf8"))) add(`${rel(bot)}:${n}`, line);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const found = findings(root);
  for (const { where, reason, text } of found) console.error(`${where} — ${reason}: ${text.trim()}`);
  console.log(
    found.length
      ? `Голос продукта: находок ${found.length} — Cord не ведёт к исходникам и не просит «поставить себе» (T54)`
      : "Голос продукта: чисто",
  );
  process.exit(found.length ? 1 : 0);
}
