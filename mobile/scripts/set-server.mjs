#!/usr/bin/env node
// Адрес сервера Cord для оболочки Android — параметр сборки, а не код: у каждой установки свой.
//
//   CORD_SERVER_URL=https://meet.example.com node scripts/set-server.mjs
//
// Пишет адрес в capacitor.config.json (`server.url`) и в кнопку «Повторить» страницы offline.html.
// В репозитории — заглушка https://cord.example.com; CI берёт адрес из переменной репозитория
// CORD_SERVER_URL (android.yml) и без неё не собирает.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const raw = (process.env.CORD_SERVER_URL ?? process.argv[2] ?? "").trim();
let url;
try {
  url = new URL(raw);
} catch {
  console.error("set-server: задайте адрес сервера — CORD_SERVER_URL=https://meet.example.com");
  process.exit(1);
}
if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username) {
  console.error(`set-server: нужен адрес https без пути, например https://meet.example.com — получено ${raw}`);
  process.exit(1);
}
const origin = url.origin;

const configPath = join(root, "capacitor.config.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
config.server.url = origin;
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

const offlinePath = join(root, "www", "offline.html");
const offline = readFileSync(offlinePath, "utf8").replace(
  /<meta name="cord-server" content="[^"]*">/,
  `<meta name="cord-server" content="${origin}/">`,
);
writeFileSync(offlinePath, offline);
console.log(`set-server: ${origin}`);
