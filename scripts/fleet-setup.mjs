import { randomBytes, scryptSync } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * Настройка пульта флота на A (R207, Р-113, Р-120): `.local/fleet.env` с паролем (scrypt), секретом
 * одноразового кода (TOTP) и ключом агент-сессии. Запускать из корня установки на A; `.env` продукта не
 * трогается, пульт секретов продукта не получает.
 *
 *   node scripts/fleet-setup.mjs --password            # спросит пароль дважды, выпустит TOTP и ключ агента
 *   node scripts/fleet-setup.mjs --password --rotate-totp   # новый секрет кода (старый код перестанет подходить)
 *   node scripts/fleet-setup.mjs --allow=203.0.113.0/24,198.51.100.7/32   # список адресов для входа
 *   node scripts/fleet-setup.mjs --admin=admin.callcord.ru                # имя пульта (проверка Origin)
 *   node scripts/fleet-setup.mjs --machines=/data/machines.json           # откуда список машин
 *   node scripts/fleet-setup.mjs --executor=ssh --ssh-machines=meet,msk   # ВКЛЮЧИТЬ управление вживую
 *   node scripts/fleet-setup.mjs --executor=dry-run                           # вернуть сухой прогон
 *   node scripts/fleet-setup.mjs --core=a=password:<пароль стенда>            # учётные данные ядра машины
 *
 * Пароль читается с терминала (без эха) или из переменной FLEET_SETUP_PASSWORD (для скриптов) — в аргументы
 * командной строки он не попадает. Смена пароля или секрета кода гасит все сессии: служба хранит в кук
 * только случайный токен, а проверка идёт по этим двум значениям — перезапустите `docker compose up -d fleet`.
 */
const FILE = ".local/fleet.env";
export const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

/** Формат, который читает `fleet/auth.py`: `scrypt$N,r,p$соль$хэш` (base64 с дополнением). */
export function hashPassword(password, salt = randomBytes(16)) {
  const hash = scryptSync(password, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N},${SCRYPT.r},${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32(bytes) {
  let bits = "";
  for (const byte of bytes) bits += byte.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  if (bits.length % 5) out += B32[parseInt(bits.slice(bits.length - (bits.length % 5)).padEnd(5, "0"), 2)];
  return out;
}

export function newTotpSecret() {
  return base32(randomBytes(20));
}

export function otpauth(secret, host) {
  const label = encodeURIComponent(`Cord пульт (${host || "A"})`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=Cord&algorithm=SHA1&digits=6&period=30`;
}

export function parseEnv(text) {
  return Object.fromEntries(
    text
      .split("\n")
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

export function renderEnv(values) {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n") + "\n";
}

const CIDR = /^(\d{1,3}(\.\d{1,3}){3}\/\d{1,2}|[0-9a-f:]+\/\d{1,3})$/i;

/**
 * Применить аргументы к текущим значениям файла. Чистая функция — проверяется тестом; пароль и секрет
 * сюда приходят уже готовыми.
 */
export function apply(current, args, { password, totpSecret, agentKey } = {}) {
  const next = { ...current };
  if (password !== undefined) next.FLEET_PASSWORD_HASH = hashPassword(password);
  if (totpSecret) next.FLEET_TOTP_SECRET = totpSecret;
  if (agentKey) next.FLEET_AGENT_KEY = agentKey;
  if (args.allow !== undefined) {
    const list = args.allow.split(",").map((s) => s.trim()).filter(Boolean);
    for (const cidr of list) if (!CIDR.test(cidr)) throw new Error(`--allow: ${cidr} — не CIDR (пример 203.0.113.0/24)`);
    next.FLEET_ALLOW_IPS = list.join(",");
  }
  if (args.admin !== undefined) {
    if (args.admin && !/^[a-z0-9.-]+$/.test(args.admin)) throw new Error("--admin: имя DNS строчными");
    next.FLEET_ADMIN_HOST = args.admin;
  }
  if (args.machines !== undefined) next.FLEET_MACHINES = args.machines;
  if (args.executor !== undefined) {
    if (!["dry-run", "ssh"].includes(args.executor)) throw new Error("--executor: dry-run или ssh");
    next.FLEET_EXECUTOR = args.executor;
  }
  if (args["ssh-machines"] !== undefined) {
    const list = args["ssh-machines"].split(",").map((s) => s.trim()).filter(Boolean);
    for (const id of list) if (!/^[a-z][a-z0-9-]{0,15}$/.test(id)) throw new Error(`--ssh-machines: ${id} — не имя машины`);
    next.FLEET_SSH_MACHINES = list.join(",");
  }
  if (args.metrics !== undefined) next.FLEET_METRICS_URL = args.metrics;
  if (args.alerts !== undefined) next.FLEET_ALERTS_URL = args.alerts;
  for (const pair of [].concat(args.core ?? [])) {
    const at = pair.indexOf("=");
    const id = pair.slice(0, at);
    const credential = pair.slice(at + 1);
    if (!/^[a-z][a-z0-9-]{0,15}$/.test(id)) throw new Error(`--core: ${id} — не имя машины`);
    if (!/^(password|key):.+/.test(credential)) throw new Error("--core: значение вида password:<…> или key:<…>");
    next[`FLEET_CORE_${id.toUpperCase().replaceAll("-", "_")}`] = credential;
  }
  if (next.FLEET_EXECUTOR === "ssh" && !next.FLEET_SSH_MACHINES)
    throw new Error("--executor=ssh требует --ssh-machines=… — без списка машин пульт остаётся в сухом прогоне");
  return next;
}

async function readPassword() {
  if (process.env.FLEET_SETUP_PASSWORD) return process.env.FLEET_SETUP_PASSWORD;
  const { createInterface } = await import("node:readline/promises");
  const ask = async (prompt) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const muted = rl._writeToOutput;
    rl._writeToOutput = (s) => (s.includes(prompt) ? muted.call(rl, prompt) : undefined);
    try {
      const answer = await rl.question(prompt);
      process.stdout.write("\n");
      return answer;
    } finally {
      rl.close();
    }
  };
  const first = await ask("Пароль пульта: ");
  if (first.length < 12) throw new Error("Пароль короче 12 знаков");
  const second = await ask("Ещё раз: ");
  if (first !== second) throw new Error("Пароли не совпали");
  return first;
}

async function main() {
  const args = {};
  for (const arg of process.argv.slice(2)) {
    const bare = arg.replace(/^--/, "");
    const at = bare.indexOf("=");
    const [key, value] = at < 0 ? [bare, "true"] : [bare.slice(0, at), bare.slice(at + 1)];
    if (key === "core") (args.core ??= []).push(value);
    else args[key] = value;
  }
  const current = parseEnv(await readFile(FILE, "utf8").catch(() => ""));
  const fresh = !current.FLEET_PASSWORD_HASH;
  const password = args.password || fresh ? await readPassword() : undefined;
  const totpSecret = fresh || args["rotate-totp"] ? newTotpSecret() : undefined;
  const agentKey = fresh || args["rotate-agent"] ? randomBytes(32).toString("base64url") : undefined;
  const next = apply(current, args, { password, totpSecret, agentKey });
  if (!next.FLEET_MACHINES) next.FLEET_MACHINES = "/data/machines.json";
  await mkdir(".local", { recursive: true });
  await writeFile(FILE, renderEnv(next), { mode: 0o600 });
  await chmod(FILE, 0o600);
  console.log(`Записано ${FILE} (0600).`);
  if (totpSecret) {
    console.log(`\nСекрет одноразового кода (введите в приложение-аутентификатор вручную или по ссылке):\n  ${totpSecret}\n  ${otpauth(totpSecret, next.FLEET_ADMIN_HOST)}\n`);
  }
  if (agentKey) console.log(`Ключ агент-сессии (X-Fleet-Agent с 127.0.0.1): ${agentKey}\n`);
  console.log(`Исполнитель: ${next.FLEET_EXECUTOR ?? "dry-run"}${next.FLEET_SSH_MACHINES ? ` (${next.FLEET_SSH_MACHINES})` : ""}; адреса: ${next.FLEET_ALLOW_IPS || "любые"}; имя: ${next.FLEET_ADMIN_HOST || "—"}.`);
  console.log("Применить: docker compose --profile admin up -d fleet");
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
