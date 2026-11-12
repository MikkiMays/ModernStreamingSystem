#!/usr/bin/env node
/**
 * Чат для оповещений мониторинга.
 *
 *   node scripts/alerts-chat.mjs          — найти чат: кто писал боту оповещений; если он один — записать
 *                                           ALERT_TELEGRAM_CHAT_ID в .local/alerts.env
 *   node scripts/alerts-chat.mjs --test   — отправить в записанный чат проверочное сообщение
 *
 * Бот — отдельный бот владельца: `ALERT_TELEGRAM_BOT_TOKEN` в `.local/alerts.env` (файл вне git, права 600).
 * Telegram не даёт боту писать первым: владелец сначала нажимает «Запустить» у бота или добавляет его в группу.
 * Токен не печатается никогда. После записи чата: `node scripts/configure.mjs --refresh &&
 * docker compose up -d --force-recreate alertmanager`.
 */
import { readFile, writeFile } from "node:fs/promises";

const FILE = ".local/alerts.env";
const setting = (text, name) => new RegExp(`^${name}=(.+)$`, "m").exec(text)?.[1]?.trim();

/** Чаты из ответа `getUpdates`: кто писал боту или куда его добавили. Без повторов, свежие — последними. */
export function chatsOf(updates) {
  const chats = new Map();
  for (const update of updates ?? []) {
    const chat = (update.message ?? update.channel_post ?? update.my_chat_member)?.chat;
    if (chat?.id) chats.set(chat.id, { id: chat.id, type: chat.type ?? "unknown" });
  }
  return [...chats.values()];
}

/** Строки файла настроек с новым чатом: прежняя строка чата заменяется, остальное остаётся как было. */
export function withChat(text, chatId) {
  const kept = text.split("\n").filter((line) => line && !line.startsWith("ALERT_TELEGRAM_CHAT_ID="));
  return [...kept, `ALERT_TELEGRAM_CHAT_ID=${chatId}`].join("\n") + "\n";
}

async function call(token, method, body) {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    return await response.json();
  } catch (error) {
    // Текст ошибки сети может нести адрес запроса, а в нём — токен: наружу только имя ошибки.
    return { ok: false, description: error?.name ?? "сеть" };
  }
}

async function main() {
  const text = await readFile(FILE, "utf8").catch(() => "");
  const token = setting(text, "ALERT_TELEGRAM_BOT_TOKEN");
  if (!token) {
    console.error(`Нет ALERT_TELEGRAM_BOT_TOKEN в ${FILE}`);
    process.exit(2);
  }
  if (process.argv.includes("--test")) {
    const chat = setting(text, "ALERT_TELEGRAM_CHAT_ID");
    if (!chat) {
      console.error("Чат ещё не записан: сначала запустить без --test");
      process.exit(2);
    }
    const sent = await call(token, "sendMessage", {
      chat_id: Number(chat),
      text: "Cord: проверка канала оповещений. Сюда будут приходить оповещения мониторинга.",
    });
    console.log(sent.ok ? "Проверочное сообщение отправлено" : `Не отправлено: ${sent.description}`);
    process.exit(sent.ok ? 0 : 1);
  }
  const updates = await call(token, "getUpdates");
  if (!updates.ok) {
    console.error(`Telegram не ответил: ${updates.description}`);
    process.exit(1);
  }
  const chats = chatsOf(updates.result);
  if (!chats.length) {
    console.log("Боту ещё никто не писал: откройте бота в Telegram и нажмите «Запустить», затем повторите.");
    process.exit(3);
  }
  // Личный чат владельца главнее групп; несколько личных — выбирать человеку.
  const personal = chats.filter((chat) => chat.type === "private");
  const pick = personal.length === 1 ? personal[0] : chats.length === 1 ? chats[0] : null;
  if (!pick) {
    console.log("Чатов несколько — впишите нужный в ALERT_TELEGRAM_CHAT_ID сами:");
    for (const chat of chats) console.log(`  ${chat.id}  (${chat.type})`);
    process.exit(4);
  }
  await writeFile(FILE, withChat(text, pick.id), { mode: 0o600 });
  console.log(`Чат записан: ${pick.id} (${pick.type})`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
