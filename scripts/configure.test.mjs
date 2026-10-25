import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { permits } from './turn-guard.mjs';

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
    // Параметры SFU из разбора надёжности (W1b шаг 1, docs/research §2.8): буфер звука, явная пауза
    // видео при тесном канале, порог ICE/TCP, частота уровней звука для оверлея говорящих.
    assert.equal(sfu.rtc.packet_buffer_size_audio, 400);
    assert.deepEqual(sfu.rtc.congestion_control, { enabled: true, allow_pause: true });
    assert.equal(sfu.rtc.tcp_fallback_rtt_threshold, 150);
    assert.deepEqual(sfu.audio, { active_red_encoding: true, update_interval: 200, smooth_intervals: 2 });
    // Двадцать людей ядра и четыре места ботам и переходным сессиям (T06).
    assert.equal(sfu.room.max_participants, 24);
    // TURN — не открытый relay (A12): к SFU этой машины можно, в интернет и внутрь — нет.
    assert.equal(permits(sfu.turn, '192.0.2.1'), true);
    for (const peer of ['8.8.8.8', '192.0.2.2', '127.0.0.1', '10.0.0.1', '169.254.169.254', '100.64.0.1'])
      assert.equal(permits(sfu.turn, peer), false, peer);
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

test('monitoring adds its secrets once, guards SFU metrics with a password and never rotates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'streaming-config-'));
  try {
    const script = fileURLToPath(new URL('./configure.mjs', import.meta.url));
    const base = ['--app=app.example.test', '--rtc=rtc.example.test', '--turn=turn.example.test', '--ip=192.0.2.1'];
    const run = (...extra) =>
      spawnSync(process.execPath, [script, ...base, ...extra], { cwd: directory, encoding: 'utf8' });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const plain = await readFile(join(directory, '.env'), 'utf8');
    // Без профиля метрик SFU нет вовсе: их порт слушал бы 0.0.0.0.
    let sfu = JSON.parse(await readFile(join(directory, 'infra/generated/livekit.json'), 'utf8'));
    assert.equal(sfu.prometheus, undefined);
    assert.match(plain, /^ADMIN_PASSWORD=$/m);
    const alerts = JSON.parse(await readFile(join(directory, 'infra/generated/alertmanager.yml'), 'utf8'));
    assert.deepEqual(alerts.receivers.map((r) => r.name), ['owner', 'watchdog']);
    assert.equal(alerts.receivers[0].telegram_configs, undefined);

    const enabled = run('--refresh', '--monitoring');
    assert.equal(enabled.status, 0, enabled.stderr);
    const env = await readFile(join(directory, '.env'), 'utf8');
    assert.ok(env.startsWith(plain), 'existing lines stay as they were');
    const password = /^LIVEKIT_METRICS_PASSWORD=([a-f0-9]{64})$/m.exec(env)?.[1];
    assert.ok(password);
    assert.match(env, /^GRAFANA_PASSWORD=\S{20,}$/m);
    assert.match(env, /^COMPOSE_PROFILES=monitoring$/m);
    sfu = JSON.parse(await readFile(join(directory, 'infra/generated/livekit.json'), 'utf8'));
    assert.deepEqual(sfu.prometheus, { port: 6789, username: 'metrics', password });

    // Повтор ничего не вращает и не дописывает дважды.
    assert.equal(run('--refresh', '--monitoring').status, 0);
    assert.equal(await readFile(join(directory, '.env'), 'utf8'), env);
  } finally {
    await rm(directory, { recursive: true });
  }
});
