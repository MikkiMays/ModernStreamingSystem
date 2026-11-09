import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminApp } from './AdminApp';
import { text } from '../i18n/admin/ru';
import { contactLink, slaText } from './screens/Support';
import { streams } from './screens/Live';
import type { SupportTicket } from './api';

/**
 * Три больших экрана пульта (R209, R210, R215) против подменённой службы `fleet`: «Флот — live», «Аналитика» с
 * переключателем ЛТВ/АКТУАЛ и «Обращения» всей системы с проработкой обращения в выезжающей панели.
 */
type Call = { method: string; path: string; headers: Record<string, string>; body: unknown };

function serve(routes: (url: URL, init: RequestInit) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      calls.push({
        method: init.method ?? 'GET',
        path: url.pathname + url.search,
        headers: (init.headers as Record<string, string>) ?? {},
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      const result = routes(url, init);
      if (result.status === 204) return new Response(null, { status: 204 });
      return new Response(JSON.stringify(result.body ?? {}), {
        status: result.status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return calls;
}

const me = {
  actor: 'owner',
  since: 1,
  expiresAt: 2,
  allowIps: false,
  executor: { mode: 'dry-run', sshMachines: [] },
  adminHost: null,
  agentOps: ['read'],
};

const machines = [
  {
    id: 'a',
    title: 'Стенд',
    role: 'dev+admin',
    host: '127.0.0.1',
    installDir: '/opt',
    ssh: false,
    nodeId: null,
    product: null,
    core: { url: 'http://127.0.0.1:8080', credential: 'password' },
  },
  {
    id: 'meet',
    title: 'Продукт',
    role: 'product-core',
    host: '108.165.32.23',
    installDir: '/opt/meet',
    ssh: true,
    nodeId: 'fra',
    product: 'cordcam.ru',
    core: { url: 'http://127.0.0.1:19112', credential: 'key' },
  },
];

const nullLoad = Object.fromEntries(
  [
    'cpu',
    'steal',
    'iowait',
    'load1',
    'memUsed',
    'memAvailableBytes',
    'swapUsedBytes',
    'diskUsed',
    'diskFreeBytes',
    'diskReadMBps',
    'diskWriteMBps',
    'netInMbps',
    'netOutMbps',
    'netErrorsPerSec',
    'tcpEstablished',
    'psiCpu',
    'psiMemory',
    'psiIo',
  ].map((k) => [k, null]),
);

const live = {
  serverTime: 1_800_000_000,
  error: null,
  totals: {
    meetings: 3,
    waiting: 1,
    humans: 11,
    screens: 1,
    bots: 0,
    integrations: 2,
    netInMbps: 12.5,
    netOutMbps: 40,
    busiest: { machine: 'meet', cpu: 0.91 },
  },
  machines: [
    {
      ...machines[1],
      sources: { node: true, containers: true, core: true, sfu: null, gateway: false },
      hardware: {
        cores: 6,
        memTotalBytes: 16e9,
        diskTotalBytes: 135e9,
        kernel: '6.8.0',
        os: 'Ubuntu 24.04.5 LTS',
        arch: 'x86_64',
        hostname: 'meet',
        virtualization: 'KVM · Red Hat',
        bootTime: 1_799_000_000,
      },
      load: { ...nullLoad, cpu: 0.91, steal: 0.35, memUsed: 0.4, netOutMbps: 40, netInMbps: 12.5 },
      containers: [],
      core: {
        live: 3,
        waiting: 1,
        humans: 11,
        connected: 11,
        bots: 0,
        screens: 1,
        integrations: { watch: 2, music: 0 },
        joinsPerMin: 1,
        failuresPerMin: 0,
        clientErrorsPerMin: 0,
        loadLevel: 2,
        loadShare: { cpu: 0.4 },
        version: '1.2.2',
        nodes: [{ node: 'fra', rooms: 3, participants: 11, up: 1 }],
      },
      sfu: null,
      gateway: { rps: 12, inFlight: 1, errorsPerSec: 0 },
      now: {
        data: {
          serverTime: 1_800_000_000_000,
          live: 3,
          waiting: 1,
          humans: 11,
          connected: 11,
          bots: 0,
          screens: 1,
          rooms: [
            {
              id: 'r1',
              code: '111222333',
              createdAt: 1,
              startedAt: 1_799_999_000_000,
              humans: 2,
              connected: 2,
              waiting: 0,
              bots: 0,
              screens: 0,
              integrations: [],
              createdHere: true,
              mediaNode: 'fra',
            },
            {
              id: 'r2',
              code: '444555666',
              createdAt: 1,
              startedAt: 1_799_999_000_000,
              humans: 8,
              connected: 8,
              waiting: 0,
              bots: 0,
              screens: 1,
              integrations: ['watch'],
              createdHere: true,
              mediaNode: 'fra',
            },
          ],
        },
        error: null,
      },
    },
  ],
};

function report(mode: string) {
  return {
    mode,
    from: '2026-11-01',
    to: '2026-11-07',
    zone: 'Europe/Moscow',
    today: '2026-11-09',
    visitors: {
      total: 40,
      fresh: 25,
      returning: mode === 'ltv' ? 9 : 15,
      callers: 20,
      newCallers: 12,
      sameDayCallers: 8,
    },
    rates: {
      er: 0.5,
      stickiness: mode === 'ltv' ? null : 0.2,
      activeDays: 1.6,
      errorsPerVisit: 0.05,
      joinFailureRate: 0.02,
    },
    calls: {
      meetings: mode === 'ltv' ? null : 14,
      created: 10,
      entries: 30,
      joinFailures: 1,
      presenceHours: 22.5,
      meetingHours: mode === 'ltv' ? null : 23,
      hoursPerCaller: 1.1,
      minutesPerEntry: 45,
      avgMinutes: mode === 'ltv' ? null : 40,
      medianMinutes: mode === 'ltv' ? null : 35,
      longestMinutes: mode === 'ltv' ? null : 180,
      peakMeetings: mode === 'ltv' ? null : 4,
      largestMeeting: mode === 'ltv' ? null : 9,
    },
    funnel: { opened: 40, prejoined: 26, joined: 20 },
    clients: [
      { kind: 'desktop', count: 15 },
      { kind: 'web', count: 25 },
    ],
    os: [{ kind: 'windows', count: 30 }],
    integrations: {
      meetings: mode === 'ltv' ? [] : [{ kind: 'watch', count: 5 }],
      meetingsWithAny: mode === 'ltv' ? null : 5,
      visitors: 12,
      encounters: 17,
    },
    days: [
      {
        day: '2026-11-01',
        visitors: 10,
        fresh: 10,
        callers: 5,
        entries: 6,
        presenceHours: 3,
        meetings: mode === 'ltv' ? null : 2,
      },
      {
        day: '2026-11-02',
        visitors: 12,
        fresh: 5,
        callers: 7,
        entries: 9,
        presenceHours: 5,
        meetings: mode === 'ltv' ? null : 4,
      },
    ],
    retention: {
      anchor: mode === 'ltv' ? 'first' : 'period',
      step: 'day',
      total: { since: '2026-11-01', until: '2026-11-07', size: 25, d1: 0.4, d3: 0.5, d7: null, d30: null },
      cohorts: [
        { since: '2026-11-01', until: '2026-11-01', size: 10, d1: 0.4, d3: 0.5, d7: null, d30: null },
      ],
    },
  };
}

function ticket(overrides: Partial<SupportTicket> = {}): SupportTicket {
  return {
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    number: 'AAAAAAAA',
    createdAt: Date.now() - 60_000,
    topic: 'sound',
    message: 'Не слышно собеседника',
    contact: '@someone_here',
    diagnostics: '{"version":"1.2.2","browser":"Chrome 140"}',
    issues: [],
    status: 'NEW',
    statusAt: Date.now() - 60_000,
    notifiedAt: null,
    assignee: null,
    priority: 'high',
    tags: ['звук'],
    firstResponseAt: null,
    resolvedAt: null,
    archivedAt: null,
    pausedMs: 0,
    firstResponseDueAt: Date.now() + 4 * 3_600_000,
    resolveDueAt: Date.now() + 48 * 3_600_000,
    breached: false,
    slaMet: null,
    machine: 'meet',
    machineTitle: 'Продукт',
    product: 'cordcam.ru',
    ...overrides,
  };
}

function routes(url: URL, init: RequestInit) {
  const path = url.pathname;
  if (path === '/api/fleet/auth/me') return { status: 200, body: me };
  if (path === '/api/fleet/machines') return { status: 200, body: machines };
  if (path === '/api/fleet/live') return { status: 200, body: live };
  if (path === '/api/fleet/live/history')
    return {
      status: 200,
      body: {
        machines: {
          meet: {
            cpu: [
              [1, 0.2],
              [2, 0.9],
            ],
            netOutMbps: [],
            netInMbps: [],
            connected: [],
          },
        },
        error: null,
        step: 15,
      },
    };
  if (path.endsWith('/analytics'))
    return { status: 200, body: report(url.searchParams.get('mode') ?? 'actual') };
  if (path === '/api/fleet/support')
    return {
      status: 200,
      body: {
        tickets: [
          ticket(),
          ticket({
            id: 'bbbbbbbb-0000-4000-8000-000000000002',
            number: 'BBBBBBBB',
            machine: 'a',
            machineTitle: 'Стенд',
            product: null,
            breached: true,
            priority: 'normal',
            firstResponseDueAt: Date.now() - 3_600_000,
          }),
        ],
        more: false,
        errors: [
          { machine: 'cordcam', status: 502, code: 'CORE_UNREACHABLE', detail: 'Ядро cordcam не отвечает' },
        ],
        skipped: [],
      },
    };
  if (path === '/api/fleet/support/counts')
    return {
      status: 200,
      body: {
        total: { fresh: 2, open: 0, waiting: 0, done: 0, archived: 3, breached: 1, unassigned: 2 },
        machines: {},
      },
    };
  if (path === '/api/fleet/support/stats')
    return {
      status: 200,
      body: {
        days: 30,
        machines: {
          meet: {
            data: {
              days: 30,
              created: 5,
              resolved: 3,
              firstResponseMedianMinutes: 30,
              resolveMedianMinutes: 600,
              withinSla: 0.66,
              topics: { sound: 4 },
            },
            error: null,
          },
        },
      },
    };
  if (path.startsWith('/api/fleet/support/meet/') && init.method === 'PUT') return { status: 204 };
  if (path.endsWith('/notes')) return { status: 200, body: { id: 3, kind: 'reply', text: 'x' } };
  if (path.startsWith('/api/fleet/support/meet/'))
    return {
      status: 200,
      body: {
        ticket: ticket(),
        notes: [
          { id: 1, ticketId: 'x', createdAt: Date.now(), author: 'agent', kind: 'assign', text: 'owner' },
        ],
      },
    };
  return { status: 404, body: { status: 404, code: 'NOT_FOUND', detail: path } };
}

describe('экраны пульта R209/R210/R215', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    history.replaceState(null, '', '/');
  });

  it('«Флот — live»: сводка флота, железо, нагрузка с порогами, ядро и кто нагружает сеть', async () => {
    history.replaceState(null, '', '/live');
    const calls = serve(routes);
    render(<AdminApp />);
    await screen.findByText(text.live.totals, {}, { timeout: 10_000 });
    const card = await screen.findByRole('region', { name: 'Продукт' }, { timeout: 10_000 });
    expect(within(card).getByText(/6 ядер/)).toBeInTheDocument();
    expect(within(card).getByText(/KVM · Red Hat/)).toBeInTheDocument();
    // steal 35 % — выше красного порога.
    const steal = within(card).getAllByText(text.live.steal)[0]!.closest('.admin-meter')!;
    expect(steal).toHaveAttribute('data-tone', 'bad');
    expect(within(card).getByText(/кинозал · 2/)).toBeInTheDocument();
    // Встреча на восемь человек с показом — первой: у неё больше потоков SFU.
    const rows = within(within(card).getByRole('table', { name: text.live.nowTitle })).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('444555666');
    expect(rows[1]).toHaveTextContent(String(8 * 7 + 7));
    expect(within(card).getByText(text.live.containersEmpty, { exact: false })).toBeInTheDocument();
    expect(calls.some((c) => c.path.startsWith('/api/fleet/live/history?minutes=30'))).toBe(true);
  }, 30_000);

  it('«Аналитика»: по умолчанию ядро продукта и АКТУАЛ; ЛТВ спрашивает когорту и прячет величины встреч', async () => {
    history.replaceState(null, '', '/analytics');
    const calls = serve(routes);
    render(<AdminApp />);
    await screen.findByRole('heading', { name: text.analytics.visitorsTitle }, { timeout: 10_000 });
    const first = calls.find((c) => c.path.includes('/analytics'))!;
    expect(first.path).toMatch(/^\/api\/fleet\/core\/meet\/analytics\?/);
    expect(first.path).toContain('mode=actual');
    expect((await screen.findAllByText('50 %')).length).toBeGreaterThan(0);
    expect(screen.getByText(text.analytics.meetings).closest('.admin-stat')).toHaveTextContent('14');
    fireEvent.click(screen.getByRole('radio', { name: text.analytics.ltv }));
    await waitFor(() => expect(calls.some((c) => c.path.includes('mode=ltv'))).toBe(true));
    await waitFor(() =>
      expect(screen.getByText(text.analytics.meetings).closest('.admin-stat')).toHaveTextContent('—'),
    );
    // Таблица удержания: доли и «рано» там, где срок не прошёл.
    expect(screen.getAllByText(text.analytics.early).length).toBeGreaterThan(0);
    // Ряд по дням — и таблицей.
    fireEvent.click(screen.getByRole('button', { name: text.analytics.table }));
    expect(screen.getByRole('columnheader', { name: text.analytics.day })).toBeInTheDocument();
  }, 30_000);

  it('«Обращения»: ящик всей системы, упавшее ядро — строкой, обращение ведётся рычагами своей машины', async () => {
    history.replaceState(null, '', '/support');
    const calls = serve(routes);
    render(<AdminApp />);
    await screen.findByText('AAAAAAAA', {}, { timeout: 10_000 });
    expect(screen.getByText('BBBBBBBB')).toBeInTheDocument();
    expect(screen.getByText(/cordcam: Ядро cordcam не отвечает/)).toBeInTheDocument();
    expect(screen.getByText(/просрочено/)).toBeInTheDocument();
    await screen.findByText(text.support.stats);

    fireEvent.click(screen.getByText('AAAAAAAA'));
    const take = await screen.findByRole('button', { name: text.support.take }, { timeout: 10_000 });
    expect(screen.getByRole('link', { name: text.support.writeTelegram })).toHaveAttribute(
      'href',
      'https://t.me/someone_here',
    );
    fireEvent.click(take);
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'PUT' && c.path.endsWith('/status'))).toBe(true),
    );
    const put = calls.find((c) => c.method === 'PUT' && c.path.endsWith('/status'))!;
    expect(put.path).toBe('/api/fleet/support/meet/aaaaaaaa-0000-4000-8000-000000000001/status');
    expect(put.body).toEqual({ status: 'OPEN' });
    expect(put.headers['X-Fleet-Request']).toBe('1');

    fireEvent.click(screen.getByRole('radio', { name: text.support.noteReply }));
    fireEvent.change(screen.getByLabelText(text.support.noteText), {
      target: { value: 'Проверьте наушники' },
    });
    fireEvent.click(screen.getByRole('button', { name: text.support.add }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/notes'))).toBe(true));
    expect(calls.find((c) => c.path.endsWith('/notes'))!.body).toEqual({
      kind: 'reply',
      text: 'Проверьте наушники',
    });

    // Поиск уходит в службу с задержкой набора.
    fireEvent.change(screen.getByLabelText(text.support.searchLabel), { target: { value: 'наушники' } });
    await waitFor(() =>
      expect(calls.some((c) => c.path.includes('q=%D0%BD%D0%B0%D1%83%D1%88%D0%BD%D0%B8%D0%BA%D0%B8'))).toBe(
        true,
      ),
    );
  }, 30_000);

  it('«Встречи → участники»: из идущей встречи — к её журналу с полным адресом, клиентом и выходом', async () => {
    history.replaceState(null, '', '/meetings');
    const started = Date.now() - 60_000;
    const calls = serve((url, init) => {
      const path = url.pathname;
      if (/^\/api\/fleet\/core\/[^/]+\/now$/.test(path))
        return {
          status: 200,
          body: {
            serverTime: Date.now(),
            live: 1,
            waiting: 0,
            humans: 2,
            connected: 2,
            bots: 0,
            screens: 0,
            rooms: [
              {
                id: 'r1',
                code: '111222333',
                createdAt: started,
                startedAt: started,
                humans: 2,
                connected: 2,
                waiting: 0,
                bots: 0,
                screens: 0,
                integrations: [],
                createdHere: true,
                mediaNode: 'fra',
              },
            ],
          },
        };
      if (/^\/api\/fleet\/core\/[^/]+\/participants$/.test(path))
        return {
          status: 200,
          body: {
            items: [
              {
                id: 'p1',
                roomId: 'r1',
                roomCode: '111222333',
                title: 'Совет директоров',
                participantId: 'm1',
                name: 'Анна',
                profileHash: null,
                ip: '2001:db8:0:0:0:0:0:7',
                client: 'desktop',
                os: 'windows',
                door: 'link',
                mediaNode: 'fra',
                joinedAt: started,
                leftAt: null,
              },
            ],
            next: null,
          },
        };
      return routes(url, init);
    });
    render(<AdminApp />);
    const people = await screen.findByRole(
      'button',
      { name: `${text.meetings.peopleOf} 111222333` },
      { timeout: 10_000 },
    );
    fireEvent.click(people);
    await screen.findByText('2001:db8:0:0:0:0:0:7', {}, { timeout: 10_000 });
    const asked = calls.find((c) => c.path.includes('/participants'))!;
    // Встреча по коду — за весь срок журнала, без периода.
    expect(asked.path).toContain('code=111222333');
    expect(asked.path).not.toContain('from=');
    const table = screen.getByRole('table', { name: text.meetings.participants });
    expect(within(table).getByText(text.meetings.inMeeting)).toBeInTheDocument();
    expect(within(table).getByText(/приложение Windows · Windows/)).toBeInTheDocument();
    expect(within(table).getByText(/Совет директоров/)).toBeInTheDocument();
    // Без кода — журнал за период.
    fireEvent.change(screen.getByLabelText(text.meetings.codeFilter), { target: { value: '' } });
    await waitFor(() =>
      expect(calls.some((c) => c.path.includes('/participants') && c.path.includes('from='))).toBe(true),
    );
  }, 30_000);

  it('контакт человека становится ссылкой ответа, SLA — словами', () => {
    expect(contactLink('@cord_user')).toEqual({
      href: 'https://t.me/cord_user',
      label: text.support.writeTelegram,
    });
    expect(contactLink('t.me/cord_user')?.href).toBe('https://t.me/cord_user');
    expect(contactLink('me@example.com')?.href).toBe('mailto:me@example.com');
    expect(contactLink('+7 (900) 000-00-00')?.href).toBe('tel:+79000000000');
    expect(contactLink('после обеда')).toBeNull();
    const now = 1_000_000_000;
    expect(slaText(ticket({ status: 'WAITING' }), now).text).toBe(text.support.paused);
    expect(slaText(ticket({ slaMet: false }), now)).toEqual({ text: text.support.missed, tone: 'warn' });
    expect(
      slaText(ticket({ firstResponseDueAt: now - 600_000, resolveDueAt: now + 1, breached: true }), now).tone,
    ).toBe('bad');
    expect(streams({ connected: 3, screens: 1 })).toBe(3 * 2 + 2);
  });
});
