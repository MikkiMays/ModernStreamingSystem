import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { createEdge, resolveTopology } from "./edge-config.mjs";
import { createLivekit } from "./livekit-config.mjs";

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
 * ЧТО ДЕЛАЕТ. Читает существующий `.env`, берёт из него ВСЕ секреты как есть и переписывает
 * порождаемые файлы. Секреты не меняются, живые сессии не отзываются, то, что владелец правил
 * руками (ACCESS_PASSWORD, ADMISSION_OPEN, лимиты), не трогается. В `.env` переписываются только
 * адресные ключи, которые генератор сам выводит из топологии (R200 §8.6, `derived` ниже), — и
 * только если топология назвала другие адреса; разошлись с `.env` имена, не названные в команде, —
 * отказ (`--check` показывает это заранее).
 */
const refresh = "refresh" in args;
/**
 * `--refresh --check` — показать, что перевыпуск сделал бы с `.env`, и ничего не записать (`update.sh --check`).
 * Выход 3 — перевыпуск без имён вернул бы прежние адреса (см. «Имена topology.json против .env» ниже).
 */
const check = "check" in args;
if (check && !refresh) throw new Error("--check works only with --refresh: a new installation has nothing to compare.");
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
  // Без файла верим только адресам, названным явно: их и запишем, чтобы дальше хватало `--refresh`.
  if (!stored && !(args.domain || args.app))
    throw new Error(
      `${TOPOLOGY_FILE} is missing: this server was configured before it existed, and .env does not record --legacy-hosts. ` +
        "Re-run the original configure command with --refresh added, for example: " +
        `node scripts/configure.mjs --refresh --domain=${saved.APP_HOST} --ip=${saved.PUBLIC_IP} [--legacy-hosts=...]`,
    );
  // Аргументы командной строки всё же старше: ими правят то, что поменялось на самом деле.
  topologyArgs = { ...stored, ...args };
}
const topology = resolveTopology(topologyArgs);
const { ports, app, rtc, turn, ip, mode } = topology;

/**
 * Адресные ключи `.env`, которые генератор сам выводит из топологии (R200 §8.6). Секреты и то, что правил владелец,
 * `--refresh` не трогает. Но имена, режим и порты задаются аргументами и `topology.json`, а в `.env` лежат их копии —
 * и до R200 при смене имён (`--refresh --app=cord.online …`) там оставались прежние `APP_HOST`, `PUBLIC_URL`,
 * `LIVEKIT_URL`: ядро и служба интеграций отказывали запросам по Origin, SFU звал клиентов на старое имя, и всё это
 * правилось руками (meet → новое имя продукта, 08.11.2026). Теперь ключи при расхождении переписываются на месте; остальные
 * строки остаются байт в байт. `SERVER_NAME` — имя для людей, его меняем только пока оно равно прежнему адресу.
 */
const derived = {
  DEPLOY_MODE: mode,
  APP_HOST: app,
  RTC_HOST: rtc,
  TURN_HOST: turn,
  PUBLIC_IP: ip,
  GATEWAY_PORT: ports["gateway-port"],
  HOOKS_PORT: ports["hooks-port"],
  PUBLIC_URL: topology.origin,
  LIVEKIT_URL: topology.origin.replace(/^https/, "wss"),
};
const retargets = [];
if (refresh) {
  const wanted = Object.fromEntries(Object.entries(derived).map(([k, v]) => [k, String(v)]));
  if (saved.SERVER_NAME !== undefined && saved.SERVER_NAME === saved.APP_HOST && saved.APP_HOST !== app)
    wanted.SERVER_NAME = app;
  for (const [k, want] of Object.entries(wanted)) if (saved[k] !== want) retargets.push([k, saved[k], want]);
}
const describe = ([k, from, to]) => `${k}: ${from === undefined ? "(не было)" : from} → ${to}`;

/**
 * Имена topology.json против .env (ревью R200 §8.6). Перевыпуск без имён в командной строке берёт имена из
 * topology.json — и переписал бы ими адресные ключи `.env`, а заодно `edge.json` и `livekit.json`. Если `.env` правили
 * руками (meet → новое имя продукта, 08.11.2026), а topology.json остался прежним, обычное `./update.sh` вернуло бы продукт на
 * старое имя. Поэтому имя, режим или адрес, которые разошлись с `.env` и не названы в этой команде, — отказ до записи
 * чего-либо и готовая команда, которая выровняет topology.json по `.env`. Названы — значит, переезд и задуман.
 */
const HOST_SOURCES = {
  DEPLOY_MODE: ["mode", "domain", "app", "rtc", "turn"],
  APP_HOST: ["app", "domain", "mode"],
  RTC_HOST: ["rtc", "domain", "mode"],
  TURN_HOST: ["turn", "domain", "mode"],
  PUBLIC_IP: ["ip"],
};
const drift = retargets.filter(
  ([k, from]) => k in HOST_SOURCES && from !== undefined && from !== "" && !HOST_SOURCES[k].some((a) => a in args),
);
if (drift.length) {
  const names =
    saved.DEPLOY_MODE === "strict"
      ? `--mode=strict --app=${saved.APP_HOST} --rtc=${saved.RTC_HOST} --turn=${saved.TURN_HOST}`
      : saved.DEPLOY_MODE === "simple"
        ? `--mode=simple --domain=${saved.APP_HOST}`
        : "--mode=ip";
  const message = `ВНИМАНИЕ: ${TOPOLOGY_FILE} называет не те адреса, что .env (${drift.map(describe).join("; ")}).
Перевыпуск без имён вернул бы их в .env, edge.json и livekit.json — сервер ушёл бы со своего имени.
Если правда — .env, выровнять topology.json по нему (перевыпустит и порождённые файлы, секреты не тронет):
  node scripts/configure.mjs --refresh ${names} --ip=${saved.PUBLIC_IP}
Если правда — topology.json (переезд задуман), назвать имена в команде явно, как в docs/RELEASE.md «Переход в strict».`;
  if (!check) throw new Error(message);
  console.log(message);
}
if (check) {
  const rest = retargets.filter((r) => !drift.includes(r));
  console.log(
    rest.length
      ? `Перевыпуск перепишет в .env (секреты не тронет): ${rest.map(describe).join("; ")}.`
      : drift.length
        ? "Остальные адресные ключи .env совпадают с топологией."
        : "Перевыпуск .env не меняет: адреса совпадают с топологией.",
  );
  console.log("Это была проверка: ничего не записано.");
  process.exit(drift.length ? 3 : 0);
}

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
/**
 * Аналитика (R239, docs/architecture/analytics-v2.md §11, contracts/insight.md §5). Служба `insight` всё своё выводит
 * из секретов, которые уже есть: псевдонимы и подпись куки — из `SESSION_SECRET`, ключ фактов и отчётов — из
 * `INTERNAL_SECRET` (HKDF, назначение `insight`), база — та же. Новый секрет один: `ANALYTICS_PROBE_KEY` — им
 * автотесты, дымовые и нагрузочные проверки подписывают `X-Cord-Probe`, чтобы не попадать в цифры. Он создаётся
 * при установке, а перевыпуск дописывает его серверу, поставленному раньше, — один раз, без вращения.
 */
const ANALYTICS_KEYS = {
  ANALYTICS_PROBE_KEY: () => randomBytes(32).toString("base64url"),
};
const key = refresh ? saved.LIVEKIT_API_KEY : `API${randomBytes(9).toString("hex")}`;
const mediaSecret = refresh ? saved.LIVEKIT_API_SECRET : secret();
const redis = refresh ? saved.REDIS_PASSWORD : secret();

await mkdir("infra/generated/tls", { recursive: true });

// ip mode: the edge serves HTTPS on the bare address with this self-signed certificate
// (IP in the SAN). The SFU holds no certificate in any mode: TURN/TLS exists only in
// strict, where the edge terminates it.
const certExists = await access(`infra/generated/tls/turn.crt`).then(
  () => true,
  () => false,
);
if (mode === "ip" && !certExists) {
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
  ...derived,
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
  // Имя пульта флота (R207, Р-119): только у A (`--admin=admin.callcord.ru`). Пусто — блока `@admin` на
  // шлюзе как бы нет, служба `fleet` не поднимается (профиль `admin`).
  ADMIN_HOST: topology.admin ?? "",
  ...Object.fromEntries(Object.entries(ANALYTICS_KEYS).map(([k, make]) => [k, make()])),
  ...(monitoring
    ? {
        ...Object.fromEntries(Object.entries(MONITORING_KEYS).map(([k, make]) => [k, make()])),
        COMPOSE_PROFILES: "monitoring",
      }
    : {}),
};
// Перевыпуск .env целиком не пишет: там живут секреты и то, что владелец правил руками. Исключения —
// адресные ключи (`retargets` ниже), `--admin` и `--monitoring`: недостающие ключи профиля дописываются
// в конец, а `COMPOSE_PROFILES` получает `monitoring` рядом с тем, что там уже было.
if (!refresh)
  await writeFile(
    ".env",
    Object.entries(values)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n",
    { mode: 0o600 },
  );
const env = refresh ? { ...saved } : { ...values };

// Адресные ключи `.env` при перевыпуске — план посчитан выше (`retargets`), здесь он записывается.
let envText = existing;
const retargeted = retargets.map(describe);
if (refresh) {
  for (const [k, , want] of retargets) {
    env[k] = want;
    const line = new RegExp(`^${k}=.*$`, "m");
    envText = line.test(envText)
      ? envText.replace(line, `${k}=${want}`)
      : `${envText.endsWith("\n") || envText === "" ? envText : envText + "\n"}${k}=${want}\n`;
  }
  if (envText !== existing) await writeFile(".env", envText, { mode: 0o600 });
}
if (refresh && monitoring) {
  let text = envText.endsWith("\n") ? envText : envText + "\n";
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
  if (text !== envText) await writeFile(".env", text, { mode: 0o600 });
}
// `--admin` при перевыпуске: имя пульта — единственное, что `--refresh` дописывает в `.env` кроме профиля
// `monitoring`; без него у шлюза A нет блока `@admin`. Удаление имени — `--admin=` (пустое).
if (refresh && "admin" in args) {
  let text = await readFile(".env", "utf8");
  if (!text.endsWith("\n")) text += "\n";
  const line = `ADMIN_HOST=${topology.admin ?? ""}`;
  text = /^ADMIN_HOST=.*$/m.test(text) ? text.replace(/^ADMIN_HOST=.*$/m, line) : text + line + "\n";
  env.ADMIN_HOST = topology.admin ?? "";
  await writeFile(".env", text, { mode: 0o600 });
}

// Ключи аналитики серверу, поставленному до R239: дописываются в конец `.env`, остальные строки — байт в байт.
if (refresh) {
  const missing = Object.entries(ANALYTICS_KEYS).filter(([k]) => !saved[k]);
  if (missing.length) {
    let text = await readFile(".env", "utf8");
    if (!text.endsWith("\n")) text += "\n";
    for (const [k, make] of missing) {
      env[k] = make();
      text += `${k}=${env[k]}\n`;
    }
    await writeFile(".env", text, { mode: 0o600 });
  }
}

/**
 * Сколько подключений SFU пускает в одну встречу.
 *
 * Ядро считает людей (`stream.max-participants`, по умолчанию 30 — R228, Р-135; бот музыки места не
 * занимает), а SFU — все подключения: бота и переходную сессию того, кто вернулся раньше, чем ушла
 * прежняя. Поэтому здесь на четыре больше — иначе тридцать первым упёрся бы в SFU не человек, а бот, и
 * вместо понятного `ROOM_FULL` от ядра встреча молча не пустила бы музыку.
 */
const MAX_PARTICIPANTS = Number(saved.STREAM_MAX_PARTICIPANTS) || 30;

const livekit = createLivekit({
  ip,
  turn,
  turnTlsPort: topology.turnTlsPort,
  externalTls: topology.externalTls,
  key,
  secret: mediaSecret,
  redis: { address: "127.0.0.1:6379", password: redis },
  metricsPassword: env.LIVEKIT_METRICS_PASSWORD,
  maxParticipants: MAX_PARTICIPANTS,
  webhookUrl: `http://127.0.0.1:${ports["hooks-port"]}/internal/livekit`,
});
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
 * Куда Alertmanager шлёт оповещения (профиль `monitoring`). Telegram — отдельный бот оповещений владельца
 * (`ALERT_TELEGRAM_BOT_TOKEN` в `.local/alerts.env`), а без него — бот Cord (`.local/telegram.env`): оповещения
 * не должны зависеть от бота встреч. Чат — `ALERT_TELEGRAM_CHAT_ID` из `.env` или из `.local/alerts.env` (туда
 * его пишет `scripts/alerts-chat.mjs`); без чата или токена оповещения видны только в Grafana.
 * `HEALTHCHECKS_URL` — внешний сторож: вечный алерт `Watchdog` пингует его раз в минуту, и о смерти самой
 * машины скажет он, а не она. JSON — это тоже YAML: файл читает Alertmanager как есть.
 */
const telegramEnv = await readFile(".local/telegram.env", "utf8").catch(() => "");
const alertsEnv = await readFile(".local/alerts.env", "utf8").catch(() => "");
const setting = (text, name) => new RegExp(`^${name}=(.+)$`, "m").exec(text)?.[1]?.trim();
const botToken =
  setting(alertsEnv, "ALERT_TELEGRAM_BOT_TOKEN") ?? setting(telegramEnv, "CORD_MEET_TELEGRAM_BOT_TOKEN");
const chatId = Number(env.ALERT_TELEGRAM_CHAT_ID || setting(alertsEnv, "ALERT_TELEGRAM_CHAT_ID"));
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
          // Срочное (`page`) идёт сразу и напоминает каждые шесть часов — маршрут по умолчанию. Предупреждения и
          // справочные — реже: чат владельца читают, пока в нём мало сообщений, а «ЦП занят» при каждой сборке и
          // «включена защита» напоминанием раз в шесть часов делают из него шум.
          { matchers: ['severity="warn"'], receiver: "owner", group_wait: "2m", repeat_interval: "24h" },
          {
            matchers: ['severity="info"'],
            receiver: "owner",
            group_wait: "5m",
            group_interval: "1h",
            repeat_interval: "72h",
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
Open TCP 80, TCP 443, TCP 7881, UDP 3478 and UDP 7882.
TURN over TLS on 443 (VPN, networks that allow only 443) needs strict mode:
add rtc.${app} and turn.${app} records, then switch as docs/RELEASE.md «Переход в strict» says.`,
  strict: `Three DNS names. Point A records for ${app}, ${rtc} and ${turn} at ${ip}.
Open TCP 80, TCP 443, TCP 7881, UDP 3478 and UDP 7882.`,
  ip: `No DNS. The certificate is self-signed and carries IP:${ip}.
Every browser shows a one-time warning that has to be accepted before camera,
microphone and screen sharing become available.
Open TCP 443, TCP 7881, UDP 3478 and UDP 7882.
There is no TURN over TLS without DNS names: networks that allow only 443 get no media.`,
};
const retargetNote = retargeted.length
  ? `
.env retargeted (secrets untouched): ${retargeted.join("; ")}.
core, gateway and services read .env — recreate them; edge and livekit read the generated files only at start:
  docker compose up -d edge gateway core services livekit && docker compose restart edge livekit
`
  : "";
console.log(`Mode: ${mode}
${notes[mode]}

Configuration written to ${resolve("infra/generated")}. Secrets are in .env.${retargetNote}
Apply the documented firewall rules before starting services.

Server address to paste into Cord: ${topology.origin}`);
