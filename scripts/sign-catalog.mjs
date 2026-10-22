#!/usr/bin/env node
// Каталог серверов Cord (T05, П4, ADR 0001 §8, решение архитектора 9): подписывает офлайн
// `.local/catalog/servers.source.json` (образец — `infra/catalog/servers.example.json`) ключом Ed25519 владельца
// и пишет `.local/catalog/servers.jws` — файл этой установки, не репозитория (compose монтирует его в ядро),
// JWS в JSON-сериализации (RFC 7515), `alg: EdDSA` (RFC 8037). Ядро отдаёт этот файл как есть
// (`GET /api/v1/catalog`); закрытого ключа на серверах нет, поэтому взломанный сервер не впишет в
// каталог чужой адрес. Клиент принимает подпись любым ключом из `contracts/catalog-keys.json`
// ([текущий, следующий]), `seq` только растёт, срок — `expiresAt` плюс 30 дней льготы.
//
//   node scripts/sign-catalog.mjs keygen --out .local/cord-catalog-key.pem
//       новый ключ: закрытый — в файл с правами 600 (никогда не в git), открытый JWK — в stdout,
//       его кладут в contracts/catalog-keys.json (и копию — в desktop/build клиента Windows)
//   node scripts/sign-catalog.mjs sign [--key .local/cord-catalog-key.pem] [--days 180]
//       ключ — из --key или из CORD_CATALOG_SIGN_KEY (PKCS#8 PEM); seq = прежний + 1,
//       issuedAt — сейчас, expiresAt — через --days дней
//   node scripts/sign-catalog.mjs verify [--in .local/catalog/servers.jws]
//
// Выход 2 — каталог не подписан или не прошёл проверку: выкладывать нечего.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const FORMAT = "cord.servers/1";
export const GRACE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER_FIELDS = new Set(["id", "name", "country", "url", "order", "default"]);
const PAYLOAD_FIELDS = new Set(["format", "seq", "issuedAt", "expiresAt", "servers"]);

/** Дата без долей секунды: `2026-10-20T12:00:00Z`, как в ADR. */
function instant(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Полезная нагрузка из исходника: номер на единицу больше прежнего, даты — от часов. */
export function buildPayload(source, { previousSeq = 0, now = new Date(), days = 180 } = {}) {
  if (!Number.isInteger(days) || days < 1 || days > 730)
    throw new Error("--days: от 1 до 730");
  return {
    format: FORMAT,
    seq: previousSeq + 1,
    issuedAt: instant(now),
    expiresAt: instant(new Date(now.getTime() + days * DAY_MS)),
    servers: source.servers,
  };
}

/** Правила `contracts/server-catalog.v1.schema.json` — список нарушений, пустой — всё верно. */
export function checkPayload(payload) {
  const problems = [];
  if (!payload || typeof payload !== "object") return ["payload: не объект"];
  for (const key of Object.keys(payload))
    if (!PAYLOAD_FIELDS.has(key)) problems.push(`лишнее поле ${key}`);
  if (payload.format !== FORMAT) problems.push(`format: ждали ${FORMAT}`);
  if (!Number.isInteger(payload.seq) || payload.seq < 0) problems.push("seq: целое ≥ 0");
  const issued = Date.parse(payload.issuedAt);
  const expires = Date.parse(payload.expiresAt);
  if (typeof payload.issuedAt !== "string" || Number.isNaN(issued)) problems.push("issuedAt: дата");
  if (typeof payload.expiresAt !== "string" || Number.isNaN(expires) || expires <= issued)
    problems.push("expiresAt: дата позже issuedAt");
  const servers = Array.isArray(payload.servers) ? payload.servers : [];
  if (servers.length < 1 || servers.length > 50) problems.push("servers: от 1 до 50");
  const ids = new Set();
  servers.forEach((server, index) => {
    const where = `servers[${index}]`;
    if (!server || typeof server !== "object") {
      problems.push(`${where}: не объект`);
      return;
    }
    for (const key of Object.keys(server))
      if (!SERVER_FIELDS.has(key)) problems.push(`${where}: лишнее поле ${key}`);
    if (typeof server.id !== "string" || !/^[a-z0-9-]{1,32}$/.test(server.id))
      problems.push(`${where}.id: [a-z0-9-]{1,32}`);
    else if (ids.has(server.id)) problems.push(`${where}.id: повтор ${server.id}`);
    else ids.add(server.id);
    const name = server.name;
    if (
      !name ||
      typeof name !== "object" ||
      typeof name.ru !== "string" ||
      !name.ru.trim() ||
      Object.entries(name).some(
        ([language, text]) =>
          !/^[a-z]{2}(-[A-Z]{2})?$/.test(language) ||
          typeof text !== "string" ||
          !text.trim() ||
          text.length > 40,
      )
    )
      problems.push(`${where}.name: ru обязателен, по языкам, до 40 символов`);
    if (typeof server.country !== "string" || !/^[A-Z]{2}$/.test(server.country))
      problems.push(`${where}.country: ISO 3166-1 alpha-2 заглавными`);
    if (typeof server.url !== "string" || !/^https:\/\/[a-z0-9.-]+(:\d{1,5})?\/$/.test(server.url))
      problems.push(`${where}.url: https-origin со слешем в конце`);
    if (typeof server.order !== "number" || !Number.isFinite(server.order))
      problems.push(`${where}.order: число`);
    if (server.default !== undefined && typeof server.default !== "boolean")
      problems.push(`${where}.default: true или false`);
  });
  if (servers.filter((server) => server?.default === true).length !== 1)
    problems.push("default: ровно у одного сервера");
  return problems;
}

/** Открытый ключ из KeyObject (открытого или закрытого), PEM или DER. */
function asPublic(key) {
  return key?.type === "public" ? key : createPublicKey(key);
}

/** Открытый ключ как JWK (RFC 8037) с `kid` — тем, что пишется в contracts/catalog-keys.json. */
export function jwkOf(publicKey) {
  const key = asPublic(publicKey);
  const { kty, crv, x } = key.export({ format: "jwk" });
  return { kty, crv, x, kid: kidOf(key), alg: "EdDSA", use: "sig" };
}

/** `kid` — sha-256 от SPKI DER, base64url без дополнения (ADR §8). */
export function kidOf(publicKey) {
  const der = asPublic(publicKey).export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("base64url");
}

/** JWS в JSON-сериализации: подписываются точные байты `payload`, канонизация не нужна. */
export function signCatalog(payload, privateKey) {
  const key = privateKey?.type === "private" ? privateKey : createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("ключ — не Ed25519");
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const header = Buffer.from(
    JSON.stringify({ alg: "EdDSA", kid: kidOf(key) }),
    "utf8",
  ).toString("base64url");
  const signature = sign(null, Buffer.from(`${header}.${encoded}`, "ascii"), key).toString(
    "base64url",
  );
  return `${JSON.stringify({ payload: encoded, signatures: [{ protected: header, signature }] }, null, 2)}\n`;
}

function publicKeys(jwks) {
  if (!jwks || !Array.isArray(jwks.keys) || jwks.keys.length === 0)
    throw new Error("в списке ключей пусто");
  return jwks.keys.map((jwk) =>
    createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, format: "jwk" }),
  );
}

/** Та же проверка, что у клиента: подпись любым ключом списка, правила, `seq`, срок с льготой. */
export function verifyCatalog(jws, jwks, { now = new Date(), lastSeq = 0, ignoreExpiry = false } = {}) {
  const envelope = JSON.parse(jws);
  const keys = publicKeys(jwks);
  if (typeof envelope.payload !== "string" || !Array.isArray(envelope.signatures))
    throw new Error("каталог не подписан");
  const signed = envelope.signatures.some((entry) => {
    if (typeof entry?.protected !== "string" || typeof entry?.signature !== "string") return false;
    let header;
    try {
      header = JSON.parse(Buffer.from(entry.protected, "base64url").toString("utf8"));
    } catch {
      return false;
    }
    if (header.alg !== "EdDSA") return false;
    const input = Buffer.from(`${entry.protected}.${envelope.payload}`, "ascii");
    const signature = Buffer.from(entry.signature, "base64url");
    return keys.some((key) => verify(null, input, key, signature));
  });
  if (!signed) throw new Error("подпись каталога не подтверждена ни одним ключом списка");
  const payload = JSON.parse(Buffer.from(envelope.payload, "base64url").toString("utf8"));
  const problems = checkPayload(payload);
  if (problems.length) throw new Error(`каталог не по схеме: ${problems.join("; ")}`);
  if (payload.seq < lastSeq) throw new Error(`откат: seq ${payload.seq} < ${lastSeq}`);
  if (!ignoreExpiry && Date.parse(payload.expiresAt) + GRACE_DAYS * DAY_MS < now.getTime())
    throw new Error(`срок каталога истёк ${payload.expiresAt}`);
  return payload;
}

/** Новый ключ: закрытый — в файл 600, открытый JWK — наружу. Существующий файл не трогается. */
export function keygen(path) {
  if (existsSync(path)) throw new Error(`${path} уже есть — старый ключ не перезаписывается`);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(path, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  return jwkOf(publicKey);
}

function option(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function previousSeq(path) {
  if (!existsSync(path)) return 0;
  const envelope = JSON.parse(readFileSync(path, "utf8"));
  return JSON.parse(Buffer.from(envelope.payload, "base64url").toString("utf8")).seq ?? 0;
}

function main(args) {
  const [command] = args;
  const out = option(args, "--out", join(ROOT, ".local", "catalog", "servers.jws"));
  const keysPath = option(args, "--keys", join(ROOT, "contracts", "catalog-keys.json"));
  if (command === "keygen") {
    const path = option(args, "--out", null);
    if (!path) throw new Error("keygen: укажите --out (файл в .local/, не в git)");
    console.log(JSON.stringify(keygen(path), null, 2));
    console.error(`sign-catalog: закрытый ключ — ${path} (600); JWK выше — в contracts/catalog-keys.json`);
    return;
  }
  if (command === "sign") {
    const keyPath = option(args, "--key", null);
    const pem = keyPath ? readFileSync(keyPath, "utf8") : (process.env.CORD_CATALOG_SIGN_KEY ?? "");
    if (!pem.trim()) throw new Error("нет ключа (--key или CORD_CATALOG_SIGN_KEY)");
    const source = JSON.parse(
      readFileSync(option(args, "--source", join(ROOT, ".local", "catalog", "servers.source.json")), "utf8"),
    );
    const payload = buildPayload(source, {
      previousSeq: previousSeq(out),
      days: Number(option(args, "--days", "180")),
    });
    const problems = checkPayload(payload);
    if (problems.length) throw new Error(`каталог не по схеме: ${problems.join("; ")}`);
    const jwks = JSON.parse(readFileSync(keysPath, "utf8"));
    const kid = kidOf(createPrivateKey(pem));
    if (!jwks.keys?.some((jwk) => jwk.kid === kid))
      throw new Error(`ключа ${kid} нет в ${keysPath} — клиенты такой каталог не примут`);
    const jws = signCatalog(payload, pem);
    verifyCatalog(jws, jwks);
    writeFileSync(out, jws);
    console.log(`sign-catalog: ${out} — seq ${payload.seq}, до ${payload.expiresAt}, ключ ${kid}`);
    return;
  }
  if (command === "verify") {
    const path = option(args, "--in", out);
    const payload = verifyCatalog(readFileSync(path, "utf8"), JSON.parse(readFileSync(keysPath, "utf8")));
    console.log(
      `sign-catalog: ${path} подписан — seq ${payload.seq}, до ${payload.expiresAt}, серверов ${payload.servers.length}`,
    );
    return;
  }
  throw new Error("команда: keygen | sign | verify");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`sign-catalog: ${error.message}`);
    process.exit(2);
  }
}
