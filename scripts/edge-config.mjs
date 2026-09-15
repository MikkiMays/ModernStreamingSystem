import { isIP } from "node:net";

// Ports owned by the stack itself. Nothing configurable may collide with them.
const RESERVED = [1080, 5432, 6379, 7880, 7881, 8080, 5349];

// Where LiveKit reads the certificate it presents for TURN/TLS. scripts/turn-cert.mjs
// keeps these files in sync with the certificate Caddy issued for the same name.
export const TURN_CERT = "/etc/tls/turn.crt";
export const TURN_KEY = "/etc/tls/turn.key";
export const TURN_TLS_PORT = 5349;

const validHost = (value) =>
  typeof value === "string" &&
  value.length <= 253 &&
  value.includes(".") &&
  value
    .split(".")
    .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));

export function servicePorts(args) {
  const ports = {};
  for (const [name, fallback] of [["gateway-port", 8091], ["hooks-port", 8090]]) {
    const value = String(args[name] ?? fallback);
    if (!/^\d+$/.test(value) || Number(value) < 1024 || Number(value) > 65535)
      throw new Error(`--${name} must be an unprivileged TCP port`);
    ports[name] = Number(value);
  }
  const used = [...RESERVED, ...Object.values(ports)];
  if (new Set(used).size !== used.length)
    throw new Error("Gateway/hooks ports conflict with a streaming service");
  return ports;
}

function legacyHosts(args, ports, taken) {
  const legacy = args["legacy-hosts"]?.split(",") ?? [];
  if (legacy.length > 20 || legacy.some((host) => !validHost(host)))
    throw new Error(
      "--legacy-hosts must contain at most 20 explicit, lowercase DNS names",
    );
  if (new Set([...taken, ...legacy]).size !== taken.length + legacy.length)
    throw new Error("App, RTC, TURN and legacy DNS names must all be distinct");
  const port = args["legacy-tls-port"] ?? "8443";
  if (!/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535)
    throw new Error("--legacy-tls-port must be an unprivileged TCP port");
  if ([...RESERVED, ...Object.values(ports)].includes(Number(port)))
    throw new Error("--legacy-tls-port conflicts with a streaming service");
  if (args["legacy-tls-port"] && !legacy.length)
    throw new Error("--legacy-tls-port requires --legacy-hosts");
  return { legacy, port: Number(port) };
}

/**
 * Three deployment shapes, all driven by the same generated files.
 *
 * simple — one DNS name. The gateway already separates the app and `/rtc` by path,
 *   so signaling does not need a name of its own. TURN/TLS cannot share 443 with
 *   HTTPS under a single name (the edge routes by SNI and both would match), so
 *   LiveKit terminates TURN/TLS itself on 5349.
 * strict — three DNS names. Distinct SNI lets TURN/TLS share the external 443,
 *   which is the only thing that traverses firewalls allowing nothing but 443.
 * ip — no DNS at all. A self-signed certificate carrying the IP in a SAN. Browsers
 *   warn once; camera, microphone and screen capture need a secure context and do
 *   not work over plain HTTP, so this is the only workable no-domain shape.
 */
export function resolveTopology(args) {
  const ports = servicePorts(args);
  const named = ["app", "rtc", "turn"].filter((field) => args[field]);
  let mode = args.mode;
  if (mode && !["simple", "strict", "ip"].includes(mode))
    throw new Error("--mode must be simple, strict or ip");
  if (!mode) mode = named.length ? "strict" : args.domain ? "simple" : "ip";
  if (!isIP(args.ip ?? ""))
    throw new Error("Specify --ip=PUBLIC_IP of this machine");

  if (mode === "strict") {
    const hosts = ["app", "rtc", "turn"].map((field) => {
      if (!validHost(args[field]))
        throw new Error(`Specify --${field}=host.example.com`);
      return args[field];
    });
    if (new Set(hosts).size !== hosts.length)
      throw new Error("App, RTC, TURN and legacy DNS names must all be distinct");
    const { legacy, port } = legacyHosts(args, ports, hosts);
    const [app, rtc, turn] = hosts;
    return {
      mode,
      app,
      rtc,
      turn,
      ip: args.ip,
      hosts,
      legacy,
      legacyPort: port,
      ports,
      // The edge terminates TLS for turn.* on 443 and forwards plaintext to LiveKit.
      // LiveKit then advertises turns:<domain>:443, which is what the SNI route serves.
      externalTls: true,
      turnTlsPort: TURN_TLS_PORT,
      scheme: "https",
      origin: `https://${app}`,
    };
  }

  if (mode === "simple") {
    const domain = args.domain ?? args.app;
    if (!validHost(domain))
      throw new Error("Specify --domain=meet.example.com");
    const { legacy, port } = legacyHosts(args, ports, [domain]);
    return {
      mode,
      app: domain,
      rtc: domain,
      turn: domain,
      ip: args.ip,
      hosts: [domain],
      legacy,
      legacyPort: port,
      ports,
      // LiveKit holds the certificate itself, so it advertises turns:<domain>:5349
      // instead of the 443 it hardcodes whenever TLS is terminated upstream.
      externalTls: false,
      turnTlsPort: TURN_TLS_PORT,
      scheme: "https",
      origin: `https://${domain}`,
    };
  }

  if (args.domain || named.length)
    throw new Error("--mode=ip takes no DNS names; drop --domain/--app/--rtc/--turn");
  const { legacy, port } = legacyHosts(args, ports, []);
  const host = isIP(args.ip) === 6 ? `[${args.ip}]` : args.ip;
  return {
    mode,
    app: host,
    rtc: host,
    turn: args.ip,
    ip: args.ip,
    hosts: [],
    legacy,
    legacyPort: port,
    ports,
    externalTls: false,
    turnTlsPort: TURN_TLS_PORT,
    scheme: "https",
    origin: `https://${host}`,
  };
}

/** Kept for callers that only need the strict-mode host triple. */
export function validateEdgeHosts(args) {
  const { hosts, legacy, legacyPort } = resolveTopology({
    ...args,
    ip: args.ip ?? "192.0.2.1",
  });
  return { hosts, legacy, port: legacyPort };
}

export function createEdge(args) {
  const topology = args.mode || args.domain || args.ip ? args : { ...args, ip: "192.0.2.1" };
  const { mode, app, rtc, turn, hosts, legacy, legacyPort, ports } =
    resolveTopology(topology);
  const gateway = ports["gateway-port"];
  const route = (sni, target, http = false) => ({
    match: [sni.length ? { tls: { sni } } : { tls: {} }],
    handle: [
      {
        handler: "tls",
        ...(http ? { connection_policies: [{ alpn: ["http/1.1"] }] } : {}),
      },
      {
        handler: "proxy",
        ...(http ? { proxy_protocol: "v2" } : {}),
        upstreams: [{ dial: [`127.0.0.1:${target}`] }],
      },
    ],
  });
  // Preserve the existing server's TLS, authentication and HTTP routing end to end.
  // No TLS termination or PROXY header is inserted into this byte stream.
  const passthrough = {
    match: [{ tls: { sni: legacy } }],
    handle: [
      { handler: "proxy", upstreams: [{ dial: [`127.0.0.1:${legacyPort}`] }] },
    ],
  };

  let routes;
  if (mode === "strict") routes = [route([turn], 5349), route([app], gateway, true), route([rtc], gateway, true)];
  else if (mode === "simple") routes = [route([app], gateway, true)];
  else routes = [];
  if (legacy.length) routes.push(passthrough);
  // Without a DNS name there is no SNI to match on, so the catch-all must come last.
  if (mode === "ip") routes.push(route([], gateway, true));

  return {
    admin: { disabled: true },
    logging: { logs: { default: { level: "WARN" } } },
    storage: { module: "file_system", root: "/data" },
    apps: {
      tls: {
        certificates:
          mode === "ip"
            ? { load_files: [{ certificate: TURN_CERT, key: TURN_KEY }] }
            : { automate: hosts },
        // On a shared VPS the existing Caddy continues owning port 80.
        ...(legacy.length && mode !== "ip"
          ? {
              automation: {
                policies: [
                  {
                    subjects: hosts,
                    issuers: [
                      {
                        module: "acme",
                        challenges: { http: { disabled: true } },
                      },
                    ],
                  },
                ],
              },
            }
          : {}),
      },
      layer4: { servers: { main: { listen: [":443"], routes } } },
    },
  };
}
