import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
    // «Только TCP» после обрыва — навсегда до перезахода; без него ICE restart возвращает UDP.
    assert.equal(sfu.rtc.allow_tcp_fallback, false);
    assert.deepEqual(sfu.audio, { active_red_encoding: true, update_interval: 200, smooth_intervals: 2 });
    // Тридцать людей ядра (R228) и четыре места ботам и переходным сессиям (T06).
    assert.equal(sfu.room.max_participants, 34);
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

test('TURN/TLS только в strict: в simple и ip SFU его не объявляет и сертификата не держит', async () => {
  // LiveKit 1.13 объявляет `turns:<domain>:443` при любом включённом TLS (живой join стенда, 01.11.2026):
  // с одним именем 443 — это HTTPS, и браузер получил бы мёртвый кандидат.
  const script = fileURLToPath(new URL('./configure.mjs', import.meta.url));
  for (const args of [['--domain=meet.example.test', '--ip=192.0.2.1'], ['--mode=ip', '--ip=192.0.2.1']]) {
    const directory = await mkdtemp(join(tmpdir(), 'streaming-config-'));
    try {
      const run = spawnSync(process.execPath, [script, ...args], { cwd: directory, encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      const sfu = JSON.parse(await readFile(join(directory, 'infra/generated/livekit.json'), 'utf8'));
      assert.equal(sfu.turn.enabled, true, args.join(' '));
      assert.equal(sfu.turn.udp_port, 3478);
      for (const key of ['tls_port', 'external_tls', 'cert_file', 'key_file'])
        assert.equal(key in sfu.turn, false, `${args.join(' ')}: ${key}`);
      assert.doesNotMatch(run.stdout, /5349/);
      assert.match(run.stdout, /TCP 7881/);
    } finally {
      await rm(directory, { recursive: true });
    }
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
    // Срочное — маршрутом по умолчанию; предупреждения и справочные напоминают реже.
    assert.equal(alerts.route.repeat_interval, '6h');
    assert.deepEqual(
      alerts.route.routes.map((r) => [r.matchers[0], r.receiver, r.repeat_interval]),
      [
        ['alertname="Watchdog"', 'watchdog', '1m'],
        ['severity="warn"', 'owner', '24h'],
        ['severity="info"', 'owner', '72h'],
      ],
    );

    // Отдельный бот оповещений: токен и чат — в `.local/alerts.env`; он главнее бота Cord.
    await mkdir(join(directory, '.local'), { recursive: true });
    await writeFile(join(directory, '.local/telegram.env'), 'CORD_MEET_TELEGRAM_BOT_TOKEN=1:meet\n');
    await writeFile(
      join(directory, '.local/alerts.env'),
      '# бот оповещений\nALERT_TELEGRAM_BOT_TOKEN=2:alerts\nALERT_TELEGRAM_CHAT_ID=-100123\n',
    );
    assert.equal(run('--refresh').status, 0);
    const wired = JSON.parse(await readFile(join(directory, 'infra/generated/alertmanager.yml'), 'utf8'));
    assert.deepEqual(wired.receivers[0].telegram_configs, [
      { bot_token: '2:alerts', chat_id: -100123, send_resolved: true },
    ]);
    await rm(join(directory, '.local/alerts.env'));
    await rm(join(directory, '.local/telegram.env'));
    assert.equal(run('--refresh').status, 0);

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

test('перевыпуск с новыми именами переписывает адресные ключи .env, не трогая секреты и правки владельца (R200 §8.6)', async () => {
  // Смена имени продукта (08.11.2026): после `--refresh --app=cord.online …` в `.env` оставались прежние
  // PUBLIC_URL и LIVEKIT_URL — ядро и служба интеграций отказывали по Origin, правилось руками.
  const directory = await mkdtemp(join(tmpdir(), 'streaming-config-'));
  try {
    const script = fileURLToPath(new URL('./configure.mjs', import.meta.url));
    const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: directory, encoding: 'utf8' });
    assert.equal(run('--app=meet.example.test', '--rtc=rtc.example.test', '--turn=turn.example.test', '--ip=192.0.2.1').status, 0);
    const before = await readFile(join(directory, '.env'), 'utf8');
    const secrets = Object.fromEntries(
      before.split('\n').filter((l) => /^(LIVEKIT_API_SECRET|SESSION_SECRET|INTERNAL_SECRET|DATABASE_PASSWORD|REDIS_PASSWORD)=/.test(l)).map((l) => l.split('=')),
    );
    // Владелец правил .env руками: эти строки должны пережить перевыпуск байт в байт.
    const edited = before.replace(/^ACCESS_PASSWORD=$/m, 'ACCESS_PASSWORD=secret word').replace(/^ADMIN_PASSWORD=$/m, 'ADMIN_PASSWORD=owner') + 'STREAM_MAX_PARTICIPANTS=12\n';
    await writeFile(join(directory, '.env'), edited);

    // Тот же адрес — .env не меняется вовсе.
    assert.equal(run('--refresh').status, 0);
    assert.equal(await readFile(join(directory, '.env'), 'utf8'), edited);

    const moved = run('--refresh', '--app=cord.example.test', '--rtc=rtc-fra.example.test', '--turn=turn-fra.example.test', '--ip=192.0.2.1');
    assert.equal(moved.status, 0, moved.stderr);
    assert.match(moved.stdout, /\.env retargeted/);
    assert.match(moved.stdout, /docker compose up -d edge gateway core services livekit/);
    const after = await readFile(join(directory, '.env'), 'utf8');
    for (const [key, value] of Object.entries({
      DEPLOY_MODE: 'strict',
      APP_HOST: 'cord.example.test',
      RTC_HOST: 'rtc-fra.example.test',
      TURN_HOST: 'turn-fra.example.test',
      PUBLIC_URL: 'https://cord.example.test',
      LIVEKIT_URL: 'wss://cord.example.test',
      SERVER_NAME: 'cord.example.test',
      ACCESS_PASSWORD: 'secret word',
      ADMIN_PASSWORD: 'owner',
      STREAM_MAX_PARTICIPANTS: '12',
      ...secrets,
    }))
      assert.match(after, new RegExp(`^${key}=${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'), key);
    assert.equal(after.split('\n').length, edited.split('\n').length, 'строки не дописываются и не теряются');
    assert.doesNotMatch(after, /meet\.example\.test/);
    const sfu = JSON.parse(await readFile(join(directory, 'infra/generated/livekit.json'), 'utf8'));
    assert.equal(sfu.turn.domain, 'turn-fra.example.test');

    // Свое имя сервера владелец задал сам — оно остаётся при любом переезде.
    await writeFile(join(directory, '.env'), after.replace(/^SERVER_NAME=.*$/m, 'SERVER_NAME=Cord'));
    const renamed = run('--refresh', '--app=third.example.test', '--rtc=rtc-third.example.test', '--turn=turn-third.example.test', '--ip=192.0.2.1');
    assert.equal(renamed.status, 0, renamed.stderr);
    const third = await readFile(join(directory, '.env'), 'utf8');
    assert.match(third, /^SERVER_NAME=Cord$/m);
    assert.match(third, /^LIVEKIT_URL=wss:\/\/third\.example\.test$/m);

    // .env, выправленный руками не до конца (как на meet), чинится и обычным `--refresh` по topology.json.
    await writeFile(join(directory, '.env'), third.replace(/^LIVEKIT_URL=.*$/m, 'LIVEKIT_URL=wss://meet.example.test'));
    assert.equal(run('--refresh').status, 0);
    assert.match(await readFile(join(directory, '.env'), 'utf8'), /^LIVEKIT_URL=wss:\/\/third\.example\.test$/m);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test('server configured before topology.json refreshes once its addresses are named explicitly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'streaming-config-'));
  try {
    const script = fileURLToPath(new URL('./configure.mjs', import.meta.url));
    const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: directory, encoding: 'utf8' });
    assert.equal(run('--domain=app.example.test', '--ip=192.0.2.1').status, 0);
    const env = await readFile(join(directory, '.env'), 'utf8');
    // Такой сервер ставился до появления файла: аргументов установки нигде нет.
    await rm(join(directory, 'infra/generated/topology.json'));

    // По одному `.env` нельзя: соседние сайты на 443 он не хранит.
    const blind = run('--refresh');
    assert.notEqual(blind.status, 0);
    assert.match(blind.stderr, /topology\.json is missing/);

    // Ровно то, что советует сообщение об ошибке, должно сработать.
    const named = run('--refresh', '--domain=app.example.test', '--ip=192.0.2.1');
    assert.equal(named.status, 0, named.stderr);
    assert.equal(await readFile(join(directory, '.env'), 'utf8'), env);
    const stored = JSON.parse(await readFile(join(directory, 'infra/generated/topology.json'), 'utf8'));
    assert.deepEqual(stored, { domain: 'app.example.test', ip: '192.0.2.1' });
    // Дальше файл есть, и перевыпуск идёт без подсказок.
    assert.equal(run('--refresh').status, 0);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test('имя пульта (R207): --admin пишет ADMIN_HOST и маршрут edge, --refresh --admin дописывает его в .env', async () => {
  const root = resolve(tmpdir());
  const directory = await mkdtemp(join(root, 'streaming-config-'));
  try {
    const script = fileURLToPath(new URL('./configure.mjs', import.meta.url));
    const base = [script, '--app=app.example.test', '--rtc=rtc.example.test', '--turn=turn.example.test', '--ip=192.0.2.1'];
    const run = (...extra) => spawnSync(process.execPath, [...base, ...extra], { cwd: directory, encoding: 'utf8' });
    const plain = run();
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(await readFile(join(directory, '.env'), 'utf8'), /^ADMIN_HOST=$/m);
    assert.equal(JSON.parse(await readFile(join(directory, 'infra/generated/edge.json'), 'utf8')).apps.layer4.servers.main.routes.length, 3);
    const named = run('--refresh', '--admin=admin.example.test');
    assert.equal(named.status, 0, named.stderr);
    const env = await readFile(join(directory, '.env'), 'utf8');
    assert.match(env, /^ADMIN_HOST=admin.example.test$/m);
    assert.equal(env.match(/^ADMIN_HOST=/gm).length, 1);
    const edge = JSON.parse(await readFile(join(directory, 'infra/generated/edge.json'), 'utf8'));
    // Пульт — два маршрута: проверка Let's Encrypt (acme-tls/1, без прокси) и сам пульт по сертификату.
    assert.equal(edge.apps.layer4.servers.main.routes.length, 5);
    assert.deepEqual(edge.apps.tls.certificates.automate.at(-1), 'admin.example.test');
    const stored = JSON.parse(await readFile(join(directory, 'infra/generated/topology.json'), 'utf8'));
    assert.equal(stored.admin, 'admin.example.test');
    // Следующий перевыпуск без --admin помнит имя из topology.json.
    const again = run('--refresh');
    assert.equal(again.status, 0, again.stderr);
    assert.equal(JSON.parse(await readFile(join(directory, 'infra/generated/edge.json'), 'utf8')).apps.layer4.servers.main.routes.length, 5);
  } finally {
    const child = relative(root, resolve(directory));
    assert(child.startsWith('streaming-config-') && !child.includes(sep) && !child.includes('..'));
    await rm(directory, { recursive: true });
  }
});

test('перевыпуск не возвращает в .env, правленный руками, прежние имена из topology.json; --check говорит это заранее (ревью R200 §8.6)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'streaming-config-'));
  try {
    const script = fileURLToPath(new URL('./configure.mjs', import.meta.url));
    const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: directory, encoding: 'utf8' });
    assert.equal(run('--domain=meet.example.test', '--ip=192.0.2.1', '--legacy-hosts=site.example.test').status, 0);
    const names = ['.env', 'infra/generated/edge.json', 'infra/generated/livekit.json', 'infra/generated/topology.json'];
    const files = async () =>
      Object.fromEntries(await Promise.all(names.map(async (f) => [f, await readFile(join(directory, f), 'utf8')])));

    // Адреса совпадают — проверка спокойна и ничего не пишет.
    const before = await files();
    const calm = run('--refresh', '--check');
    assert.equal(calm.status, 0, calm.stderr);
    assert.match(calm.stdout, /\.env не меняет/);
    assert.deepEqual(await files(), before);

    // Сервер перенесли на новые имена, поправив только .env (смена имени продукта, 08.11.2026).
    const edited = before['.env']
      .replace(/^DEPLOY_MODE=.*$/m, 'DEPLOY_MODE=strict')
      .replace(/^APP_HOST=.*$/m, 'APP_HOST=cord.example.test')
      .replace(/^RTC_HOST=.*$/m, 'RTC_HOST=rtc-fra.example.test')
      .replace(/^TURN_HOST=.*$/m, 'TURN_HOST=turn-fra.example.test')
      .replace(/^PUBLIC_URL=.*$/m, 'PUBLIC_URL=https://cord.example.test')
      .replace(/^LIVEKIT_URL=.*$/m, 'LIVEKIT_URL=wss://rtc-fra.example.test');
    await writeFile(join(directory, '.env'), edited);
    const stale = await files();

    const warned = run('--refresh', '--check');
    assert.equal(warned.status, 3, warned.stderr);
    assert.match(warned.stdout, /ВНИМАНИЕ: infra\/generated\/topology\.json называет не те адреса, что \.env/);
    assert.match(warned.stdout, /APP_HOST: cord\.example\.test → meet\.example\.test/);
    assert.match(warned.stdout, /ничего не записано/);
    const align = /node scripts\/configure\.mjs (--refresh .*)$/m.exec(warned.stdout)[1].split(' ');
    assert.deepEqual(align, [
      '--refresh', '--mode=strict', '--app=cord.example.test', '--rtc=rtc-fra.example.test',
      '--turn=turn-fra.example.test', '--ip=192.0.2.1',
    ]);
    assert.deepEqual(await files(), stale);

    // Обычный перевыпуск (так его зовёт ./update.sh) отказывает и ничего не трогает.
    const refused = run('--refresh');
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /называет не те адреса/);
    assert.deepEqual(await files(), stale);

    // Команда из подсказки выравнивает topology.json по .env: имена в .env те же, соседний сайт на месте.
    const aligned = run(...align);
    assert.equal(aligned.status, 0, aligned.stderr);
    const after = await readFile(join(directory, '.env'), 'utf8');
    for (const line of [
      'DEPLOY_MODE=strict', 'APP_HOST=cord.example.test', 'RTC_HOST=rtc-fra.example.test',
      'TURN_HOST=turn-fra.example.test', 'PUBLIC_URL=https://cord.example.test',
    ])
      assert.match(after, new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'), line);
    const stored = JSON.parse(await readFile(join(directory, 'infra/generated/topology.json'), 'utf8'));
    assert.equal(stored.app, 'cord.example.test');
    assert.equal(stored['legacy-hosts'], 'site.example.test');
    const sfu = JSON.parse(await readFile(join(directory, 'infra/generated/livekit.json'), 'utf8'));
    assert.equal(sfu.turn.domain, 'turn-fra.example.test');
    // Дальше перевыпуск снова обычный.
    const again = run('--refresh', '--check');
    assert.equal(again.status, 0, again.stdout);
    assert.equal(run('--refresh').status, 0);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test('--check бывает только у перевыпуска', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'streaming-config-'));
  try {
    const script = fileURLToPath(new URL('./configure.mjs', import.meta.url));
    const fresh = spawnSync(process.execPath, [script, '--check', '--domain=app.example.test', '--ip=192.0.2.1'], {
      cwd: directory,
      encoding: 'utf8',
    });
    assert.notEqual(fresh.status, 0);
    assert.match(fresh.stderr, /--check works only with --refresh/);
    await assert.rejects(readFile(join(directory, '.env'), 'utf8'));
  } finally {
    await rm(directory, { recursive: true });
  }
});

test('ключ своих проверок аналитики (R239): создаётся при установке, дописывается перевыпуском один раз и не вращается', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'streaming-config-'));
  try {
    const script = fileURLToPath(new URL('./configure.mjs', import.meta.url));
    const base = ['--app=app.example.test', '--rtc=rtc.example.test', '--turn=turn.example.test', '--ip=192.0.2.1'];
    const run = (...extra) =>
      spawnSync(process.execPath, [script, ...base, ...extra], { cwd: directory, encoding: 'utf8' });
    const envFile = join(directory, '.env');
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const installed = await readFile(envFile, 'utf8');
    // 32 случайных байта в base64url; остальное служба `insight` выводит из секретов, которые уже есть.
    const probe = /^ANALYTICS_PROBE_KEY=([A-Za-z0-9_-]{43})$/m;
    assert.match(installed, probe);
    for (const key of ['INSIGHT_KEY', 'INSIGHT_SECRET', 'ANALYTICS_SECRET'])
      assert.doesNotMatch(installed, new RegExp(`^${key}=`, 'm'), key);

    // Перевыпуск ключ не вращает и `.env` не трогает.
    const again = run('--refresh');
    assert.equal(again.status, 0, again.stderr);
    assert.equal(await readFile(envFile, 'utf8'), installed);

    // Сервер, поставленный до R239: ключа нет — перевыпуск дописывает его в конец, остальные строки байт в байт.
    const before = installed.replace(/^ANALYTICS_PROBE_KEY=.*\n/m, '');
    assert.doesNotMatch(before, probe);
    await writeFile(envFile, before);
    const upgraded = run('--refresh');
    assert.equal(upgraded.status, 0, upgraded.stderr);
    const after = await readFile(envFile, 'utf8');
    assert.equal(after.slice(0, before.length), before);
    assert.match(after.slice(before.length), /^ANALYTICS_PROBE_KEY=[A-Za-z0-9_-]{43}\n$/);
    assert.notEqual(probe.exec(after)[1], probe.exec(installed)[1]);
    // И больше не меняет.
    assert.equal(run('--refresh').status, 0);
    assert.equal(await readFile(envFile, 'utf8'), after);

    // `--check` ничего не пишет — и ключа тоже.
    await writeFile(envFile, before);
    const checked = run('--refresh', '--check');
    assert.equal(checked.status, 0, checked.stderr);
    assert.equal(await readFile(envFile, 'utf8'), before);
  } finally {
    await rm(directory, { recursive: true });
  }
});
