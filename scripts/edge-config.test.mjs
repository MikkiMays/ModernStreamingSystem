import { test } from "node:test";
import assert from "node:assert/strict";
import { createEdge } from "./edge-config.mjs";

const hosts = {
  app: "meet.example.test",
  rtc: "rtc.example.test",
  turn: "turn.example.test",
};

test("cohost preserves legacy TLS/auth and leaves HTTP challenge port to existing Caddy", () => {
  const config = createEdge({
    ...hosts,
    "legacy-hosts": "jarvis.example.test,media.example.test",
  });
  const tls = config.apps.tls;
  assert.deepEqual(tls.certificates.automate, Object.values(hosts));
  assert.equal(
    tls.automation.policies[0].issuers[0].challenges.http.disabled,
    true,
  );
  const routes = config.apps.layer4.servers.main.routes;
  assert.equal(routes.length, 4);
  assert.deepEqual(routes.at(-1), {
    match: [{ tls: { sni: ["jarvis.example.test", "media.example.test"] } }],
    handle: [{ handler: "proxy", upstreams: [{ dial: ["127.0.0.1:8443"] }] }],
  });
  assert(routes.every((route) => route.match[0].tls.sni.length));
});

test("cohost rejects ambiguous SNI, unsafe hosts and internal service port collisions", () => {
  for (const options of [
    { "legacy-hosts": hosts.app },
    { "legacy-hosts": "*.example.test" },
    { "legacy-hosts": "a..example.test" },
    { "legacy-hosts": "jarvis.example.test,jarvis.example.test" },
    { "legacy-hosts": "https://jarvis.example.test" },
    { "legacy-hosts": "jarvis.example.test", "legacy-tls-port": "8091" },
    { "legacy-hosts": "jarvis.example.test", "legacy-tls-port": "8443;sh" },
    { "legacy-tls-port": "8443" },
  ])
    assert.throws(
      () => createEdge({ ...hosts, ...options }),
      JSON.stringify(options),
    );
  assert.throws(() => createEdge({ ...hosts, app: "-meet.example.test" }));
});
