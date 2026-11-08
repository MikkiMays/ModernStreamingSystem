#!/usr/bin/env node
// Адрес сервера Cord для оболочки Android.
//
//   node scripts/set-server.mjs                                   # проверить: адрес продукта из репозитория
//   CORD_ANDROID_SERVER=https://meet.example.com node scripts/set-server.mjs   # другая установка
//
// Продукт один — `https://cordcam.ru` (R200, Р-110): он и записан в capacitor.config.json (`server.url`) и в
// кнопке «Повторить» страницы offline.html, CI собирает APK с ним без переменных. Другая установка задаёт
// свой адрес переменной CORD_ANDROID_SERVER (или аргументом) — скрипт пишет его в оба файла. Без адреса
// скрипт ничего не пишет: сверяет, что оба файла называют один https-origin, и печатает его.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const configPath = join(root, "capacitor.config.json");
const offlinePath = join(root, "www", "offline.html");
const META = /<meta name="cord-server" content="([^"]*)">/;

function origin(raw, what) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    console.error(`set-server: ${what} — не адрес: ${raw}; нужен https-origin, например https://meet.example.com`);
    process.exit(1);
  }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username) {
    console.error(`set-server: ${what} — нужен адрес https без пути, например https://meet.example.com — получено ${raw}`);
    process.exit(1);
  }
  return url.origin;
}

const raw = (process.env.CORD_ANDROID_SERVER?.trim() || process.argv[2] || "").trim();
const config = JSON.parse(readFileSync(configPath, "utf8"));
const offline = readFileSync(offlinePath, "utf8");

if (!raw) {
  const inConfig = origin(config.server?.url ?? "", "capacitor.config.json server.url");
  const inOffline = origin(META.exec(offline)?.[1] ?? "", "www/offline.html cord-server");
  if (inConfig !== inOffline) {
    console.error(`set-server: адреса расходятся — capacitor.config.json ${inConfig}, offline.html ${inOffline}`);
    process.exit(1);
  }
  console.log(`set-server: ${inConfig} (из репозитория)`);
  process.exit(0);
}

const target = origin(raw, "CORD_ANDROID_SERVER");
config.server.url = target;
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
writeFileSync(offlinePath, offline.replace(META, `<meta name="cord-server" content="${target}/">`));
console.log(`set-server: ${target}`);
