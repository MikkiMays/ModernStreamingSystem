import { randomBytes } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isIP } from "node:net";
import { createEdge, validateEdgeHosts, servicePorts } from "./edge-config.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split("=")),
);
validateEdgeHosts(args);
const ports = servicePorts(args);
if (!isIP(args.ip ?? "")) throw new Error("Specify --ip=PUBLIC_VPS_IP");
try {
  await readFile(".env");
  throw new Error(
    ".env already exists. Preserve existing secrets; do not rotate active sessions accidentally.",
  );
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const secret = () => randomBytes(32).toString("hex");
const key = `API${randomBytes(9).toString("hex")}`;
const mediaSecret = secret();
const internal = secret();
const redis = secret();
const values = {
  APP_HOST: args.app,
  RTC_HOST: args.rtc,
  TURN_HOST: args.turn,
  PUBLIC_IP: args.ip,
  GATEWAY_PORT: ports["gateway-port"],
  HOOKS_PORT: ports["hooks-port"],
  PUBLIC_URL: `https://${args.app}`,
  LIVEKIT_URL: `wss://${args.rtc}`,
  LIVEKIT_INTERNAL_URL: "http://127.0.0.1:7880",
  LIVEKIT_API_KEY: key,
  LIVEKIT_API_SECRET: mediaSecret,
  SESSION_SECRET: secret(),
  INTERNAL_SECRET: internal,
  DATABASE_URL: "jdbc:postgresql://127.0.0.1:5432/streaming",
  DATABASE_USER: "streaming",
  DATABASE_PASSWORD: secret(),
  REDIS_HOST: "127.0.0.1",
  REDIS_PASSWORD: redis,
  FILES_ROOT: "/data/uploads",
  ADMISSION_OPEN: "true",
};
await mkdir("infra/generated", { recursive: true });
await writeFile(
  ".env",
  Object.entries(values)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n") + "\n",
  { mode: 0o600 },
);
const livekit = {
  port: 7880,
  bind_addresses: ["0.0.0.0"],
  rtc: {
    tcp_port: 7881,
    udp_port: 7882,
    use_external_ip: false,
    node_ip: args.ip,
  },
  redis: { address: "127.0.0.1:6379", password: redis },
  keys: { [key]: mediaSecret },
  room: { empty_timeout: 300, departure_timeout: 60, max_participants: 10 },
  turn: {
    enabled: true,
    domain: args.turn,
    tls_port: 5349,
    udp_port: 3478,
    external_tls: true,
    per_user_relay_allocation_limit: 12,
  },
  webhook: { api_key: key, urls: [`http://127.0.0.1:${ports["hooks-port"]}/internal/livekit`] },
  logging: { level: "warn" },
};
await writeFile(
  "infra/generated/livekit.json",
  JSON.stringify(livekit, null, 2),
  { mode: 0o600 },
);
const edge = createEdge(args);
await writeFile("infra/generated/edge.json", JSON.stringify(edge, null, 2));
await writeFile(
  "infra/generated/redis.conf",
  `bind 127.0.0.1\nport 6379\nprotected-mode yes\nrequirepass ${redis}\nsave ""\nappendonly no\nmaxmemory 256mb\nmaxmemory-policy noeviction\n`,
  { mode: 0o600 },
);
console.log(
  `Configuration written to ${resolve("infra/generated")}. Secrets are in .env. Apply the documented firewall rules before starting services.`,
);
