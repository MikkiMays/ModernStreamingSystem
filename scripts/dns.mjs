import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";

/**
 * DNS Cord как код (R235): зоны Cloudflare описаны в `infra/dns/zones.json`, этот скрипт сверяет их с
 * настоящими и приводит в соответствие.
 *
 *   CLOUDFLARE_API_TOKEN=… node scripts/dns.mjs plan                  # что изменится, ничего не меняя
 *   CLOUDFLARE_API_TOKEN=… node scripts/dns.mjs apply                 # создать и поправить записи
 *   CLOUDFLARE_API_TOKEN=… node scripts/dns.mjs apply --prune         # ещё и удалить то, чего нет в файле
 *   node scripts/dns.mjs print [--zone=cord.online]                   # развёрнутый список записей, без сети
 *
 * ЗАЧЕМ. Раньше записи ставил владелец руками в панели: три имени на каждый узел, для каждой зоны. Теперь
 * узел — одна строка `nodes` в файле; имена `<id>`, `rtc-<id>`, `turn-<id>` скрипт выводит сам, и то же
 * правило читают `scripts/node-config.mjs` и пульт. Почта у зон Cord не ходит — `mail: "none"` ставит
 * нулевой MX (RFC 7505), SPF `-all` и DMARC `reject`, чтобы именем нельзя было подписать чужое письмо.
 *
 * ТОКЕН. Только из окружения, права — «Zone → DNS → Edit» на зоны Cord, ничего больше. В файлы и в вывод
 * не попадает. Все записи создаются с серым облаком (Р-109).
 *
 * ЧЕГО НЕ ДЕЛАЕТ. Без `--prune` ничего не удаляет: лишнее только называет. Записи с тем же именем и
 * типом, но другим значением — это «создать новую» и «лишняя старая», а не тихая замена: у апекса может
 * быть несколько адресов.
 */

const ZONES_FILE = new URL("../infra/dns/zones.json", import.meta.url);
const API = "https://api.cloudflare.com/client/v4";
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const NODE_ID = /^[a-z][a-z0-9-]{1,15}$/;

const address = (ip, where) => {
  if (isIP(ip) !== 4) throw new Error(`${where}: нужен адрес IPv4, получено «${ip}»`);
  return ip;
};

/** Три имени медиаузла — одно правило на всю систему (R195, `distributed-media.md`). */
export function nodeNames(id, zone) {
  if (!NODE_ID.test(id)) throw new Error(`узел «${id}»: имя — латиница, цифры и дефис, от 2 до 16 знаков`);
  return [`${id}.${zone}`, `rtc-${id}.${zone}`, `turn-${id}.${zone}`];
}

/** Развернуть описание зоны в плоский список записей в том виде, в каком их отдаёт API Cloudflare. */
export function expand(name, zone) {
  const records = [];
  const a = (host, ip, ttl = 1) =>
    records.push({ type: "A", name: host, content: address(ip, host), ttl, proxied: false });
  for (const ip of zone.apex ?? []) a(name, ip, zone.apexTtl ?? 1);
  if (zone.www) for (const ip of zone.apex ?? []) a(`www.${name}`, ip, zone.apexTtl ?? 1);
  for (const [id, ip] of Object.entries(zone.nodes ?? {})) for (const host of nodeNames(id, name)) a(host, ip);
  for (const [label, ip] of Object.entries(zone.hosts ?? {})) {
    if (!LABEL.test(label)) throw new Error(`${name}: имя «${label}» — не метка DNS`);
    a(`${label}.${name}`, ip);
  }
  if (zone.mail === "none") {
    records.push({ type: "MX", name, content: ".", priority: 0, ttl: 1, proxied: false });
    records.push({ type: "TXT", name, content: "v=spf1 -all", ttl: 1, proxied: false });
    records.push({
      type: "TXT",
      name: `_dmarc.${name}`,
      content: "v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s",
      ttl: 1,
      proxied: false,
    });
  } else if (zone.mail !== undefined) throw new Error(`${name}: mail — только "none"`);
  for (const issuer of zone.caa ?? [])
    records.push({ type: "CAA", name, content: `0 issue "${issuer}"`, ttl: 1, proxied: false });
  // Сертификаты на `*.зона` не выпускаются никем: у каждого узла свои три имени (Р-107).
  if (zone.caa?.length) records.push({ type: "CAA", name, content: '0 issuewild ";"', ttl: 1, proxied: false });
  for (const extra of zone.records ?? []) records.push({ ttl: 1, proxied: false, ...extra });
  const seen = new Set();
  for (const record of records) {
    const id = key(record);
    if (seen.has(id)) throw new Error(`${name}: запись повторяется — ${id}`);
    seen.add(id);
  }
  return records;
}

/** TXT Cloudflare отдаёт в кавычках, а принимает и без них; сравниваем по смыслу. */
const plain = (record) =>
  record.type === "TXT" ? record.content.replace(/^"(.*)"$/s, "$1").replaceAll('" "', "") : record.content;

export const key = (record) => `${record.type} ${record.name.toLowerCase()} ${plain(record)}`;

/** Что создать, что поправить (то же значение, другие ttl/proxied/priority) и что в зоне лишнее. */
export function diff(desired, actual) {
  const have = new Map(actual.map((record) => [key(record), record]));
  const want = new Map(desired.map((record) => [key(record), record]));
  const create = [];
  const update = [];
  for (const [id, record] of want) {
    const current = have.get(id);
    if (!current) create.push(record);
    else if (
      current.ttl !== record.ttl ||
      Boolean(current.proxied) !== Boolean(record.proxied) ||
      (record.priority !== undefined && current.priority !== record.priority)
    )
      update.push({ id: current.id, ...record });
  }
  const extra = actual.filter((record) => !want.has(key(record)));
  return { create, update, extra };
}

/** Тело запроса API: у CAA значение уходит полями, у TXT — в кавычках. */
export function payload(record) {
  const body = { type: record.type, name: record.name, ttl: record.ttl, comment: "infra/dns/zones.json" };
  if (record.type === "CAA") {
    const [, flags, tag, value] = /^(\d+) (\w+) "(.*)"$/.exec(record.content);
    return { ...body, data: { flags: Number(flags), tag, value } };
  }
  if (record.type === "MX") return { ...body, content: record.content, priority: record.priority };
  if (record.type === "TXT") return { ...body, content: `"${plain(record)}"` };
  return { ...body, content: record.content, proxied: Boolean(record.proxied) };
}

export async function load(file = ZONES_FILE) {
  const { zones } = JSON.parse(await readFile(file, "utf8"));
  return Object.fromEntries(Object.entries(zones).map(([name, zone]) => [name, expand(name, zone)]));
}

async function call(token, method, path, body) {
  const response = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const answer = await response.json().catch(() => ({}));
  if (!response.ok || answer.success === false)
    throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(answer.errors ?? [])}`);
  return answer;
}

async function main() {
  const [command = "plan", ...rest] = process.argv.slice(2);
  const flags = Object.fromEntries(
    rest.map((arg) => {
      const [name, value = "true"] = arg.replace(/^--/, "").split("=");
      return [name, value];
    }),
  );
  if (!["plan", "apply", "print"].includes(command)) throw new Error("Команда: plan, apply или print");
  const desired = await load();
  const names = flags.zone ? [flags.zone] : Object.keys(desired);
  for (const name of names) if (!desired[name]) throw new Error(`Зоны «${name}» нет в infra/dns/zones.json`);
  if (command === "print") {
    console.log(JSON.stringify(Object.fromEntries(names.map((name) => [name, desired[name]])), null, 2));
    return;
  }
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error("Нужен CLOUDFLARE_API_TOKEN (Zone → DNS → Edit на зоны Cord)");
  let pending = 0;
  for (const name of names) {
    const zone = (await call(token, "GET", `/zones?name=${name}`)).result[0];
    if (!zone) throw new Error(`Зона ${name} не найдена в аккаунте Cloudflare`);
    const actual = (await call(token, "GET", `/zones/${zone.id}/dns_records?per_page=500`)).result;
    const { create, update, extra } = diff(desired[name], actual);
    console.log(`${name}: создать ${create.length}, поправить ${update.length}, лишних ${extra.length}`);
    for (const record of create) console.log(`  + ${key(record)}`);
    for (const record of update) console.log(`  ~ ${key(record)}`);
    for (const record of extra) console.log(`  ${flags.prune ? "-" : "?"} ${key(record)}`);
    pending += create.length + update.length + (flags.prune ? extra.length : 0);
    if (command !== "apply") continue;
    for (const record of create) await call(token, "POST", `/zones/${zone.id}/dns_records`, payload(record));
    for (const record of update)
      await call(token, "PATCH", `/zones/${zone.id}/dns_records/${record.id}`, payload(record));
    if (flags.prune)
      for (const record of extra) await call(token, "DELETE", `/zones/${zone.id}/dns_records/${record.id}`);
  }
  // `plan` с расхождениями — код 2: так его читает CI и пульт («зона разошлась с файлом»).
  if (command === "plan" && pending) process.exitCode = 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
