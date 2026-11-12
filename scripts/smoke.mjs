// Read-only checks of the built production stack, including the PROXY-protocol gateway.
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";

const env = Object.fromEntries((await readFile(".env", "utf8"))
  .split("\n").filter(line => /^[A-Z_]+=/.test(line))
  .map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
const port = Number(env.GATEWAY_PORT || 8091);
function get(path, host, gateway = true, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: gateway ? port : 8080, path,
      headers: { Host: host, Connection: "close", ...headers }, agent: false,
      ...(gateway ? { createConnection: () => {
        const socket = connect(port, "127.0.0.1");
        socket.write(`PROXY TCP4 127.0.0.1 127.0.0.1 12345 ${port}\r\n`);
        return socket;
      }} : {}),
    }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; if (body.length > 65536) req.destroy(new Error("Oversize response")); });
      response.on("end", () => resolve({ status: response.statusCode, body }));
    });
    const timeout = setTimeout(() => req.destroy(new Error("Probe timed out")), PROBE_MS);
    req.on("close", () => clearTimeout(timeout));
    req.on("error", reject);
    req.end();
  });
}

// A loaded or CPU-capped host answers slower than 3 s; SMOKE_PROBE_MS widens the per-request budget.
const PROBE_MS = Number(process.env.SMOKE_PROBE_MS ?? 3000);

let healthy = false;
for (let attempt = 0; attempt < 40; attempt++) {
  try {
    const result = await get("/actuator/health", "localhost", false);
    healthy = result.status === 200 && JSON.parse(result.body).status === "UP";
  } catch { /* The JVM may still be starting. */ }
  if (healthy) break;
  await delay(1500);
}
assert(healthy, "Core, PostgreSQL and Redis must be healthy");
// A started container may not yet accept connections. Wait for the actual HTTP
// boundary, including the independently started integration worker.
async function ready(path) {
  let last;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      last = await get(path, env.APP_HOST);
      if (last.status === 200) return last;
    } catch (error) { last = error; }
    await delay(250);
  }
  assert.fail(`${path} did not become ready: ${last?.status ?? last?.message}`);
}
const capabilities = await ready("/api/v1/capabilities");
assert.equal(capabilities.status, 200);
assert.equal(JSON.parse(capabilities.body).maxParticipants, Number(env.STREAM_MAX_PARTICIPANTS) || 30);
const services = await ready("/api/v1/services/catalog");
assert(JSON.parse(services.body).services.some(service => service.id === "music"));
const home = await get("/", env.APP_HOST);
assert.equal(home.status, 200);
assert.match(home.body, /<title>Cord/);
const signaling = await get("/rtc?access_token=invalid", env.RTC_HOST);
assert([401, 403].includes(signaling.status), "Unauthenticated SFU access must be denied");
const upload = await get("/uploads/11111111-1111-1111-1111-111111111111", env.APP_HOST, true,
  { Authorization: "Bearer invalid" });
assert([401, 403].includes(upload.status), "Direct tus downloads must be denied");
// Analytics (R239): the gateway hands client events to the `insight` service, and nothing internal leaks out.
// The service is optional for meetings, so its absence fails only where the stack is expected to run it.
if (process.env.SMOKE_INSIGHT !== "0") {
  let proof;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      proof = await get("/api/v1/t/proof", env.APP_HOST);
      if ([200, 204].includes(proof.status)) break;
    } catch (error) { proof = error; }
    await delay(250);
  }
  assert([200, 204].includes(proof?.status), `Analytics route must answer through the gateway: ${proof?.status ?? proof?.message}`);
  // The gateway has no route to the service's internal API: such a path gets the app page (or 404), never the service.
  const internal = await get("/internal/facts", env.APP_HOST);
  assert(internal.status === 404 || /<!doctype html/i.test(internal.body),
    `Analytics facts endpoint must not be reachable through the gateway: ${internal.status}`);
}
console.log("PASS: database/Redis health, production web/API and integrations through PROXY protocol, signaling access and direct-download gates, analytics route");
