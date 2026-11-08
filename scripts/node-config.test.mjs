import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./node-config.mjs', import.meta.url));
const ENV = `DEPLOY_MODE=strict
APP_HOST=app.example.test
RTC_HOST=rtc.example.test
TURN_HOST=turn.example.test
PUBLIC_IP=192.0.2.1
PUBLIC_URL=https://app.example.test
LIVEKIT_URL=wss://app.example.test
LIVEKIT_INTERNAL_URL=http://127.0.0.1:7880
LIVEKIT_API_KEY=APIkey000000000000
LIVEKIT_API_SECRET=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
INTERNAL_SECRET=fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210
LIVEKIT_METRICS_PASSWORD=metricspw
COMPOSE_PROFILES=monitoring
`;

test('a media node gets its own files, the registry, the control backbone and no secret in the output', async () => {
  const directory = await mkdtemp(join(resolve(tmpdir()), 'cord-node-'));
  try {
    await writeFile(join(directory, '.env'), ENV, { mode: 0o600 });
    const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: directory, encoding: 'utf8' });
    const first = run('--node=hel', '--ip=203.0.113.7', '--app=hel.example.test', '--rtc=rtc-hel.example.test', '--turn=turn-hel.example.test', '--title-ru=Хельсинки', '--title-en=Helsinki', '--country=fi', '--max-rooms=3', '--uplink-mbps=500', '--cores=2', '--ssh=root@203.0.113.7', '--ssh-key=/root/.ssh/k');
    assert.equal(first.status, 0, first.stderr);
    assert.ok(!first.stdout.includes('0123456789abcdef'), 'secret leaked to stdout');

    const registry = JSON.parse(await readFile(join(directory, 'infra/generated/nodes/registry.json'), 'utf8'));
    assert.equal(registry.format, 'cord.nodes/1');
    const [control, hel] = registry.nodes;
    assert.equal(control.id, 'fra');
    assert.equal(control.control, true);
    assert.equal(control.rtcUrl, 'wss://app.example.test');
    assert.equal(control.stun, 'stun:turn.example.test:3478');
    // Ёмкость и флаг (R200): узел управления — из .env и машины, медиаузел — из флагов.
    assert.equal(control.country, 'DE');
    assert.equal(control.uplinkMbps, 1000);
    assert.ok(control.cores >= 1);
    assert.equal(control.loadUrl, 'http://127.0.0.1:9100/metrics');
    assert.equal(hel.country, 'FI');
    assert.equal(hel.uplinkMbps, 500);
    assert.equal(hel.cores, 2);
    assert.equal(hel.loadUrl, 'http://127.0.0.1:21002/metrics');
    assert.deepEqual(hel.title, { ru: 'Хельсинки', en: 'Helsinki' });
    assert.equal(hel.index, 1);
    assert.equal(hel.rtcUrl, 'wss://rtc-hel.example.test');
    assert.equal(hel.probeUrl, 'https://hel.example.test');
    assert.equal(hel.stun, 'stun:turn-hel.example.test:3478');
    assert.equal(hel.internalUrl, 'http://127.0.0.1:21000');
    assert.equal(hel.maxRooms, 3);
    assert.equal(hel.enabled, true);
    assert.equal(hel.ssh, 'root@203.0.113.7');

    const dir = join(directory, 'infra/generated/nodes/hel');
    const env = Object.fromEntries((await readFile(join(dir, 'node.env'), 'utf8')).trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
    assert.equal(env.NODE_ID, 'hel');
    assert.equal(env.CONTROL_IP, '192.0.2.1');
    assert.equal(env.APP_HOST, 'hel.example.test');
    assert.equal(env.PUBLIC_URL, 'https://app.example.test');
    assert.equal(env.CORE_AUTH_UPSTREAM, '127.0.0.1:18080');
    assert.equal(env.LIVEKIT_API_SECRET, '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
    assert.equal((await stat(join(dir, 'node.env'))).mode & 0o777, 0o600);

    const livekit = JSON.parse(await readFile(join(dir, 'livekit.json'), 'utf8'));
    assert.equal(livekit.rtc.node_ip, '203.0.113.7');
    assert.equal(livekit.redis, undefined, 'a media node has no Redis');
    assert.equal(livekit.turn.domain, 'turn-hel.example.test');
    assert.equal(livekit.turn.external_tls, true);
    assert.deepEqual(livekit.webhook.urls, ['http://127.0.0.1:18090/internal/livekit']);
    assert.equal(livekit.prometheus.password, 'metricspw');
    assert.ok(livekit.turn.deny_peer_cidrs || livekit.turn.allow_peer_cidrs, 'relay guard present');

    const edge = JSON.parse(await readFile(join(dir, 'edge.json'), 'utf8'));
    assert.deepEqual(edge.apps.tls.certificates.automate.sort(), ['hel.example.test', 'rtc-hel.example.test', 'turn-hel.example.test']);
    const backbone = JSON.parse(await readFile(join(dir, 'backbone.json'), 'utf8'));
    assert.equal(backbone.apps.layer4.servers['core-fra'].routes[0].handle[0].upstreams[0].dial[0], '192.0.2.1:7443');

    for (const file of ['ca.crt', 'node.crt', 'node.key']) await stat(join(dir, 'pki', file));
    assert.equal((await stat(join(dir, 'pki/node.key'))).mode & 0o777, 0o600);
    const san = spawnSync('openssl', ['x509', '-in', join(dir, 'pki/node.crt'), '-noout', '-ext', 'subjectAltName,extendedKeyUsage'], { encoding: 'utf8' }).stdout;
    assert.match(san, /DNS:hel\.cord, DNS:\*\.hel\.cord/);
    assert.match(san, /TLS Web Server Authentication, TLS Web Client Authentication/);
    const verify = spawnSync('openssl', ['verify', '-CAfile', join(dir, 'pki/ca.crt'), join(dir, 'pki/node.crt')], { encoding: 'utf8' });
    assert.equal(verify.status, 0, verify.stderr);

    const controlBackbone = JSON.parse(await readFile(join(directory, 'infra/generated/backbone.json'), 'utf8'));
    assert.equal(controlBackbone.apps.layer4.servers['livekit-hel'].listen[0], '127.0.0.1:21000');
    const targets = JSON.parse(await readFile(join(directory, 'infra/generated/scrape-nodes/hel.json'), 'utf8'));
    assert.deepEqual(targets.find((t) => t.labels.role === 'livekit'), { targets: ['127.0.0.1:21001'], labels: { node: 'hel', role: 'livekit' } });
    await stat(join(directory, 'infra/generated/backbone-pki/node.key'));
    await stat(join(directory, '.local/backbone/ca.key'));
    assert.ok(!(await readFile(join(directory, '.env'), 'utf8')).includes('CSP_NODES'), '.env untouched without --write-env');

    // Второй узел получает следующий номер и свои порты; первый не трогается.
    const second = run('--node=msk', '--ip=198.51.100.9', '--mode=ip');
    assert.equal(second.status, 0, second.stderr);
    const again = JSON.parse(await readFile(join(directory, 'infra/generated/nodes/registry.json'), 'utf8'));
    assert.equal(again.nodes.length, 3);
    const msk = again.nodes.find((n) => n.id === 'msk');
    assert.equal(msk.index, 2);
    assert.equal(msk.rtcUrl, 'wss://198.51.100.9');
    assert.equal(msk.stun, 'stun:198.51.100.9:3478');
    assert.equal(msk.country, undefined, 'no country until the operator names one');
    assert.equal(msk.uplinkMbps, 1000, 'default uplink');
    assert.equal(msk.loadUrl, 'http://127.0.0.1:22002/metrics');
    assert.equal(again.nodes.find((n) => n.id === 'hel').internalUrl, 'http://127.0.0.1:21000');
    await stat(join(directory, 'infra/generated/nodes/msk/tls/turn.crt'));
    const mskLivekit = JSON.parse(await readFile(join(directory, 'infra/generated/nodes/msk/livekit.json'), 'utf8'));
    assert.equal(mskLivekit.turn.tls_port, undefined, 'ip mode has no TURN/TLS');

    // Дренаж — флаг в реестре, остальное воспроизводится как было.
    const drain = run('--node=hel', '--refresh', '--enabled=false');
    assert.equal(drain.status, 0, drain.stderr);
    const drained = JSON.parse(await readFile(join(directory, 'infra/generated/nodes/registry.json'), 'utf8'));
    assert.equal(drained.nodes.find((n) => n.id === 'hel').enabled, false);
    assert.equal(drained.nodes.find((n) => n.id === 'hel').rtcUrl, 'wss://rtc-hel.example.test');
    assert.equal(drained.nodes.find((n) => n.id === 'hel').country, 'FI', 'refresh keeps the country');
    assert.equal(drained.nodes.find((n) => n.id === 'hel').uplinkMbps, 500);

    // Сертификат узла при перевыпуске без --renew не меняется.
    const before = await readFile(join(dir, 'pki/node.crt'), 'utf8');
    assert.equal(run('--node=hel', '--refresh').status, 0);
    assert.equal(await readFile(join(dir, 'pki/node.crt'), 'utf8'), before);

    // --write-env дописывает ровно три ключа и профиль.
    const written = run('--write-env');
    assert.equal(written.status, 0, written.stderr);
    const envText = await readFile(join(directory, '.env'), 'utf8');
    assert.match(envText, /^NODE_ID=fra$/m);
    assert.match(envText, /^CSP_NODES=https:\/\/hel\.example\.test wss:\/\/rtc-hel\.example\.test https:\/\/rtc-hel\.example\.test https:\/\/198\.51\.100\.9 wss:\/\/198\.51\.100\.9 https:\/\/198\.51\.100\.9$/m);
    assert.match(envText, /^COMPOSE_PROFILES=monitoring,nodes$/m);
    assert.match(envText, /^LIVEKIT_API_SECRET=0123456789abcdef/m);

    // Ошибки называются словами.
    assert.match(run('--node=Hel', '--ip=1.2.3.4', '--mode=ip').stderr, /Node id/);
    assert.match(run('--node=fra', '--ip=1.2.3.4', '--mode=ip').stderr, /control node/);
    assert.match(run('--node=new', '--ip=1.2.3.4').stderr, /--mode=ip/);
    assert.match(run('--node=hel', '--refresh', '--country=Finland').stderr, /ISO 3166/);
    assert.match(run('--node=hel', '--refresh', '--uplink-mbps=fast').stderr, /positive integer/);
    // Страна узла управления — флагом без --node.
    assert.equal(run('--country=nl').status, 0);
    assert.equal(JSON.parse(await readFile(join(directory, 'infra/generated/nodes/registry.json'), 'utf8')).nodes[0].country, 'NL');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
