// Read-only, bounded probes. A successful TLS handshake does not prove a TURN allocation.
import { Resolver } from "node:dns/promises";
import { connect } from "node:tls";
import { get } from "node:https";
import { isIP } from "node:net";
import { parseArgs } from "node:util";
import { validateEdgeHosts } from "./edge-config.mjs";

const { values } = parseArgs({
  options: {
    app: { type: "string" },
    rtc: { type: "string" },
    turn: { type: "string" },
    ip: { type: "string" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "node scripts/network-audit.mjs --app=meet.example.org --rtc=rtc.example.org --turn=turn.example.org [--ip=PUBLIC_IP]",
  );
  process.exit(0);
}
validateEdgeHosts(values);
if (values.ip && !isIP(values.ip))
  throw new Error("--ip must be an IP address");
const resolver = new Resolver({ timeout: 2000, tries: 1 });
const failure = (error) => ({ error: error.code ?? error.message });

function probeTls(host, address = host) {
  return new Promise((resolve) => {
    const started = performance.now();
    const socket = connect({
      host: address,
      port: 443,
      servername: host,
      rejectUnauthorized: true,
    });
    const deadline = setTimeout(
      () => socket.destroy(new Error("TLS_TIMEOUT")),
      8000,
    );
    socket.once("secureConnect", () => {
      clearTimeout(deadline);
      resolve({
        verified: true,
        elapsedMs: Math.round(performance.now() - started),
        protocol: socket.getProtocol(),
      });
      socket.destroy();
    });
    socket.once("error", (error) => {
      clearTimeout(deadline);
      resolve(failure(error));
    });
  });
}

function probeHttps(host, path, address) {
  return new Promise((resolve) => {
    const started = performance.now();
    const request = get(
      {
        hostname: address,
        servername: host,
        headers: { Host: host },
        port: 443,
        path,
        agent: false,
      },
      (response) => {
        clearTimeout(deadline);
        resolve({
          status: response.statusCode,
          headersMs: Math.round(performance.now() - started),
        });
        response.destroy();
      },
    );
    const deadline = setTimeout(
      () => request.destroy(new Error("HTTPS_TIMEOUT")),
      8000,
    );
    request.once("error", (error) => {
      clearTimeout(deadline);
      resolve(failure(error));
    });
  });
}

const hosts = await Promise.all(
  ["app", "rtc", "turn"].map(async (role) => {
    const host = values[role];
    const [ipv4, ipv6] = await Promise.all([
      resolver.resolve4(host).catch(failure),
      resolver.resolve6(host).catch(failure),
    ]);
    // Avoid uncancellable OS getaddrinfo work surviving a socket's timeout.
    const address =
      (Array.isArray(ipv4) ? ipv4[0] : undefined) ??
      (Array.isArray(ipv6) ? ipv6[0] : undefined);
    const [tls, originTls, https] = await Promise.all([
      address ? probeTls(host, address) : { error: "DNS_FAILED" },
      values.ip ? probeTls(host, values.ip) : null,
      role === "turn"
        ? null
        : address
          ? probeHttps(
              host,
              role === "app" ? "/api/v1/capabilities" : "/rtc",
              address,
            )
          : { error: "DNS_FAILED" },
    ]);
    return {
      role,
      host,
      ipv4,
      ipv6,
      dnsContainsExpectedIp: values.ip
        ? [
            ...(Array.isArray(ipv4) ? ipv4 : []),
            ...(Array.isArray(ipv6) ? ipv6 : []),
          ].includes(values.ip)
        : null,
      tls,
      originTls,
      https,
    };
  }),
);
console.log(
  JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      dnsServers: resolver.getServers(),
      hosts,
      limits: [
        "Measurements describe this client and its current network/VPN only.",
        "TLS/HTTPS timings include connection setup; they are not RTP RTT or end-to-end media latency.",
        "TURN requires an authenticated allocation and received media test; TLS success alone is insufficient.",
        "DNS-only hosts should resolve to the expected VPS. Check every AAAA record separately.",
        "Public TLS/HTTPS probes use the first resolved A address, or the first AAAA if there is no A.",
      ],
    },
    null,
    2,
  ),
);
