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
  const used = [1080, 5432, 6379, 7880, 7881, 8080, 5349, ...Object.values(ports)];
  if (new Set(used).size !== used.length)
    throw new Error("Gateway/hooks ports conflict with a streaming service");
  return ports;
}

export function validateEdgeHosts(args) {
  const ports = servicePorts(args);
  const hosts = ["app", "rtc", "turn"].map((field) => {
    if (!validHost(args[field]))
      throw new Error(`Specify --${field}=host.example.com`);
    return args[field];
  });
  const legacy = args["legacy-hosts"]?.split(",") ?? [];
  if (legacy.length > 20 || legacy.some((host) => !validHost(host)))
    throw new Error(
      "--legacy-hosts must contain at most 20 explicit, lowercase DNS names",
    );
  if (new Set([...hosts, ...legacy]).size !== hosts.length + legacy.length)
    throw new Error("App, RTC, TURN and legacy DNS names must all be distinct");
  const port = args["legacy-tls-port"] ?? "8443";
  if (!/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535)
    throw new Error("--legacy-tls-port must be an unprivileged TCP port");
  if (
    [1080, 5432, 6379, 7880, 7881, 8080, 5349, ...Object.values(ports)].includes(
      Number(port),
    )
  )
    throw new Error("--legacy-tls-port conflicts with a streaming service");
  if (args["legacy-tls-port"] && !legacy.length)
    throw new Error("--legacy-tls-port requires --legacy-hosts");
  return { hosts, legacy, port: Number(port) };
}

export function createEdge(args) {
  const { hosts, legacy, port } = validateEdgeHosts(args);
  const ports = servicePorts(args);
  const route = (host, target, http = false) => ({
    match: [{ tls: { sni: [host] } }],
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
  const routes = [
    route(args.turn, 5349),
    route(args.app, ports["gateway-port"], true),
    route(args.rtc, ports["gateway-port"], true),
  ];
  if (legacy.length) {
    // Preserve the existing server's TLS, authentication and HTTP routing end to end.
    // No TLS termination or PROXY header is inserted into this byte stream.
    routes.push({
      match: [{ tls: { sni: legacy } }],
      handle: [
        { handler: "proxy", upstreams: [{ dial: [`127.0.0.1:${port}`] }] },
      ],
    });
  }
  return {
    admin: { disabled: true },
    logging: { logs: { default: { level: "WARN" } } },
    storage: { module: "file_system", root: "/data" },
    apps: {
      tls: {
        certificates: { automate: hosts },
        // On a shared VPS the existing Caddy continues owning port 80.
        ...(legacy.length
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
