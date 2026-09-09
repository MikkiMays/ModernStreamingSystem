import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('configuration keeps media internal, shares external 443, and cannot overwrite secrets', async () => {
  const root = resolve(tmpdir());
  const directory = await mkdtemp(join(root, 'streaming-config-'));
  try {
    const script = fileURLToPath(new URL('./configure.mjs', import.meta.url));
    const args = [
      script,
      '--app=app.example.test',
      '--rtc=rtc.example.test',
      '--turn=turn.example.test',
      '--ip=192.0.2.1',
    ];
    const run = () => spawnSync(process.execPath, args, { cwd: directory, encoding: 'utf8' });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const env = await readFile(join(directory, '.env'), 'utf8');
    const edge = JSON.parse(await readFile(join(directory, 'infra/generated/edge.json'), 'utf8'));
    const sfu = JSON.parse(await readFile(join(directory, 'infra/generated/livekit.json'), 'utf8'));
    assert.equal(sfu.turn.external_tls, true);
    assert.equal(sfu.turn.tls_port, 5349);
    assert.equal(sfu.rtc.udp_port, 7882);
    assert.deepEqual(edge.apps.layer4.servers.main.listen, [':443']);
    assert.equal(edge.apps.layer4.servers.main.routes[1].handle[1].proxy_protocol, 'v2');
    assert.match(env, /SESSION_SECRET=[a-f0-9]{64}/);
    assert.notEqual(run().status, 0);
    assert.equal(await readFile(join(directory, '.env'), 'utf8'), env);
  } finally {
    const child = relative(root, resolve(directory));
    assert(child.startsWith('streaming-config-') && !child.includes(sep) && !child.includes('..'));
    await rm(directory, { recursive: true });
  }
});

test('cohost custom ports agree between edge, gateway environment and SFU callbacks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'streaming-config-'));
  try {
    const script = fileURLToPath(new URL('./configure.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script,
      '--app=meet.example.test', '--rtc=rtc.example.test', '--turn=turn.example.test',
      '--ip=192.0.2.1', '--legacy-hosts=old.example.test',
      '--gateway-port=18091', '--hooks-port=18090',
    ], { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const env = await readFile(join(directory, '.env'), 'utf8');
    const edge = JSON.parse(await readFile(join(directory, 'infra/generated/edge.json'), 'utf8'));
    const sfu = JSON.parse(await readFile(join(directory, 'infra/generated/livekit.json'), 'utf8'));
    assert.match(env, /^GATEWAY_PORT=18091$/m);
    assert.match(env, /^HOOKS_PORT=18090$/m);
    assert.deepEqual(sfu.webhook.urls, ['http://127.0.0.1:18090/internal/livekit']);
    for (const route of edge.apps.layer4.servers.main.routes.slice(1, 3))
      assert.deepEqual(route.handle[1].upstreams[0].dial, ['127.0.0.1:18091']);
  } finally {
    await rm(directory, { recursive: true });
  }
});
