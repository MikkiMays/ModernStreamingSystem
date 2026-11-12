import { execFileSync } from "node:child_process";
import { mkdir, writeFile, readFile, access, chmod } from "node:fs/promises";
import { isIP } from "node:net";
import { cpus } from "node:os";
import { resolve } from "node:path";
import { createEdge, resolveTopology } from "./edge-config.mjs";
import { createLivekit } from "./livekit-config.mjs";
import {
  BACKBONE_PORT,
  NODE_LOCAL,
  NODE_SERVICES,
  assertNodeId,
  controlBackbone,
  controlPorts,
  nodeBackbone,
} from "./backbone-config.mjs";

/**
 * Медиаузел как код (R195). Запускается на узле управления (A) из корня репозитория, где лежит `.env`.
 *
 *   node scripts/node-config.mjs --node=hel --ip=152.234.227.199 \
 *     --app=hel.cord.online --rtc=rtc-hel.cord.online --turn=turn-hel.cord.online \
 *     --title-ru=Хельсинки --title-en=Helsinki --country=FI --uplink-mbps=1000 --cores=2 \
 *     --ssh=root@152.234.227.199 --ssh-key=/root/.ssh/cord_fi
 *   node scripts/node-config.mjs --node=hel --mode=ip --ip=…        # до DNS: самоподписанный сертификат
 *   node scripts/node-config.mjs --node=hel --refresh                 # перевыпуск файлов по nodes.json
 *   node scripts/node-config.mjs --node=hel --enabled=false           # дренаж: новых встреч на узел нет
 *   node scripts/node-config.mjs --control-id=fra --write-env         # только файлы A (CSP, NODE_ID, профиль)
 *
 * ЧТО ПИШЕТ. `infra/generated/nodes.json` — реестр узлов (его читает ядро, перечитывая раз в 10 с);
 * `infra/generated/nodes/<id>/` — всё, что уезжает на узел (`node.env` с общими секретами, `edge.json`,
 * `livekit.json`, `backbone.json`, `pki/`); `infra/generated/backbone.json` и `backbone-pki/` — магистраль
 * самого A; `infra/generated/scrape-nodes/<id>.json` — цели VictoriaMetrics. Внутренний ЦС магистрали —
 * `.local/backbone/` (вне git, 0600). Секреты — только из `.env` A и из `openssl`; в вывод не попадают.
 *
 * Узел управления (A) тоже узел: первая запись `nodes.json` с `control: true` строится из `.env` и
 * получает `--control-id` (по умолчанию `fra`). Его сертификат — такой же, как у медиаузлов.
 *
 * Ёмкость и показ (R200, `server-selection.md` §3.4; Р-135): `country` — ISO 3166-1 alpha-2 для флага у
 * человека; `uplinkMbps` — отдача канала узла (доля к мягкому порогу 70 %); `cores` — ядра хоста (оценка ЦП
 * по людям, пока node-exporter молчит, и резерв новой встречи); `loadUrl` — node-exporter узла по
 * магистрали (`127.0.0.1:2N002`), откуда ядро читает ЦП, трафик, память и диск; `sfuMetricsUrl` — метрики
 * SFU (`127.0.0.1:2N001`, у узла управления — `127.0.0.1:6789`; только если в `.env` есть
 * `LIVEKIT_METRICS_PASSWORD`), откуда — память процесса SFU; `sfuMemoryMb` — предел памяти контейнера SFU
 * (`mem_limit`, по умолчанию 1024; `--sfu-memory-mb`). У узла управления `loadUrl` — его собственный
 * node-exporter (профиль `monitoring`), страна и ядра — из `.env` (`NODE_COUNTRY`) и `os.cpus()`.
 *
 * Предела числа встреч на узле нет (R228, Р-135): узел упирается в ресурсы, а не в счётчик. Поле
 * `maxRooms` старых реестров при любом запуске удаляется, флаги `--max-rooms` и `--control-max-rooms` —
 * ошибка, а не тихий пропуск: кто их передал, ждёт предела, которого больше нет.
 */
const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const bare = arg.replace(/^--/, "");
    const at = bare.indexOf("=");
    return at < 0 ? [bare, "true"] : [bare.slice(0, at), bare.slice(at + 1)];
  }),
);

const NODES_FILE = "infra/generated/nodes/registry.json";
const CA_DIR = ".local/backbone";
const FORMAT = "cord.nodes/1";

const env = Object.fromEntries(
  (await readFile(".env", "utf8").catch(() => {
    throw new Error(".env not found: run this on the control node from the repository root");
  }))
    .split("\n")
    .filter((line) => /^[A-Z_]+=/.test(line))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
);
for (const key of ["LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "INTERNAL_SECRET", "PUBLIC_URL", "PUBLIC_IP", "LIVEKIT_URL"])
  if (!env[key]) throw new Error(`.env lacks ${key}`);

const registry = await readFile(NODES_FILE, "utf8").then(JSON.parse, (e) => {
  if (e.code !== "ENOENT") throw e;
  return { format: FORMAT, nodes: [] };
});
if (registry.format !== FORMAT) throw new Error(`${NODES_FILE}: unknown format ${registry.format}`);
for (const flag of ["max-rooms", "control-max-rooms"])
  if (args[flag] !== undefined)
    throw new Error(`--${flag} is gone (R228, Р-135): nodes take meetings by load (CPU, uplink, memory, disk), not by a meeting count`);
for (const n of registry.nodes) delete n.maxRooms;
// Метрики SFU (память процесса) — только если SFU их отдаёт: livekit-config включает их по паролю.
const sfuMetrics = (port) => (env.LIVEKIT_METRICS_PASSWORD ? `http://127.0.0.1:${port}/metrics` : undefined);

// ── Узел управления ───────────────────────────────────────────────────────────────────────────────
let control = registry.nodes.find((n) => n.control);
if (!control) {
  control = { id: assertNodeId(args["control-id"] ?? "fra"), control: true };
  registry.nodes.unshift(control);
} else if (args["control-id"] && args["control-id"] !== control.id)
  throw new Error(`Control node is already ${control.id}; renaming is not supported`);
Object.assign(control, {
  title: control.title ?? { ru: "Франкфурт", en: "Frankfurt" },
  ip: env.PUBLIC_IP,
  rtcUrl: env.LIVEKIT_URL,
  probeUrl: env.PUBLIC_URL,
  stun: `stun:${env.TURN_HOST || env.PUBLIC_IP}:3478`,
  internalUrl: env.LIVEKIT_INTERNAL_URL || "http://127.0.0.1:7880",
  enabled: control.enabled ?? true,
  country: control.country ?? env.NODE_COUNTRY ?? "DE",
  uplinkMbps: Number(control.uplinkMbps ?? env.STREAM_UPLINK_MBPS ?? 1000),
  cores: control.cores ?? cpus().length,
  loadUrl: control.loadUrl ?? "http://127.0.0.1:9100/metrics",
  sfuMetricsUrl: sfuMetrics(NODE_SERVICES.metrics),
  sfuMemoryMb: Number(control.sfuMemoryMb ?? 1024),
});
if (!control.sfuMetricsUrl) delete control.sfuMetricsUrl;
if (args["title-ru"] && !args.node) control.title.ru = args["title-ru"];
if (args["title-en"] && !args.node) control.title.en = args["title-en"];
if (args.country && !args.node) control.country = assertCountry(args.country);
if (args["uplink-mbps"] && !args.node) control.uplinkMbps = assertPositive("--uplink-mbps", args["uplink-mbps"]);
if (args.cores && !args.node) control.cores = assertPositive("--cores", args.cores);
if (args["sfu-memory-mb"] && !args.node) control.sfuMemoryMb = assertPositive("--sfu-memory-mb", args["sfu-memory-mb"]);

// ── Медиаузел ─────────────────────────────────────────────────────────────────────────────────────
let node = null;
if (args.node) {
  const id = assertNodeId(args.node);
  if (id === control.id) throw new Error(`${id} is the control node`);
  node = registry.nodes.find((n) => n.id === id);
  const fresh = !node;
  if (fresh) {
    if (args.refresh) throw new Error(`Node ${id} is not in ${NODES_FILE}; drop --refresh`);
    const used = new Set(registry.nodes.map((n) => n.index).filter(Boolean));
    let index = 1;
    while (used.has(index)) index++;
    node = { id, index, enabled: true, title: { ru: id, en: id }, uplinkMbps: 1000 };
    registry.nodes.push(node);
  }
  // Аргументы правят запись реестра; `--refresh` без аргументов повторяет её как есть.
  if (args.ip) {
    if (!isIP(args.ip)) throw new Error("--ip must be an IP address");
    node.ip = args.ip;
  }
  if (!node.ip) throw new Error("Specify --ip=<public IP of the node>");
  if (args.mode || args.app || args.rtc || args.turn) {
    node.mode = args.mode ?? (args.app ? "strict" : node.mode ?? "strict");
    if (node.mode === "strict") {
      for (const field of ["app", "rtc", "turn"]) if (args[field]) node[field] = args[field];
      for (const field of ["app", "rtc", "turn"])
        if (!node[field]) throw new Error(`strict mode needs --${field}=<dns name>`);
    } else if (node.mode === "ip") {
      delete node.app;
      delete node.rtc;
      delete node.turn;
    } else throw new Error("--mode must be strict or ip (a media node has no simple mode: TURN/TLS needs its own name)");
  }
  if (!node.mode) throw new Error("Specify --app/--rtc/--turn (strict) or --mode=ip");
  if (args["title-ru"]) node.title.ru = args["title-ru"];
  if (args["title-en"]) node.title.en = args["title-en"];
  if (args.country) node.country = assertCountry(args.country);
  if (args["uplink-mbps"]) node.uplinkMbps = assertPositive("--uplink-mbps", args["uplink-mbps"]);
  if (args.cores) node.cores = assertPositive("--cores", args.cores);
  if (!node.uplinkMbps) node.uplinkMbps = 1000;
  if (args["sfu-memory-mb"]) node.sfuMemoryMb = assertPositive("--sfu-memory-mb", args["sfu-memory-mb"]);
  if (!node.sfuMemoryMb) node.sfuMemoryMb = 1024;
  if (args.enabled !== undefined) node.enabled = args.enabled !== "false";
  if (args.ssh) node.ssh = args.ssh;
  if (args["ssh-key"]) node.sshKey = args["ssh-key"];
  // Чужие сайты на машине узла (например, сайт владельца на машине узла): edge узла пропускает их TLS по SNI на локальный
  // порт, не вскрывая (`edge-config.mjs`, `--legacy-hosts`). Пустое значение — убрать.
  if (args["legacy-hosts"] !== undefined) {
    if (args["legacy-hosts"]) node.legacyHosts = args["legacy-hosts"].split(",");
    else delete node.legacyHosts;
  }
  if (args["legacy-tls-port"]) node.legacyTlsPort = Number(args["legacy-tls-port"]);
  if (!node.legacyHosts) delete node.legacyTlsPort;
  const nodeEdge = {
    ...(node.mode === "ip" ? { mode: "ip", ip: node.ip } : { app: node.app, rtc: node.rtc, turn: node.turn, ip: node.ip }),
    ...(node.legacyHosts ? { "legacy-hosts": node.legacyHosts.join(",") } : {}),
    ...(node.legacyTlsPort ? { "legacy-tls-port": String(node.legacyTlsPort) } : {}),
  };
  const topology = resolveTopology(nodeEdge);
  // Что ядро и клиенты знают об узле. Клиент подключает SDK к `rtcUrl` (SDK сам добавляет /rtc),
  // меряет TCP по `probeUrl/api/v1/ping` и UDP — STUN-запросом к TURN узла.
  node.rtcUrl = `wss://${topology.rtc}`;
  node.probeUrl = topology.origin;
  node.stun = `stun:${topology.turn}:3478`;
  node.internalUrl = `http://127.0.0.1:${controlPorts(node.index).livekit}`;
  // ЦП и трафик узла ядро читает у node-exporter узла через магистраль — отдельного образа не нужно.
  node.loadUrl = `http://127.0.0.1:${controlPorts(node.index).node}/metrics`;
  // Память SFU узла — из его же метрик, тем же путём, что их собирает VictoriaMetrics.
  node.sfuMetricsUrl = sfuMetrics(controlPorts(node.index).metrics);
  if (!node.sfuMetricsUrl) delete node.sfuMetricsUrl;

  const dir = `infra/generated/nodes/${id}`;
  await mkdir(`${dir}/pki`, { recursive: true });
  await mkdir(`${dir}/tls`, { recursive: true });
  if (node.mode === "ip" && !(await exists(`${dir}/tls/turn.crt`)))
    openssl([
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", `${dir}/tls/turn.key`, "-out", `${dir}/tls/turn.crt`,
      "-days", "3650", "-subj", `/CN=${node.ip}`, "-addext", `subjectAltName=IP:${node.ip}`,
    ]);
  const livekit = createLivekit({
    ip: node.ip,
    turn: topology.turn,
    turnTlsPort: topology.turnTlsPort,
    externalTls: topology.externalTls,
    key: env.LIVEKIT_API_KEY,
    secret: env.LIVEKIT_API_SECRET,
    metricsPassword: env.LIVEKIT_METRICS_PASSWORD,
    maxParticipants: Number(env.STREAM_MAX_PARTICIPANTS) || 30,
    // Вебхуки — ядру A через магистраль: локальный порт клиентской стороны `backbone` этого узла.
    webhookUrl: `http://127.0.0.1:${NODE_LOCAL.hooks}/internal/livekit`,
  });
  await writeFile(`${dir}/livekit.json`, JSON.stringify(livekit, null, 2), { mode: 0o600 });
  await writeFile(`${dir}/edge.json`, JSON.stringify(createEdge(nodeEdge), null, 2));
  await writeFile(`${dir}/backbone.json`, JSON.stringify(nodeBackbone(node, control), null, 2));
  const nodeEnv = {
    NODE_ID: id,
    CONTROL_ID: control.id,
    CONTROL_IP: control.ip,
    DEPLOY_MODE: topology.mode,
    APP_HOST: topology.app,
    RTC_HOST: topology.rtc,
    TURN_HOST: topology.turn,
    PUBLIC_IP: node.ip,
    // Адрес продукта: сюда gateway-lite отправляет всё, что не сигналинг, и его же пускает в CORS.
    PUBLIC_URL: env.PUBLIC_URL,
    CORE_AUTH_UPSTREAM: `127.0.0.1:${NODE_LOCAL.core}`,
    LIVEKIT_URL: node.rtcUrl,
    LIVEKIT_INTERNAL_URL: "http://127.0.0.1:7880",
    INTERNAL_SECRET: env.INTERNAL_SECRET,
    LIVEKIT_API_KEY: env.LIVEKIT_API_KEY,
    LIVEKIT_API_SECRET: env.LIVEKIT_API_SECRET,
    LIVEKIT_METRICS_PASSWORD: env.LIVEKIT_METRICS_PASSWORD ?? "",
  };
  await writeFile(`${dir}/node.env`, Object.entries(nodeEnv).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
  await issueCertificate(id, `${dir}/pki`);
}

// ── Файлы узла управления: магистраль, цели метрик, реестр ────────────────────────────────────────
const mediaNodes = registry.nodes.filter((n) => !n.control);
await mkdir("infra/generated/backbone-pki", { recursive: true });
await mkdir("infra/generated/scrape-nodes", { recursive: true });
await writeFile("infra/generated/backbone.json", JSON.stringify(controlBackbone(control, mediaNodes), null, 2));
await issueCertificate(control.id, "infra/generated/backbone-pki");
for (const n of mediaNodes) {
  const ports = controlPorts(n.index);
  const targets = [
    ["livekit", ports.metrics],
    ["node", ports.node],
    ["gateway", ports.gateway],
    ["probe", ports.probe],
  ].map(([role, port]) => ({ targets: [`127.0.0.1:${port}`], labels: { node: n.id, role } }));
  await writeFile(`infra/generated/scrape-nodes/${n.id}.json`, JSON.stringify(targets, null, 2) + "\n");
}
await mkdir("infra/generated/nodes", { recursive: true });
await writeFile(NODES_FILE, JSON.stringify(registry, null, 2) + "\n");

// Что добавить в `.env` A: политика CSP веба пускает браузер к именам узлов, шлюз называет свой узел,
// профиль `nodes` поднимает контейнер магистрали. Пишется только с `--write-env` — `.env` правит владелец.
const csp = mediaNodes.flatMap((n) => [n.probeUrl, n.rtcUrl, n.rtcUrl.replace(/^wss/, "https")]).join(" ");
const patch = { NODE_ID: control.id, CSP_NODES: csp };
if (args["write-env"]) {
  let text = await readFile(".env", "utf8");
  if (!text.endsWith("\n")) text += "\n";
  const profiles = (env.COMPOSE_PROFILES ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  if (!profiles.includes("nodes")) profiles.push("nodes");
  patch.COMPOSE_PROFILES = profiles.join(",");
  for (const [k, v] of Object.entries(patch))
    text = new RegExp(`^${k}=.*$`, "m").test(text) ? text.replace(new RegExp(`^${k}=.*$`, "m"), `${k}=${v}`) : text + `${k}=${v}\n`;
  await writeFile(".env", text, { mode: 0o600 });
}

console.log(`Nodes: ${registry.nodes.map((n) => `${n.id}${n.control ? " (control)" : ""}${n.country ? ` ${n.country}` : ""}${n.enabled ? "" : " [drained]"}`).join(", ")}
${node ? `Node ${node.id}: ${node.mode} · ${node.rtcUrl} · twirp via ${node.internalUrl} · load via ${node.loadUrl} · ${node.uplinkMbps} Mbit/s, SFU ${node.sfuMemoryMb} MiB${node.cores ? `, ${node.cores} cores` : ""} · files in ${resolve(`infra/generated/nodes/${node.id}`)}` : ""}
Control node ${control.id}: backbone infra/generated/backbone.json, pki infra/generated/backbone-pki, targets infra/generated/scrape-nodes/

.env of the control node needs (${args["write-env"] ? "written" : "add with --write-env or by hand"}):
  NODE_ID=${patch.NODE_ID}
  CSP_NODES=${patch.CSP_NODES}
  COMPOSE_PROFILES=…,nodes
Firewall on the control node: allow ${BACKBONE_PORT}/tcp from ${mediaNodes.map((n) => n.ip).join(", ") || "<node IPs>"} only.
Next: backlog/bin/node.sh ${node?.id ?? "<id>"} deploy`);

// ── Вспомогательное ───────────────────────────────────────────────────────────────────────────────
function assertCountry(value) {
  const code = String(value).trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) throw new Error(`--country must be an ISO 3166-1 alpha-2 code like DE, FI, RU (got ${JSON.stringify(value)})`);
  return code;
}

function assertPositive(flag, value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer`);
  return n;
}

function openssl(params) {
  execFileSync("openssl", params, { stdio: ["ignore", "ignore", "pipe"] });
}

async function exists(path) {
  return access(path).then(() => true, () => false);
}

/**
 * Внутренний ЦС магистрали и сертификат узла: ECDSA P-256, SAN `<id>.cord` и `*.<id>.cord`, годен и как
 * серверный, и как клиентский. ЦС живёт в `.local/backbone` только на A; на узел уезжают `ca.crt`,
 * `node.crt`, `node.key`. `--renew` перевыпускает сертификат узла (ЦС не трогается).
 */
async function issueCertificate(id, outDir) {
  await mkdir(CA_DIR, { recursive: true, mode: 0o700 });
  if (!(await exists(`${CA_DIR}/ca.crt`))) {
    openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", `${CA_DIR}/ca.key`]);
    await chmod(`${CA_DIR}/ca.key`, 0o600);
    openssl(["req", "-x509", "-new", "-key", `${CA_DIR}/ca.key`, "-sha256", "-days", "3650", "-subj", "/CN=cord-backbone-ca", "-out", `${CA_DIR}/ca.crt`]);
  }
  const crt = `${CA_DIR}/${id}.crt`;
  const key = `${CA_DIR}/${id}.key`;
  if (args.renew || !(await exists(crt))) {
    openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", key]);
    await chmod(key, 0o600);
    const ext = `${CA_DIR}/${id}.ext`;
    await writeFile(ext, `subjectAltName=DNS:${id}.cord,DNS:*.${id}.cord\nextendedKeyUsage=serverAuth,clientAuth\nbasicConstraints=CA:FALSE\n`);
    openssl(["req", "-new", "-key", key, "-subj", `/CN=${id}.cord`, "-out", `${CA_DIR}/${id}.csr`]);
    openssl(["x509", "-req", "-in", `${CA_DIR}/${id}.csr`, "-CA", `${CA_DIR}/ca.crt`, "-CAkey", `${CA_DIR}/ca.key`, "-CAcreateserial", "-days", "825", "-sha256", "-extfile", ext, "-out", crt]);
  }
  await writeFile(`${outDir}/ca.crt`, await readFile(`${CA_DIR}/ca.crt`));
  await writeFile(`${outDir}/node.crt`, await readFile(crt));
  await writeFile(`${outDir}/node.key`, await readFile(key), { mode: 0o600 });
  await chmod(`${outDir}/node.key`, 0o600);
}
