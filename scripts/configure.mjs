import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createEdge,
  resolveTopology,
  TURN_CERT,
  TURN_KEY,
} from "./edge-config.mjs";
import { peerRules } from "./turn-guard.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split("=")),
);

/**
 * Перевыпуск конфигурации работающего сервера.
 *
 * ЗАЧЕМ. `livekit.json`, `edge.json` и `redis.conf` порождаются здесь и в Git не хранятся.
 * Значит, всё, что меняется в этом генераторе, до уже установленного сервера не доезжало
 * никогда: `.env` существует, скрипт отказывается работать, и человек остаётся с конфигом
 * той версии, на которой ставил. Именно этот класс расхождений и незаметен дольше всего.
 *
 * ЧТО ДЕЛАЕТ. Читает существующий `.env`, берёт из него ВСЕ секреты и адреса как есть и
 * переписывает только порождаемые файлы. Секреты не меняются, живые сессии не отзываются,
 * сам `.env` не трогается — включая то, что владелец правил руками (ACCESS_PASSWORD,
 * ADMISSION_OPEN, лимиты).
 */
const refresh = "refresh" in args;
const existing = await readFile(".env", "utf8").catch((e) => {
  if (e.code === "ENOENT") return null;
  throw e;
});
if (existing && !refresh)
  throw new Error(
    ".env already exists. Preserve existing secrets; do not rotate active sessions accidentally. Use --refresh to regenerate only the derived files.",
  );
if (refresh && !existing)
  throw new Error("--refresh needs an existing .env: there is nothing to preserve here.");

const saved = Object.fromEntries(
  (existing ?? "")
    .split("\n")
    .filter((line) => /^[A-Z_]+=/.test(line))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
);

/**
 * Чем этот сервер был установлен.
 *
 * `.env` хранит не всё: соседние сайты на том же 443 (`--legacy-hosts`) живут только в
 * `edge.json`, и перевыпуск по одному `.env` молча снёс бы их маршруты вместе с чужим
 * сайтом. Поэтому аргументы установки сохраняются рядом с порождёнными файлами, и
 * перевыпуск повторяет ровно их. Установке до появления этого файла перевыпуск честно
 * отказывает и называет, чего ему не хватает, — это лучше тихо испорченной конфигурации.
 */
const TOPOLOGY_FILE = "infra/generated/topology.json";
let topologyArgs = args;
if (refresh) {
  const stored = await readFile(TOPOLOGY_FILE, "utf8").then(JSON.parse, (e) => {
    if (e.code !== "ENOENT") throw e;
    return null;
  });
  if (!stored)
    throw new Error(
      `${TOPOLOGY_FILE} is missing: this server was configured before it existed, and .env does not record --legacy-hosts. ` +
        "Re-run the original configure command with --refresh added, for example: " +
        `node scripts/configure.mjs --refresh --domain=${saved.APP_HOST} --ip=${saved.PUBLIC_IP} [--legacy-hosts=...]`,
    );
  // Аргументы командной строки всё же старше: ими правят то, что поменялось на самом деле.
  topologyArgs = { ...stored, ...args };
}
const topology = resolveTopology(topologyArgs);

const secret = () => randomBytes(32).toString("hex");

/**
 * Профиль `monitoring` (E10-B, docs/observability.md): VictoriaMetrics, Grafana, алерты. По умолчанию
 * выключен — `--monitoring` включает его здесь, на установке и при перевыпуске.
 *
 * ЧТО ДОБАВЛЯЕТ В .env. Пароль метрик LiveKit (их порт слушает на тех же адресах, что и сигналинг, то
 * есть на 0.0.0.0, — без пароля метрики SFU видел бы весь интернет), пароль входа в Grafana и
 * `COMPOSE_PROFILES=monitoring`, по которому `docker compose up -d` поднимает профиль сам. Уже
 * записанные значения не меняются: `.env` правит владелец, а секреты не вращаются сами.
 */
const monitoring = "monitoring" in args;
const MONITORING_KEYS = {
  LIVEKIT_METRICS_PASSWORD: () => secret(),
  GRAFANA_PASSWORD: () => randomBytes(18).toString("base64url"),
};
const key = refresh ? saved.LIVEKIT_API_KEY : `API${randomBytes(9).toString("hex")}`;
const mediaSecret = refresh ? saved.LIVEKIT_API_SECRET : secret();
const redis = refresh ? saved.REDIS_PASSWORD : secret();
const { ports, app, rtc, turn, ip, mode } = topology;

await mkdir("infra/generated/tls", { recursive: true });

// LiveKit needs a certificate on disk before it will start TURN/TLS, and in simple
// mode Caddy has not finished the ACME order yet. Write a self-signed certificate now
// so the SFU boots; scripts/turn-cert.mjs replaces it with the issued one afterwards.
// In ip mode this self-signed certificate is the real, permanent one.
const certExists = await access(`infra/generated/tls/turn.crt`).then(
  () => true,
  () => false,
);
if (!certExists) {
  const subject = mode === "ip" ? ip : turn;
  const san = mode === "ip" ? `IP:${ip}` : `DNS:${turn}`;
  execFileSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", "infra/generated/tls/turn.key",
      "-out", "infra/generated/tls/turn.crt",
      "-days", "3650", "-subj", `/CN=${subject}`,
      "-addext", `subjectAltName=${san}`,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
}

const values = {
  DEPLOY_MODE: mode,
  APP_HOST: app,
  RTC_HOST: rtc,
  TURN_HOST: turn,
  PUBLIC_IP: ip,
  GATEWAY_PORT: ports["gateway-port"],
  HOOKS_PORT: ports["hooks-port"],
  PUBLIC_URL: topology.origin,
  LIVEKIT_URL: topology.origin.replace(/^https/, "wss"),
  LIVEKIT_INTERNAL_URL: "http://127.0.0.1:7880",
  LIVEKIT_API_KEY: key,
  LIVEKIT_API_SECRET: mediaSecret,
  SESSION_SECRET: secret(),
  INTERNAL_SECRET: secret(),
  DATABASE_URL: "jdbc:postgresql://127.0.0.1:5432/streaming",
  DATABASE_USER: "streaming",
  DATABASE_PASSWORD: secret(),
  REDIS_HOST: "127.0.0.1",
  REDIS_PASSWORD: redis,
  FILES_ROOT: "/data/uploads",
  ADMISSION_OPEN: "true",
  // Empty means an open server: anyone with the address may create and join rooms, which is
  // what every installation did before the door existed. Put a word here and Cord asks for it
  // once per visit, before it shows anything about meetings.
  ACCESS_PASSWORD: "",
  // Пароль владельца сервера: страница «Активность» (/activity) — встречи, журнал, блокировки.
  // Пусто — страница выключена.
  ADMIN_PASSWORD: "",
  SERVER_NAME: app,
  ...(monitoring
    ? {
        ...Object.fromEntries(Object.entries(MONITORING_KEYS).map(([k, make]) => [k, make()])),
        COMPOSE_PROFILES: "monitoring",
      }
    : {}),
};
// Перевыпуск не трогает .env: там живут секреты и то, что владелец правил руками. Единственное
// исключение — `--monitoring`: недостающие ключи профиля дописываются в конец, а `COMPOSE_PROFILES`
// получает `monitoring` рядом с тем, что там уже было.
if (!refresh)
  await writeFile(
    ".env",
    Object.entries(values)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n",
    { mode: 0o600 },
  );
const env = refresh ? { ...saved } : { ...values };
if (refresh && monitoring) {
  let text = existing.endsWith("\n") ? existing : existing + "\n";
  for (const [k, make] of Object.entries(MONITORING_KEYS))
    if (!saved[k]) {
      env[k] = make();
      text += `${k}=${env[k]}\n`;
    }
  const profiles = (saved.COMPOSE_PROFILES ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  if (!profiles.includes("monitoring")) {
    env.COMPOSE_PROFILES = [...profiles, "monitoring"].join(",");
    text = /^COMPOSE_PROFILES=.*$/m.test(text)
      ? text.replace(/^COMPOSE_PROFILES=.*$/m, `COMPOSE_PROFILES=${env.COMPOSE_PROFILES}`)
      : text + `COMPOSE_PROFILES=${env.COMPOSE_PROFILES}\n`;
  }
  if (text !== existing) await writeFile(".env", text, { mode: 0o600 });
}

/**
 * Сколько подключений SFU пускает в одну встречу.
 *
 * Ядро считает людей (`stream.max-participants`, по умолчанию 20; бот музыки места не занимает), а
 * SFU — все подключения: бота и переходную сессию того, кто вернулся раньше, чем ушла прежняя.
 * Поэтому здесь на четыре больше — иначе двадцать первым упёрся бы в SFU не человек, а бот, и вместо
 * понятного `ROOM_FULL` от ядра встреча молча не пустила бы музыку.
 */
const MAX_PARTICIPANTS = Number(saved.STREAM_MAX_PARTICIPANTS) || 20;

const livekit = {
  port: 7880,
  bind_addresses: ["0.0.0.0"],
  rtc: {
    tcp_port: 7881,
    udp_port: 7882,
    use_external_ip: false,
    node_ip: ip,
  },
  // RED (RFC 2198) на отрезке SFU → слушатель для Opus: два предыдущих кадра повторяются в
  // каждом пакете, одиночные и парные потери (VPN, 1–6 %) исчезают; цена — втрое больше полосы
  // звука вниз (музыка 160 → 480 Кбит/с на слушателя) и кадр ≤ ~450 байт, чтобы три влезли в
  // MTU — отсюда 160k у издателя. Запас буфера приёма против потерь бессилен (MEDIA-DIAGNOSIS
  // §2.2), а это — лечит. `congestion_control.allow_pause` остаётся по умолчанию (true): пауза
  // видео только у того зрителя, чей канал не тянет, защищает его речь и музыку; отправка у
  // стримящего при этом не деградирует (X10) — решение в DECISIONS.md.
  audio: { active_red_encoding: true },
  redis: { address: "127.0.0.1:6379", password: redis },
  keys: { [key]: mediaSecret },
  room: { empty_timeout: 300, departure_timeout: 60, max_participants: MAX_PARTICIPANTS + 4 },
  turn: {
    enabled: true,
    domain: turn,
    tls_port: topology.turnTlsPort,
    udp_port: 3478,
    external_tls: topology.externalTls,
    // Whenever TLS is terminated upstream LiveKit advertises turns:<domain>:443
    // unconditionally, so it may only hold its own certificate in the other modes.
    ...(topology.externalTls ? {} : { cert_file: TURN_CERT, key_file: TURN_KEY }),
    per_user_relay_allocation_limit: 12,
    // Relay — только к SFU этой машины, не в интернет (A12, `turn-guard.mjs`): иначе учётка TURN любого
    // вошедшего пересылала бы UDP куда угодно с адреса сервера. Проверка живым LiveKit —
    // `scripts/turn-relay-check.sh`.
    ...peerRules(ip),
  },
  webhook: {
    api_key: key,
    urls: [`http://127.0.0.1:${ports["hooks-port"]}/internal/livekit`],
  },
  logging: { level: "warn" },
  // Метрики SFU для профиля `monitoring` — только с паролем: LiveKit 1.13 слушает этот порт на тех же
  // `bind_addresses`, что и сигналинг (0.0.0.0), отдельной привязки к 127.0.0.1 у него нет. Без пароля
  // в .env блока нет вовсе, и порт не открывается (docs/observability.md §3).
  ...(env.LIVEKIT_METRICS_PASSWORD
    ? { prometheus: { port: 6789, username: "metrics", password: env.LIVEKIT_METRICS_PASSWORD } }
    : {}),
};
await writeFile(
  "infra/generated/livekit.json",
  JSON.stringify(livekit, null, 2),
  { mode: 0o600 },
);
await writeFile(
  "infra/generated/edge.json",
  JSON.stringify(createEdge(topologyArgs), null, 2),
);
// То, чем это было собрано, — чтобы следующий перевыпуск повторил ровно эту конфигурацию.
await writeFile(
  TOPOLOGY_FILE,
  JSON.stringify(
    Object.fromEntries(Object.entries(topologyArgs).filter(([k]) => k !== "refresh")),
    null,
    2,
  ) + "\n",
);
/**
 * Куда Alertmanager шлёт оповещения (профиль `monitoring`). Telegram — бот Cord (токен из
 * `.local/telegram.env`) в чат владельца `ALERT_TELEGRAM_CHAT_ID`; без чата или токена оповещения видны
 * только в Grafana. `HEALTHCHECKS_URL` — внешний сторож: вечный алерт `Watchdog` пингует его раз в минуту,
 * и о смерти самой машины скажет он, а не она. JSON — это тоже YAML: файл читает Alertmanager как есть.
 */
const telegramEnv = await readFile(".local/telegram.env", "utf8").catch(() => "");
const botToken = /^CORD_MEET_TELEGRAM_BOT_TOKEN=(.+)$/m.exec(telegramEnv)?.[1]?.trim();
const chatId = Number(env.ALERT_TELEGRAM_CHAT_ID);
const owner = { name: "owner" };
if (botToken && Number.isInteger(chatId) && chatId !== 0)
  owner.telegram_configs = [{ bot_token: botToken, chat_id: chatId, send_resolved: true }];
const watchdog = { name: "watchdog" };
if (env.HEALTHCHECKS_URL)
  watchdog.webhook_configs = [{ url: env.HEALTHCHECKS_URL, send_resolved: false }];
await writeFile(
  "infra/generated/alertmanager.yml",
  JSON.stringify(
    {
      route: {
        receiver: "owner",
        group_by: ["alertname"],
        // Отбой обязателен и не мгновенен: хост замирает на 20–55 с (урок vm-host-stalls).
        group_wait: "1m",
        group_interval: "5m",
        repeat_interval: "6h",
        routes: [
          {
            matchers: ['alertname="Watchdog"'],
            receiver: "watchdog",
            group_wait: "0s",
            group_interval: "1m",
            repeat_interval: "1m",
          },
        ],
      },
      // Пока хост тормозит, отказы во входе и 5xx шлюза — следствие, а не новость: одно сообщение вместо
      // нескольких. «Не отвечает» не гасится: оно и так ждёт десять минут тишины, а замирание длится секунды.
      // Гасить им всё `severity: page` нельзя — на машине с вечным steal не пришло бы ничего (E10-B, замер).
      inhibit_rules: [
        {
          source_matchers: ['alertname="HostStalled"'],
          target_matchers: ['alertname=~"JoinFailures|GatewayErrors5xx"'],
        },
      ],
      receivers: [owner, watchdog],
    },
    null,
    2,
  ) + "\n",
  { mode: 0o600 },
);
await writeFile(
  "infra/generated/redis.conf",
  `bind 127.0.0.1\nport 6379\nprotected-mode yes\nrequirepass ${redis}\nsave ""\nappendonly no\nmaxmemory 256mb\nmaxmemory-policy noeviction\n`,
  { mode: 0o600 },
);

const notes = {
  simple: `One DNS name. Point an A record for ${app} at ${ip}.
Open TCP 80, TCP 443, TCP 5349, UDP 3478 and UDP 7882.`,
  strict: `Three DNS names. Point A records for ${app}, ${rtc} and ${turn} at ${ip}.
Open TCP 80, TCP 443, TCP 7881, UDP 3478 and UDP 7882.`,
  ip: `No DNS. The certificate is self-signed and carries IP:${ip}.
Every browser shows a one-time warning that has to be accepted before camera,
microphone and screen sharing become available.
Open TCP 443, TCP 5349, UDP 3478 and UDP 7882.`,
};
console.log(`Mode: ${mode}
${notes[mode]}

Configuration written to ${resolve("infra/generated")}. Secrets are in .env.
Apply the documented firewall rules before starting services.

Server address to paste into Cord: ${topology.origin}`);
