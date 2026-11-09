// Подставная служба `fleet` для снимков пульта (R220): правдоподобный флот из четырёх машин — стенд A, ядро
// продукта meet и два медиаузла — с идущими встречами, алертом, обращениями, задачами и журналом. Формы ответов —
// `web/src/admin/api.ts` (зеркало `services/fleet/fleet/app.py`). Пульт за клиентским сертификатом, поэтому снимки
// идут против dev-сервера или сборки, а `/api/fleet/*` отвечает отсюда.
//
//   import { routeFleet } from './admin-fixtures.mjs';
//   await routeFleet(page);            // до первого перехода на `/admin.html`

const DAY = 86_400_000;

function isoDay(ms) {
  const date = new Date(ms);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
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
    executor: { mode: 'ssh', sshMachines: ['meet', 'b', 'cordcam'] },
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
      product: 'cordcam.ru',
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
      id: 'cordcam',
      title: 'cordcam',
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
        hardware: hardware(2, 4e9, 80e9, 'cordcam', 5 * 86_400),
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
      cordcam: {
        cpu: series(12, 3),
        netOutMbps: series(11, 4, 100),
        netInMbps: series(4, 2, 100),
        connected: [],
      },
    },
    error: null,
    step: 15,
  };

  const report = (mode, from, to) => {
    const ltv = mode === 'ltv';
    const start = Date.parse(`${from}T12:00:00`);
    const end = Date.parse(`${to}T12:00:00`);
    const days = [];
    for (let t = start, i = 0; t <= end; t += DAY, i++) {
      const visitors = wave(i, 46, 14);
      days.push({
        day: isoDay(t),
        visitors,
        fresh: Math.round(visitors * 0.42),
        callers: Math.round(visitors * 0.58),
        entries: Math.round(visitors * 0.9),
        presenceHours: Math.round(visitors * 0.63 * 10) / 10,
        meetings: ltv ? null : Math.round(visitors * 0.22),
      });
    }
    return {
      mode,
      from,
      to,
      zone: 'Europe/Moscow',
      today: isoDay(now),
      visitors: {
        total: 812,
        fresh: 341,
        returning: ltv ? 132 : 471,
        callers: 463,
        newCallers: 188,
        sameDayCallers: 142,
      },
      rates: {
        er: 0.57,
        stickiness: ltv ? null : 0.18,
        activeDays: 2.4,
        errorsPerVisit: 0.04,
        joinFailureRate: 0.012,
      },
      calls: {
        meetings: ltv ? null : 296,
        created: 301,
        entries: 1_214,
        joinFailures: 15,
        presenceHours: 538.6,
        meetingHours: ltv ? null : 544.2,
        hoursPerCaller: 1.16,
        minutesPerEntry: 27,
        avgMinutes: ltv ? null : 41,
        medianMinutes: ltv ? null : 33,
        longestMinutes: ltv ? null : 212,
        peakMeetings: ltv ? null : 9,
        largestMeeting: ltv ? null : 14,
      },
      funnel: { opened: 812, prejoined: 590, joined: 463 },
      clients: [
        { kind: 'web', count: 438 },
        { kind: 'desktop', count: 251 },
        { kind: 'android', count: 86 },
        { kind: 'telegram', count: 37 },
      ],
      os: [
        { kind: 'windows', count: 512 },
        { kind: 'android', count: 141 },
        { kind: 'macos', count: 74 },
        { kind: 'ios', count: 52 },
        { kind: 'linux', count: 33 },
      ],
      integrations: {
        meetings: ltv
          ? []
          : [
              { kind: 'watch', count: 61 },
              { kind: 'music', count: 38 },
              { kind: 'poker', count: 17 },
              { kind: 'board', count: 9 },
            ],
        meetingsWithAny: ltv ? null : 104,
        visitors: 233,
        encounters: 312,
      },
      days,
      retention: {
        anchor: ltv ? 'first' : 'period',
        step: 'week',
        total: { since: from, until: to, size: 341, d1: 0.31, d3: 0.22, d7: 0.17, d30: null },
        cohorts: [0, 1, 2, 3].map((w) => {
          const since = isoDay(start + w * 7 * DAY);
          const until = isoDay(Math.min(end, start + (w * 7 + 6) * DAY));
          return {
            since,
            until,
            size: 70 + w * 9,
            d1: 0.34 - w * 0.02,
            d3: 0.25 - w * 0.02,
            d7: w < 3 ? 0.18 - w * 0.02 : null,
            d30: null,
          };
        }),
      },
    };
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
    product: o.machine === 'a' ? 'callcord.ru' : 'cordcam.ru',
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
    report,
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
  const core = /^\/core\/([^/]+)\/(.+)$/.exec(path);
  if (core) {
    const [, machine, rest] = core;
    if (rest === 'now') return ok(machine === 'meet' ? data.nowMeet : data.nowA);
    if (rest === 'analytics')
      return ok(
        data.report(
          q.get('mode') ?? 'actual',
          q.get('from') ?? isoDay(Date.now() - 29 * DAY),
          q.get('to') ?? isoDay(Date.now()),
        ),
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
