// Подставная служба `fleet` для снимков пульта (R220): правдоподобный флот из четырёх машин — стенд A, ядро
// продукта meet и два медиаузла — с идущими встречами, алертом, обращениями, задачами и журналом. Формы ответов —
// `web/src/admin/api.ts` (зеркало `services/fleet/fleet/app.py`). Пульт за клиентским сертификатом, поэтому снимки
// идут против dev-сервера или сборки, а `/api/fleet/*` отвечает отсюда.
//
//   import { routeFleet } from './admin-fixtures.mjs';
//   await routeFleet(page);            // до первого перехода на `/admin.html`

import { readFileSync } from 'node:fs';

const DAY = 86_400_000;

function insightSample(name) {
  try {
    return JSON.parse(
      readFileSync(new URL(`../../contracts/fixtures/insight/${name}.json`, import.meta.url), 'utf8'),
    );
  } catch {
    return null;
  }
}

/** Детерминированный «шум» для рядов: снимки до и после показывают одни и те же числа. */
function wave(i, base, spread, period = 7) {
  return Math.max(0, Math.round(base + spread * Math.sin((i / period) * Math.PI * 2) + ((i * 37) % 11) - 5));
}

export function fleetData(now = Date.now()) {
  const sec = Math.round(now / 1000);
  const me = {
    actor: 'owner',
    since: sec - 3_600,
    expiresAt: sec + 8 * 3_600,
    allowIps: false,
    executor: { mode: 'ssh', sshMachines: ['meet', 'b', 'msk'] },
    adminHost: 'admin.callcord.ru',
    agentOps: ['read', 'status'],
  };
  const machines = [
    {
      id: 'a',
      title: 'A',
      role: 'dev+admin',
      host: '108.165.32.75',
      installDir: '/opt/ModernStreamingSystem',
      ssh: false,
      nodeId: null,
      product: null,
      core: { url: 'http://127.0.0.1:8080', credential: 'password' },
    },
    {
      id: 'meet',
      title: 'meet',
      role: 'product-core',
      host: '108.165.32.23',
      installDir: '/opt/meet/ModernStreamingSystem',
      ssh: true,
      nodeId: 'fra',
      product: 'cord.online',
      core: { url: 'http://127.0.0.1:28080', credential: 'key' },
    },
    {
      id: 'b',
      title: 'B',
      role: 'media-node',
      host: '152.234.227.199',
      installDir: '/opt/ModernStreamingSystem',
      ssh: true,
      nodeId: 'hel',
      product: null,
      core: null,
    },
    {
      id: 'msk',
      title: 'msk',
      role: 'media-node',
      host: '157.22.241.114',
      installDir: '/opt/ModernStreamingSystem',
      ssh: true,
      nodeId: 'msk',
      product: null,
      core: null,
    },
  ];
  const rooms = [
    room('r1', '482 193 774', 7, 1, ['watch'], 52, 'main'),
    room('r2', '119 640 285', 3, 0, [], 18, 'hel'),
    room('r3', '730 028 516', 2, 0, ['poker'], 6, 'msk'),
  ];
  function room(id, code, humans, screens, integrations, minutes, node) {
    return {
      id,
      code: code.replace(/\s/g, ''),
      createdAt: now - (minutes + 2) * 60_000,
      startedAt: now - minutes * 60_000,
      humans,
      connected: humans,
      waiting: 0,
      bots: integrations.includes('watch') ? 1 : 0,
      screens,
      integrations,
      createdHere: true,
      mediaNode: node,
    };
  }
  const nowMeet = {
    serverTime: now,
    live: 3,
    waiting: 1,
    humans: 12,
    connected: 12,
    bots: 1,
    screens: 1,
    rooms,
  };
  const nowA = {
    serverTime: now,
    live: 0,
    waiting: 0,
    humans: 0,
    connected: 0,
    bots: 0,
    screens: 0,
    rooms: [],
  };
  const maintenanceNone = { phase: 'none', window: null, closed: null, now: new Date(now).toISOString() };
  const maintenanceScheduled = {
    phase: 'scheduled',
    window: {
      id: 'mw-7f3a',
      kind: 'scheduled',
      startsAt: new Date(now + 20 * 3_600_000).toISOString(),
      endsAt: new Date(now + 21 * 3_600_000).toISOString(),
      expiresAt: new Date(now + 22 * 3_600_000).toISOString(),
      reason: 'Обновление ядра до 1.3.1',
      createdAt: new Date(now - 3_600_000).toISOString(),
      startedAt: null,
    },
    closed: null,
    now: new Date(now).toISOString(),
  };
  const job = (id, kind, machine, args, status, minutesAgo, dryRun = false, summary = null) => ({
    id,
    kind,
    machine,
    args,
    actor: id.endsWith('g') ? 'agent' : 'owner',
    dryRun,
    status,
    createdAt: sec - minutesAgo * 60,
    startedAt: sec - minutesAgo * 60 + 1,
    finishedAt: status === 'running' || status === 'queued' ? null : sec - minutesAgo * 60 + 95,
    exitCode: status === 'ok' ? 0 : status === 'failed' ? 1 : null,
    summary,
  });
  const jobs = [
    job('j-5c1e', 'status', 'meet', {}, 'running', 1),
    job(
      'j-4b0d',
      'deploy',
      'meet',
      { services: ['gateway', 'core'], ref: 'release/1.3', drain: true },
      'ok',
      46,
    ),
    job('j-3a9g', 'node.check', 'b', { node: 'hel' }, 'ok', 95, false, 'узел отвечает, TURN 443 открыт'),
    job(
      'j-2f8c',
      'deploy',
      'a',
      { services: ['core'], ref: 'release/1.3' },
      'failed',
      180,
      false,
      'сборка образа: нет места',
    ),
    job('j-1e7b', 'maintenance.schedule', 'meet', { startsAt: '2026-11-10T04:00+03:00' }, 'ok', 240, true),
    job('j-0d6a', 'rollback', 'a', { services: ['core'], commit: '5b4718f' }, 'cancelled', 1_440),
  ];
  const metric = (cpu, steal, mem, diskFree, uplink) => ({
    cpu,
    steal,
    memUsed: mem,
    memTotalBytes: 16e9,
    diskFreeBytes: diskFree,
    uplinkMbps: uplink,
  });
  const status = (lines, minutesAgo) => ({ lines, updatedAt: sec - minutesAgo * 60 });
  const overview = {
    serverTime: sec,
    machines: [
      {
        ...machines[0],
        metrics: metric(0.18, 0.01, 0.52, 41e9, 3.2),
        status: status(['1.3.0 · 6d03dd0 · up 13 д'], 4),
        now: { data: nowA, error: null },
        maintenance: { data: maintenanceNone, error: null },
      },
      {
        ...machines[1],
        metrics: metric(0.64, 0.12, 0.47, 88e9, 162),
        status: status(['1.3.0 · 3df7bad · up 3 ч'], 2),
        now: { data: nowMeet, error: null },
        maintenance: { data: maintenanceScheduled, error: null },
      },
      {
        ...machines[2],
        metrics: metric(0.21, 0.02, 0.31, 52e9, 48),
        status: status(['узел hel · 1.3.0'], 9),
        now: null,
        maintenance: null,
      },
      {
        ...machines[3],
        metrics: metric(0.12, 0.01, 0.28, 61e9, 22),
        status: status(['узел msk · 1.3.0'], 7),
        now: null,
        maintenance: null,
      },
    ],
    alerts: {
      alerts: [
        {
          name: 'StealHigh',
          severity: 'warning',
          node: 'meet',
          state: 'firing',
          activeAt: new Date(now - 14 * 60_000).toISOString(),
          summary: 'steal 12 % дольше 10 минут — звук может рваться',
        },
      ],
      error: null,
    },
    jobs: jobs.slice(0, 5),
    executor: me.executor,
  };

  const load = (o) => ({
    cpu: null,
    steal: null,
    iowait: null,
    load1: null,
    memUsed: null,
    memAvailableBytes: null,
    swapUsedBytes: null,
    diskUsed: null,
    diskFreeBytes: null,
    diskReadMBps: null,
    diskWriteMBps: null,
    netInMbps: null,
    netOutMbps: null,
    netErrorsPerSec: null,
    tcpEstablished: null,
    psiCpu: null,
    psiMemory: null,
    psiIo: null,
    ...o,
  });
  const hardware = (cores, mem, disk, host, boot) => ({
    cores,
    memTotalBytes: mem,
    diskTotalBytes: disk,
    kernel: '6.8.0-147-generic',
    os: 'Ubuntu 24.04.3 LTS',
    arch: 'x86_64',
    hostname: host,
    virtualization: 'KVM',
    bootTime: sec - boot,
  });
  const live = {
    serverTime: sec,
    error: null,
    totals: {
      meetings: 3,
      waiting: 1,
      humans: 12,
      screens: 1,
      bots: 1,
      integrations: 2,
      netInMbps: 58.4,
      netOutMbps: 214.7,
      busiest: { machine: 'meet', cpu: 0.64 },
    },
    machines: [
      {
        ...machines[1],
        sources: { node: true, containers: true, core: true, sfu: true, gateway: true },
        hardware: hardware(6, 16e9, 160e9, 'meet', 3 * 3_600),
        load: load({
          cpu: 0.64,
          steal: 0.12,
          iowait: 0.01,
          load1: 0.71,
          memUsed: 0.47,
          swapUsedBytes: 0,
          diskUsed: 0.45,
          diskReadMBps: 0.4,
          diskWriteMBps: 2.1,
          netInMbps: 41.2,
          netOutMbps: 162.5,
          netErrorsPerSec: 0,
          tcpEstablished: 214,
          psiCpu: 0.06,
        }),
        containers: [
          { name: 'livekit', cpu: 0.31, memBytes: 0.9e9, inMbps: 38.1, outMbps: 151.2 },
          { name: 'core', cpu: 0.12, memBytes: 1.4e9, inMbps: 1.1, outMbps: 3.4 },
          { name: 'gateway', cpu: 0.04, memBytes: 0.12e9, inMbps: 1.6, outMbps: 6.8 },
          { name: 'postgres', cpu: 0.02, memBytes: 0.36e9, inMbps: 0.1, outMbps: 0.1 },
        ],
        core: {
          live: 3,
          waiting: 1,
          humans: 12,
          connected: 12,
          bots: 1,
          screens: 1,
          integrations: { watch: 1, poker: 1, music: 0 },
          joinsPerMin: 2.4,
          failuresPerMin: 0,
          clientErrorsPerMin: 0.3,
          loadLevel: 2,
          loadShare: { cpu: 0.64, people: 0.3, rooms: 0.15, uplink: 0.27 },
          version: '1.3.0',
          nodes: [
            { node: 'main', rooms: 1, participants: 7, up: 1 },
            { node: 'hel', rooms: 1, participants: 3, up: 1 },
            { node: 'msk', rooms: 1, participants: 2, up: 1 },
          ],
        },
        sfu: { rooms: 1, participants: 8, inMbps: 38.1, outMbps: 151.2, lossPercent: 0.4, rttMs: 38 },
        gateway: { rps: 18.2, inFlight: 3, errorsPerSec: 0 },
        now: { data: nowMeet, error: null },
      },
      {
        ...machines[0],
        sources: { node: true, containers: true, core: true, sfu: true, gateway: true },
        hardware: hardware(4, 16e9, 160e9, 'cord-a', 13 * 86_400),
        load: load({
          cpu: 0.18,
          steal: 0.01,
          iowait: 0.02,
          load1: 0.22,
          memUsed: 0.52,
          swapUsedBytes: 0.2e9,
          diskUsed: 0.74,
          diskReadMBps: 1.2,
          diskWriteMBps: 0.6,
          netInMbps: 2.1,
          netOutMbps: 3.2,
          netErrorsPerSec: 0,
          tcpEstablished: 96,
          psiCpu: 0.01,
        }),
        containers: [],
        core: {
          live: 0,
          waiting: 0,
          humans: 0,
          connected: 0,
          bots: 0,
          screens: 0,
          integrations: {},
          joinsPerMin: 0,
          failuresPerMin: 0,
          clientErrorsPerMin: 0,
          loadLevel: 0,
          loadShare: {},
          version: '1.3.0',
          nodes: [],
        },
        sfu: { rooms: 0, participants: 0, inMbps: 0, outMbps: 0, lossPercent: null, rttMs: null },
        gateway: { rps: 1.1, inFlight: 0, errorsPerSec: 0 },
        now: { data: nowA, error: null },
      },
      {
        ...machines[2],
        sources: { node: true, containers: true, core: null, sfu: true, gateway: true },
        hardware: hardware(2, 4e9, 80e9, 'b', 2 * 86_400),
        load: load({
          cpu: 0.21,
          steal: 0.02,
          memUsed: 0.31,
          diskUsed: 0.35,
          netInMbps: 9.6,
          netOutMbps: 31.4,
          tcpEstablished: 41,
          load1: 0.3,
          psiCpu: 0.02,
        }),
        containers: [],
        core: null,
        sfu: { rooms: 1, participants: 3, inMbps: 9.2, outMbps: 30.8, lossPercent: 0.1, rttMs: 22 },
        gateway: null,
        now: null,
      },
      {
        ...machines[3],
        sources: { node: true, containers: null, core: null, sfu: true, gateway: true },
        hardware: hardware(2, 4e9, 80e9, 'msk', 5 * 86_400),
        load: load({
          cpu: 0.12,
          steal: 0.01,
          memUsed: 0.28,
          diskUsed: 0.24,
          netInMbps: 4.1,
          netOutMbps: 11.8,
          tcpEstablished: 23,
          load1: 0.14,
          psiCpu: 0.01,
        }),
        containers: [],
        core: null,
        sfu: { rooms: 1, participants: 2, inMbps: 3.9, outMbps: 11.2, lossPercent: 0, rttMs: 9 },
        gateway: { rps: 0.6, inFlight: 0, errorsPerSec: 0 },
        now: null,
      },
    ],
  };
  const series = (base, spread, scale = 1) =>
    Array.from({ length: 120 }, (_, i) => [sec - (119 - i) * 15, (wave(i, base, spread, 40) * scale) / 100]);
  // ── Карта флота и состояние среды (R240): `GET /map`, `/map/history`, `/state` ──
  const box = (name, service, cpu, memMb, limitMb, extra = {}) => ({
    name,
    service,
    image: extra.image ?? `${service ?? name}:1.4.0`,
    group: extra.group ?? 'cord',
    cpu,
    cpuShare: null,
    memBytes: memMb * 1e6,
    memLimitBytes: limitMb ? limitMb * 1e6 : null,
    memShare: null,
    diskBytes: extra.diskMb ? extra.diskMb * 1e6 : null,
    startedAt: sec - (extra.up ?? 2 * 86_400),
    netInMbps: extra.net?.[0] ?? null,
    netOutMbps: extra.net?.[1] ?? null,
  });
  const mapMachine = (
    id,
    title,
    role,
    environment,
    nodeId,
    host,
    cores,
    memGb,
    load,
    meetings,
    containers,
    version = '1.4.0',
  ) => {
    const memTotalBytes = memGb * 1e9;
    for (const c of containers) {
      c.cpuShare = c.cpu / cores;
      c.memShare = c.memBytes / (c.memLimitBytes ?? memTotalBytes);
    }
    const others = containers.filter((c) => c.group === 'neighbour');
    return {
      id,
      title,
      role,
      environment,
      nodeId,
      host,
      online: true,
      sources: {
        node: true,
        containers: true,
        core: role !== 'media-node' ? true : null,
        sfu: true,
        gateway: true,
      },
      version: role === 'media-node' ? null : version,
      hardware: { cores, memTotalBytes, diskTotalBytes: 120e9, bootTime: sec - 17 * 86_400 },
      load,
      meetings,
      containers: containers.sort((x, y) =>
        x.group === y.group ? y.memBytes - x.memBytes : x.group === 'cord' ? -1 : 1,
      ),
      neighbours: {
        count: others.length,
        cpu: others.length ? others.reduce((sum, c) => sum + c.cpu, 0) : null,
        memBytes: others.length ? others.reduce((sum, c) => sum + c.memBytes, 0) : null,
      },
    };
  };
  const fleetMap = {
    serverTime: sec,
    error: null,
    machines: [
      mapMachine(
        'meet',
        'meet',
        'product-core',
        'product',
        'fra',
        '108.165.32.23',
        6,
        16,
        { cpu: 0.64, steal: 0.12, memUsed: 0.58, diskUsed: 0.62, netInMbps: 21, netOutMbps: 96 },
        { live: 2, people: 9 },
        [
          box('modern-streaming-core-1', 'core', 0.9, 940, 2048, { diskMb: 40 }),
          box('modern-streaming-postgres-1', 'postgres', 0.35, 410, null, {
            image: 'postgres:18.3-alpine',
            diskMb: 5200,
          }),
          box('modern-streaming-livekit-1', 'livekit', 1.6, 310, 1024, {
            image: 'livekit-server:v1.13.6',
            net: [21, 96],
          }),
          box('modern-streaming-services-1', 'services', 0.5, 520, 1024, { diskMb: 900 }),
          box('modern-streaming-insight-1', 'insight', 0.05, 38, 128),
          box('modern-streaming-gateway-1', 'gateway', 0.12, 44, null, { image: 'caddy:2.11.4' }),
          box('modern-streaming-edge-1', 'edge', 0.2, 52, null, { image: 'caddyl4:v2.11.3' }),
          box('modern-streaming-redis-1', 'redis', 0.03, 22, null, { image: 'redis:8.6.6-alpine' }),
          box('modern-streaming-tusd-1', 'tusd', 0.01, 18, null, { image: 'tusd:v2.10.0', diskMb: 300 }),
          box('modern-streaming-backbone-1', 'backbone', 0.02, 24, 128, { image: 'caddyl4:v2.11.3' }),
          box('cord-agent', null, 0.01, 9, null, { image: 'cord-agent:1.4.0' }),
          box('kiki-core', null, 0.4, 3600, null, { group: 'neighbour', image: 'kiki-core:latest' }),
          box('kiki-postgres', null, 0.1, 380, null, { group: 'neighbour', image: 'postgres:16' }),
          box('kiki-worker-stt', null, 0.2, 900, null, { group: 'neighbour', image: 'kiki-worker:latest' }),
          box('kiki-grafana', null, 0.02, 160, null, { group: 'neighbour', image: 'grafana:11' }),
        ],
      ),
      mapMachine(
        'msk',
        'msk',
        'media-node',
        'product',
        'msk',
        '157.22.241.114',
        2,
        4,
        { cpu: 0.22, steal: 0.01, memUsed: 0.31, diskUsed: 0.4, netInMbps: 4, netOutMbps: 18 },
        { live: 1, people: 2 },
        [
          box('cord-node-livekit-1', 'livekit', 0.35, 180, 1024, {
            image: 'livekit-server:v1.13.6',
            net: [4, 18],
          }),
          box('cord-node-edge-1', 'edge', 0.05, 40, null, { image: 'caddyl4:v2.11.3' }),
          box('cord-node-backbone-1', 'backbone', 0.01, 20, 128, { image: 'caddyl4:v2.11.3' }),
          box('cord-agent', null, 0.01, 9, null, { image: 'cord-agent:1.4.0' }),
          box('ivi-proxy', null, 0.02, 60, null, { group: 'neighbour', image: 'squid:6' }),
        ],
      ),
      mapMachine(
        'b',
        'B',
        'media-node',
        'product',
        'hel',
        '152.234.227.199',
        2,
        4,
        { cpu: 0.87, steal: 0.02, memUsed: 0.44, diskUsed: 0.35, netInMbps: 9, netOutMbps: 61 },
        { live: 1, people: 3 },
        [
          box('cord-node-livekit-1', 'livekit', 1.5, 260, 1024, {
            image: 'livekit-server:v1.13.6',
            net: [9, 61],
          }),
          box('cord-node-edge-1', 'edge', 0.1, 44, null, { image: 'caddyl4:v2.11.3' }),
          box('cord-node-backbone-1', 'backbone', 0.01, 20, 128, { image: 'caddyl4:v2.11.3' }),
          box('cord-agent', null, 0.01, 9, null, { image: 'cord-agent:1.4.0' }),
          box('youtube-proxy', null, 0.12, 120, null, { group: 'neighbour', image: 'stunnel-squid:1' }),
        ],
      ),
      mapMachine(
        'a',
        'A',
        'dev+admin',
        'dev',
        'fra',
        '108.165.32.75',
        4,
        8,
        { cpu: 0.18, steal: 0.01, memUsed: 0.63, diskUsed: 0.66, netInMbps: 1, netOutMbps: 2 },
        { live: 0, people: 0 },
        [
          box('modern-streaming-core-1', 'core', 0.12, 930, 2048),
          box('modern-streaming-postgres-1', 'postgres', 0.03, 60, null, {
            image: 'postgres:18.3-alpine',
            diskMb: 700,
          }),
          box('modern-streaming-livekit-1', 'livekit', 0.04, 90, 1024, {
            image: 'livekit-server:v1.13.6',
            net: [0, 0],
          }),
          box('modern-streaming-services-1', 'services', 0.03, 80, 1024),
          box('modern-streaming-victoriametrics-1', 'victoriametrics', 0.08, 130, 256, {
            image: 'victoria-metrics:v1.154.0',
            diskMb: 2400,
          }),
          box('modern-streaming-grafana-1', 'grafana', 0.03, 250, 384, { image: 'grafana:13.2.4' }),
          box('modern-streaming-fleet-1', 'fleet', 0.02, 45, 256),
          box('modern-streaming-gateway-1', 'gateway', 0.01, 30, null, { image: 'caddy:2.11.4' }),
          box('modern-streaming-edge-1', 'edge', 0.01, 26, null, { image: 'caddyl4:v2.11.3' }),
          box('modern-streaming-redis-1', 'redis', 0.01, 12, null, { image: 'redis:8.6.6-alpine' }),
          box('modern-streaming-vmalert-1', 'vmalert', 0.01, 22, 64, { image: 'vmalert:v1.154.0' }),
          box('modern-streaming-alertmanager-1', 'alertmanager', 0.01, 25, 64, {
            image: 'alertmanager:v0.34.1',
          }),
          box('modern-streaming-gatus-1', 'gatus', 0.01, 20, 64, { image: 'gatus:v5.37.0' }),
          box('kalkutta-web-1', null, 0.01, 20, null, { group: 'neighbour', image: 'kalkutta-web:latest' }),
        ],
      ),
    ],
  };
  const fleetState = {
    serverTime: sec,
    environments: {
      product: {
        level: 'warn',
        reason: 'meet: steal 12 % дольше 10 минут — звук может рваться',
        since: new Date(now - 14 * 60_000).toISOString(),
        problems: [
          {
            level: 'warn',
            kind: 'alert',
            summary: 'meet: steal 12 % дольше 10 минут — звук может рваться',
            machine: 'meet',
            since: new Date(now - 14 * 60_000).toISOString(),
          },
          {
            level: 'warn',
            kind: 'alert',
            summary: 'Узел hel: ЦП 87 % пять минут',
            machine: 'b',
            since: new Date(now - 6 * 60_000).toISOString(),
          },
        ],
        machines: 3,
        online: 3,
      },
      dev: { level: 'ok', reason: null, since: null, problems: [], machines: 1, online: 1 },
    },
    monitoring: { error: null, alerts: null },
  };
  const mapHistory = (names) => ({
    series: Object.fromEntries(
      names.map((name, k) => [
        name,
        Array.from({ length: 60 }, (_, i) => [
          sec - (60 - i) * 30,
          name === 'memBytes' ? 9e8 + wave(i + k, 40, 30) * 1e6 : wave(i + k * 3, 40, 22) / 100,
        ]),
      ]),
    ),
    step: 30,
    error: null,
  });

  const liveHistory = {
    machines: {
      meet: {
        cpu: series(58, 12),
        netOutMbps: series(150, 40, 100),
        netInMbps: series(40, 10, 100),
        connected: series(11, 3, 100),
      },
      a: { cpu: series(18, 4), netOutMbps: series(3, 1, 100), netInMbps: series(2, 1, 100), connected: [] },
      b: { cpu: series(20, 5), netOutMbps: series(30, 8, 100), netInMbps: series(9, 3, 100), connected: [] },
      msk: {
        cpu: series(12, 3),
        netOutMbps: series(11, 4, 100),
        netInMbps: series(4, 2, 100),
        connected: [],
      },
    },
    error: null,
    step: 15,
  };

  const ticket = (n, o) => ({
    id: `0000000${n}-0000-4000-8000-00000000000${n}`,
    number: o.number,
    createdAt: now - o.minutes * 60_000,
    topic: o.topic,
    message: o.message,
    contact: o.contact ?? null,
    diagnostics: o.diagnostics ?? null,
    issues: o.issues ?? [],
    status: o.status,
    statusAt: now - o.minutes * 60_000,
    notifiedAt: null,
    assignee: o.assignee ?? null,
    priority: o.priority ?? 'normal',
    tags: o.tags ?? [],
    firstResponseAt: o.answered ? now - (o.minutes - 20) * 60_000 : null,
    resolvedAt: o.status === 'DONE' ? now - 30 * 60_000 : null,
    archivedAt: null,
    pausedMs: o.status === 'WAITING' ? 40 * 60_000 : 0,
    firstResponseDueAt: now - o.minutes * 60_000 + 4 * 3_600_000,
    resolveDueAt: now - o.minutes * 60_000 + 48 * 3_600_000,
    breached: !!o.breached,
    slaMet: o.status === 'DONE' ? true : null,
    machine: o.machine ?? 'meet',
    machineTitle: o.machine === 'a' ? 'A' : 'meet',
    product: o.machine === 'a' ? 'callcord.ru' : 'cord.online',
  });
  const tickets = [
    ticket(1, {
      number: '7F3A91C2',
      minutes: 12,
      topic: 'sound',
      message: 'У собеседника пропадает звук каждые пару минут, особенно когда включаю показ экрана.',
      contact: '@ivan_petrov',
      status: 'NEW',
      priority: 'high',
      tags: ['звук', 'показ'],
      diagnostics: '{"version":"1.3.0","client":"desktop","os":"Windows 11","node":"fra","rttMs":61}',
    }),
    ticket(2, {
      number: '2C8D04B7',
      minutes: 290,
      topic: 'network',
      message: 'Не подключается с работы, висит «Подключение…».',
      contact: 'olga@example.com',
      status: 'NEW',
      priority: 'urgent',
      breached: true,
      issues: ['connect'],
    }),
    ticket(3, {
      number: '91BE5D30',
      minutes: 95,
      topic: 'windows',
      message: 'После обновления приложение открывается на весь экран и не сворачивается.',
      contact: '+7 900 123-45-67',
      status: 'OPEN',
      assignee: 'owner',
      answered: true,
    }),
    ticket(4, {
      number: 'C04F18E6',
      minutes: 600,
      topic: 'idea',
      message: 'Хочется общую доску прямо во время показа экрана.',
      status: 'WAITING',
      priority: 'low',
      answered: true,
    }),
    ticket(5, {
      number: '5DA27F19',
      minutes: 1_500,
      topic: 'camera',
      message: 'Камера ноутбука не находится в Firefox.',
      contact: '@marina_k',
      status: 'DONE',
      answered: true,
      machine: 'a',
    }),
  ];
  const counts = { fresh: 2, open: 1, waiting: 1, done: 1, archived: 14, breached: 1, unassigned: 3 };
  const stats = {
    days: 30,
    created: 41,
    resolved: 36,
    firstResponseMedianMinutes: 38,
    resolveMedianMinutes: 410,
    withinSla: 0.86,
    topics: { sound: 12, network: 9, windows: 7, camera: 6, idea: 4, other: 3 },
  };
  const nodes = {
    registry: {
      format: 'nodes/v1',
      nodes: [
        {
          id: 'main',
          control: true,
          ip: '108.165.32.23',
          title: { ru: 'Франкфурт', en: 'Frankfurt' },
          country: 'DE',
          enabled: true,
          maxRooms: 8,
          uplinkMbps: 1000,
          cores: 6,
        },
        {
          id: 'hel',
          ip: '152.234.227.199',
          title: { ru: 'Хельсинки', en: 'Helsinki' },
          country: 'FI',
          enabled: true,
          maxRooms: 4,
          uplinkMbps: 500,
          cores: 2,
          ssh: 'root@152.234.227.199',
        },
        {
          id: 'msk',
          ip: '157.22.241.114',
          title: { ru: 'Москва', en: 'Moscow' },
          country: 'RU',
          enabled: true,
          maxRooms: 4,
          uplinkMbps: 500,
          cores: 2,
          ssh: 'root@157.22.241.114',
        },
      ],
    },
    registryError: null,
    levels: {
      data: [
        { id: 'main', title: { ru: 'Франкфурт' }, country: 'DE', control: true, level: 2, state: 'ok' },
        { id: 'hel', title: { ru: 'Хельсинки' }, country: 'FI', control: false, level: 3, state: 'busy' },
        { id: 'msk', title: { ru: 'Москва' }, country: 'RU', control: false, level: 1, state: 'ok' },
      ],
      error: null,
    },
  };
  const summary = {
    from: now - 7 * DAY,
    to: now,
    meetings: 71,
    humanSeconds: 131.5 * 3_600,
    medianSeconds: 33 * 60,
    longestSeconds: 212 * 60,
    peakHumans: 23,
    uniqueDevices: 188,
    joins: 302,
    joinFailures: 4,
    days: [],
  };
  const audit = [
    ['job.start', 'meet', 'ok', null, { kind: 'deploy', services: ['gateway', 'core'] }, 'j-4b0d', 46],
    ['maintenance.schedule', 'meet', 'ok', 'окно на 10.11 04:00', null, null, 60],
    ['node.check', 'hel', 'ok', null, null, 'j-3a9g', 95],
    ['auth.login', null, 'ok', null, null, null, 120],
    ['job.start', 'a', 'failed', 'сборка образа: нет места', { kind: 'deploy' }, 'j-2f8c', 180],
    ['auth.login', null, 'refused', 'неверный код', null, null, 600],
  ].map(([action, target, outcome, detail, args, jobId, minutes], i) => ({
    id: 900 - i,
    ts: sec - minutes * 60,
    actor: i === 2 ? 'agent' : 'owner',
    sessionId: 's1',
    ip: '91.210.4.18',
    action,
    target,
    args,
    outcome,
    detail,
    jobId,
  }));
  const coreAudit = {
    events: [
      { ts: now - 5 * 60_000, code: 'JOIN_REFUSED', outcome: 'refused', room: '482193774' },
      { ts: now - 22 * 60_000, code: 'ROOM_CLOSED', outcome: 'ok', room: '119640285' },
      { ts: now - 64 * 60_000, code: 'ABUSE_LIMIT', outcome: 'refused', ip: '203.0.113.7' },
    ],
    cursor: null,
  };
  const sessions = [
    {
      id: 's1',
      ip: '91.210.4.18',
      userAgent: 'Chrome 141 · Windows',
      createdAt: sec - 3_600,
      lastSeenAt: sec - 20,
      current: true,
    },
    {
      id: 's2',
      ip: '91.210.4.18',
      userAgent: 'Safari · iPhone',
      createdAt: sec - 86_400,
      lastSeenAt: sec - 7_200,
      current: false,
    },
  ];
  const jobDetail = {
    job: jobs[1],
    lines: [
      { n: 1, ts: sec - 2_760, stream: 'info', text: 'Выкатка meet: gateway core (release/1.3), дренаж' },
      { n: 2, ts: sec - 2_759, stream: 'cmd', text: '$ backlog/bin/deploy.sh --drain gateway core' },
      { n: 3, ts: sec - 2_700, stream: 'out', text: 'Ждём конца встреч: 0 идёт' },
      { n: 4, ts: sec - 2_690, stream: 'out', text: 'Сборка образа core… готово за 41 с' },
      { n: 5, ts: sec - 2_668, stream: 'out', text: 'Проверка: /api/v1/ping 200, smoke PASS' },
      { n: 6, ts: sec - 2_665, stream: 'info', text: 'Готово: 1.3.0 · 3df7bad' },
    ],
  };
  return {
    me,
    machines,
    overview,
    live,
    liveHistory,
    fleetMap,
    fleetState,
    mapHistory,
    tickets,
    counts,
    stats,
    nodes,
    nowMeet,
    nowA,
    maintenanceScheduled,
    maintenanceNone,
    summary,
    jobs,
    jobDetail,
    audit,
    coreAudit,
    sessions,
  };
}

/** Ответ подставной службы на один запрос: `{status, body}`; неизвестный путь — 404 в форме RFC 7807. */
export function fleetAnswer(data, url, method = 'GET') {
  const path = url.pathname.replace(/^\/api\/fleet/, '');
  const q = url.searchParams;
  const ok = (body) => ({ status: 200, body });
  if (method !== 'GET') {
    if (path === '/jobs' || /^\/nodes\/[^/]+\/[^/]+\/\w+$/.test(path)) return ok(data.jobs[0]);
    return { status: 204 };
  }
  if (path === '/auth/me') return ok(data.me);
  if (path === '/auth/sessions') return ok(data.sessions);
  if (path === '/machines') return ok(data.machines);
  if (path === '/overview') return ok(data.overview);
  if (path === '/live') return ok(data.live);
  if (path === '/live/history') return ok(data.liveHistory);
  if (path === '/state') return ok(data.fleetState);
  if (path === '/map') return ok(data.fleetMap);
  if (path === '/map/history')
    return ok(
      data.mapHistory(
        url.searchParams.get('container')
          ? ['cpu', 'memBytes']
          : ['cpu', 'steal', 'memUsed', 'netOutMbps', 'netInMbps'],
      ),
    );
  if (path === '/support') return ok({ tickets: data.tickets, more: false, errors: [], skipped: [] });
  if (path === '/support/counts')
    return ok({ total: data.counts, machines: { meet: { data: data.counts, error: null } } });
  if (path === '/support/stats')
    return ok({ days: 30, machines: { meet: { data: data.stats, error: null } } });
  const ticket = /^\/support\/([^/]+)\/([^/]+)$/.exec(path);
  if (ticket) {
    const found = data.tickets.find((t) => t.id === ticket[2]) ?? data.tickets[0];
    return ok({
      ticket: found,
      notes: [
        {
          id: 1,
          ticketId: found.id,
          createdAt: found.createdAt + 60_000,
          author: 'system',
          kind: 'status',
          text: 'new',
        },
        {
          id: 2,
          ticketId: found.id,
          createdAt: found.createdAt + 120_000,
          author: 'agent',
          kind: 'note',
          text: 'Похоже на steal на meet в это время — проверить график.',
        },
      ],
    });
  }
  if (/^\/nodes\/[^/]+$/.test(path)) return ok(data.nodes);
  // Аналитика (R239): образцы отчётов службы `insight` — те же файлы, с которыми сверяется её тест.
  const insight = /^\/insight\/([a-z]+)(\/.+)?$/.exec(path);
  if (insight) {
    const sample = insightSample(insight[2] ? `${insight[1]}-detail` : insight[1]);
    return sample ? ok(sample) : { status: 404, body: { status: 404, code: 'NOT_FOUND', detail: path } };
  }
  const core = /^\/core\/([^/]+)\/(.+)$/.exec(path);
  if (core) {
    const [, machine, rest] = core;
    if (rest === 'now') return ok(machine === 'meet' ? data.nowMeet : data.nowA);
    if (rest === 'server')
      return ok({
        shield: false,
        blocksActive: machine === 'meet' ? 2 : 0,
        autoBlockCount: 20,
        autoBlockWindowMs: 600_000,
        autoBlockTermMs: 3_600_000,
        blockDefaultMs: 86_400_000,
        build: '1.4.0',
      });
    if (rest === 'blocks')
      return ok(
        machine === 'meet'
          ? [
              {
                id: 'blk-1',
                kind: 'ip',
                subject: '203.0.113.47',
                reason: 'Пределы адреса: 24 отказа за 10 минут',
                createdBy: 'auto',
                createdAt: Date.now() - 18 * 60_000,
                expiresAt: Date.now() + 42 * 60_000,
              },
              {
                id: 'blk-2',
                kind: 'profile',
                subject: 'p_7Hq2xLm9',
                reason: 'Спам в чате встречи',
                createdBy: 'admin',
                createdAt: Date.now() - 26 * 3_600_000,
                expiresAt: Date.now() + 142 * 3_600_000,
              },
            ]
          : [],
      );
    if (rest === 'meetings') return ok(data.summary);
    if (rest === 'maintenance')
      return ok(machine === 'meet' ? data.maintenanceScheduled : data.maintenanceNone);
    if (rest === 'drain') return ok({ on: false, since: 0 });
    if (rest === 'audit') return ok(data.coreAudit);
  }
  if (path === '/jobs') {
    const kind = q.get('kind');
    return ok(kind ? data.jobs.filter((j) => j.kind === kind) : data.jobs);
  }
  if (/^\/jobs\/[^/]+$/.test(path)) {
    // Как служба: только строки после `after` — экран задачи дописывает хвост.
    const after = Number(q.get('after') ?? 0);
    return ok({ ...data.jobDetail, lines: data.jobDetail.lines.filter((line) => line.n > after) });
  }
  if (path === '/audit') return ok(data.audit);
  return { status: 404, body: { status: 404, code: 'NOT_FOUND', detail: path } };
}

/** Подменить `/api/fleet/*` у страницы Playwright. */
export async function routeFleet(page, data = fleetData()) {
  await page.route('**/api/fleet/**', async (route) => {
    const request = route.request();
    const answer = fleetAnswer(data, new URL(request.url()), request.method());
    if (answer.status === 204) return route.fulfill({ status: 204 });
    return route.fulfill({ status: answer.status, json: answer.body });
  });
}
