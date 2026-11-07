import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKBONE_PORT,
  NODE_LOCAL,
  NODE_SERVICES,
  controlBackbone,
  controlPorts,
  createBackbone,
  nodeBackbone,
  sni,
} from './backbone-config.mjs';

test('control ports are stable per node index and never collide', () => {
  assert.deepEqual(controlPorts(1), { livekit: 21000, metrics: 21001, node: 21002, gateway: 21003, probe: 21004 });
  assert.equal(controlPorts(2).livekit, 22000);
  assert.throws(() => controlPorts(0));
  assert.throws(() => controlPorts(41));
});

test('node ids are short lowercase labels', () => {
  assert.equal(sni('livekit', 'hel'), 'livekit.hel.cord');
  assert.throws(() => sni('livekit', 'Hel'));
  assert.throws(() => sni('livekit', 'a-very-long-node-name-x'));
  assert.throws(() => sni('livekit', '1abc'));
});

test('a media node serves the SFU and metrics behind client-certificate TLS and reaches the control plane', () => {
  const config = nodeBackbone({ id: 'hel', ip: '152.234.227.199' }, { id: 'fra', ip: '108.165.32.75' });
  const server = config.apps.layer4.servers.backbone;
  assert.deepEqual(server.listen, [`:${BACKBONE_PORT}`]);
  assert.equal(server.routes.length, Object.keys(NODE_SERVICES).length);
  for (const route of server.routes) {
    const [tls, proxy] = route.handle;
    assert.equal(tls.handler, 'tls');
    assert.equal(tls.connection_policies[0].client_authentication.mode, 'require_and_verify');
    assert.deepEqual(tls.connection_policies[0].client_authentication.ca, { provider: 'file', pem_files: ['/pki/ca.crt'] });
    assert.equal(proxy.handler, 'proxy');
    assert.match(proxy.upstreams[0].dial[0], /^127\.0\.0\.1:\d+$/);
    assert.match(route.match[0].tls.sni[0], /^[a-z]+\.hel\.cord$/);
  }
  const livekit = server.routes.find((r) => r.match[0].tls.sni[0] === 'livekit.hel.cord');
  assert.deepEqual(livekit.handle[1].upstreams[0].dial, ['127.0.0.1:7880']);
  // Клиентская сторона: ядро и крюки A на локальных портах, дозвон с нашим сертификатом и SNI службы.
  const core = config.apps.layer4.servers['core-fra'];
  assert.deepEqual(core.listen, [`127.0.0.1:${NODE_LOCAL.core}`]);
  const upstream = core.routes[0].handle[0].upstreams[0];
  assert.deepEqual(upstream.dial, [`108.165.32.75:${BACKBONE_PORT}`]);
  assert.equal(upstream.tls.server_name, 'core.fra.cord');
  assert.equal(upstream.tls.client_certificate_file, '/pki/node.crt');
  assert.deepEqual(upstream.tls.ca, { provider: 'file', pem_files: ['/pki/ca.crt'] });
  assert.equal(config.apps.layer4.servers['hooks-fra'].listen[0], `127.0.0.1:${NODE_LOCAL.hooks}`);
  assert.equal(config.admin.disabled, true);
  assert.deepEqual(config.apps.tls.certificates.load_files, [{ certificate: '/pki/node.crt', key: '/pki/node.key' }]);
});

test('the control node serves core and hooks and reaches every media node on its own ports', () => {
  const config = controlBackbone({ id: 'fra', ip: '108.165.32.75' }, [
    { id: 'hel', ip: '152.234.227.199', index: 1 },
    { id: 'msk', ip: '157.22.241.114', index: 2 },
  ]);
  const served = config.apps.layer4.servers.backbone.routes.map((r) => r.match[0].tls.sni[0]).sort();
  assert.deepEqual(served, ['core.fra.cord', 'hooks.fra.cord']);
  assert.equal(config.apps.layer4.servers['livekit-hel'].listen[0], '127.0.0.1:21000');
  assert.equal(config.apps.layer4.servers['livekit-msk'].listen[0], '127.0.0.1:22000');
  assert.equal(config.apps.layer4.servers['metrics-msk'].routes[0].handle[0].upstreams[0].tls.server_name, 'metrics.msk.cord');
  assert.deepEqual(config.apps.layer4.servers['probe-hel'].routes[0].handle[0].upstreams[0].dial, [`152.234.227.199:${BACKBONE_PORT}`]);
});

test('duplicate local ports are refused', () => {
  assert.throws(
    () =>
      createBackbone({
        self: { id: 'fra' },
        serves: {},
        reaches: [
          { node: 'hel', ip: '192.0.2.1', services: { livekit: 21000 } },
          { node: 'msk', ip: '192.0.2.2', services: { livekit: 21000 } },
        ],
      }),
    /used twice/,
  );
});
