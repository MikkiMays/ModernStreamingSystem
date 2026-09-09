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
    const timeout = setTimeout(() => req.destroy(new Error("Probe timed out")), 3000);
    req.on("close", () => clearTimeout(timeout));
    req.on("error", reject);
    req.end();
  });
}

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
const capabilities = await get("/api/v1/capabilities", env.APP_HOST);
assert.equal(capabilities.status, 200);
assert.equal(JSON.parse(capabilities.body).maxParticipants, 10);
const home = await get("/", env.APP_HOST);
assert.equal(home.status, 200);
assert.match(home.body, /<title>Cord/);
const signaling = await get("/rtc?access_token=invalid", env.RTC_HOST);
assert([401, 403].includes(signaling.status), "Unauthenticated SFU access must be denied");
const upload = await get("/uploads/11111111-1111-1111-1111-111111111111", env.APP_HOST, true,
  { Authorization: "Bearer invalid" });
assert([401, 403].includes(upload.status), "Direct tus downloads must be denied");
console.log("PASS: database/Redis health, production web/API through PROXY protocol, signaling access and direct-download gates");
