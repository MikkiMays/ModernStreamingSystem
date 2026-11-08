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
    { "gateway-port": "8080" },
    { "hooks-port": "8091" },
    { "gateway-port": "80" },
    { "hooks-port": "18090;sh" },
    { "legacy-hosts": "jarvis.example.test", "legacy-tls-port": "18091", "gateway-port": "18091" },
  ])
    assert.throws(
      () => createEdge({ ...hosts, ...options }),
      JSON.stringify(options),
    );
  assert.throws(() => createEdge({ ...hosts, app: "-meet.example.test" }));
});

test("admin console name (R207, R211) gets a certificate, its own gateway port and a client-certificate check, strict mode only", () => {
  const config = createEdge({ ...hosts, admin: "admin.example.test" });
  assert.deepEqual(config.apps.tls.certificates.automate, [...Object.values(hosts), "admin.example.test"]);
  const routes = config.apps.layer4.servers.main.routes;
  assert.equal(routes.length, 4);
  assert.deepEqual(routes.at(-1).match, [{ tls: { sni: ["admin.example.test"] } }]);
  // Свой порт шлюза (R211): на порту приложения блока пульта нет, подставленный `Host` до него не дотянется.
  assert.deepEqual(routes.at(-1).handle.at(-1).upstreams, [{ dial: ["127.0.0.1:8092"] }]);
  // TLS к имени пульта — только с клиентским сертификатом нашего центра; у остальных имён проверки нет.
  assert.deepEqual(routes.at(-1).handle[0].connection_policies[0].client_authentication, {
    trusted_ca_certs_pem_files: ["/etc/tls/admin-ca.crt"],
    mode: "require_and_verify",
  });
  for (const other of routes.slice(0, -1))
    assert.equal(other.handle[0].connection_policies?.[0]?.client_authentication, undefined);
  assert.equal(createEdge(hosts).apps.layer4.servers.main.routes.length, 3);
  for (const options of [
    { admin: hosts.app },
    { admin: "Admin.example.test" },
    { admin: "admin.example.test", "legacy-hosts": "admin.example.test" },
  ])
    assert.throws(() => createEdge({ ...hosts, ...options }), JSON.stringify(options));
  assert.throws(() => createEdge({ domain: "meet.example.test", ip: "192.0.2.1", admin: "admin.example.test" }), /strict/);
});
