import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminApp } from './AdminApp';
import { text } from '../i18n/admin/ru';
import { contactLink, slaText } from './screens/Support';
import { streams } from './screens/Live';
import type { SupportTicket } from './api';
import type { ErrorDetail, Report, Reports } from './analytics/types';

/**
 * Образцы отчётов службы `insight` — те же файлы, с которыми побайтно сверяется её тест
 * (`contracts/fixtures/insight`): изменилась форма отчёта — упадёт тест ниже. Читаются с диска, а не
 * импортом: образ веба собирается из одного `web/`, и импорт из соседнего каталога сломал бы сборку.
 */
const sample = <T,>(name: string): T =>
  JSON.parse(
    readFileSync(join(process.cwd(), '..', 'contracts', 'fixtures', 'insight', `${name}.json`), 'utf8'),
  ) as T;
const SECTIONS = [
  'pulse',
  'audience',
  'acquisition',
  'activation',
  'retention',
  'engagement',
  'integrations',
  'quality',
  'errors',
  'traffic',
] as const;
const samples = Object.fromEntries(SECTIONS.map((name) => [name, sample(name)])) as {
  [S in keyof Reports]: Report<Reports[S]>;
};
const insight: Record<string, unknown> = {
  ...samples,
  'errors-detail': sample<Report<ErrorDetail>>('errors-detail'),
};

/**
 * Три больших экрана пульта (R209, R239, R215) против подменённой службы `fleet`: «Флот — live», «Аналитика» по
 * образцам отчётов службы `insight` и «Обращения» всей системы с проработкой обращения в выезжающей панели.
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
    product: 'cord.online',
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
    product: 'cord.online',
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
  if (path === '/api/fleet/core/meet/server')
    return {
      status: 200,
      body: {
        shield: true,
        blocksActive: 1,
        autoBlockCount: 20,
        autoBlockWindowMs: 600_000,
        autoBlockTermMs: 3_600_000,
        blockDefaultMs: 86_400_000,
      },
    };
  if (path === '/api/fleet/core/meet/blocks')
    return {
      status: 200,
      body: [
        {
          id: 'b1',
          kind: 'ip',
          subject: '203.0.113.7',
          reason: 'Пределы адреса',
          createdBy: 'auto',
          createdAt: Date.now() - 600_000,
          expiresAt: Date.now() + 3_000_000,
        },
        {
          id: 'b2',
          kind: 'ip',
          subject: '198.51.100.9',
          reason: 'Снята',
          createdBy: 'admin',
          createdAt: Date.now() - 9_000_000,
          expiresAt: Date.now() + 3_000_000,
          liftedAt: Date.now() - 60_000,
        },
      ],
    };
  if (path === '/api/fleet/core/meet/blocks/b1' && init.method === 'DELETE') return { status: 204 };
  if (path.startsWith('/api/fleet/insight/errors/')) return { status: 200, body: insight['errors-detail'] };
  if (path.startsWith('/api/fleet/insight/')) {
    const body = insight[path.slice('/api/fleet/insight/'.length)];
    return body
      ? { status: 200, body }
      : { status: 404, body: { status: 404, code: 'NOT_FOUND', detail: '' } };
  }
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
        errors: [{ machine: 'msk', status: 502, code: 'CORE_UNREACHABLE', detail: 'Ядро msk не отвечает' }],
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

  it('«Аналитика»: каждый раздел рисуется по образцу службы; период, вид и строгий счёт уходят в запрос; ошибка открывается', async () => {
    history.replaceState(null, '', '/analytics');
    const calls = serve(routes);
    render(<AdminApp />);
    const t = text.analytics;
    // Пульс: путеводная метрика — первой и крупной плиткой, с изменением к прошлому периоду.
    const lead = (
      await screen.findAllByText(t.kpi.weekly_interlocutors!, undefined, { timeout: 10_000 })
    )[0]!;
    expect(lead.closest('.an-kpi')).toHaveAttribute('data-lead');
    const first = calls.find((c) => c.path.startsWith('/api/fleet/insight/pulse'))!;
    expect(first.path).toContain('env=product');
    expect(first.path).toContain('view=period');
    expect(first.path).toContain('strict=0');
    expect(first.path).toContain('compare=1');
    expect(first.path).toMatch(/from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/);
    // Каждый раздел: свой запрос, свои плитки, и ни одной дыры в подписях и числах.
    for (const section of Object.keys(samples)) {
      fireEvent.click(screen.getByRole('tab', { name: t.sections[section] }));
      await screen.findByText(t.questions[section]!);
      await waitFor(() =>
        expect(calls.some((c) => c.path.startsWith(`/api/fleet/insight/${section}?`))).toBe(true),
      );
      await waitFor(() => expect(document.querySelectorAll('.an-kpi').length).toBeGreaterThan(2));
      await waitFor(() => expect(document.querySelectorAll('.an-block').length).toBeGreaterThan(1));
      expect(document.querySelector('.an')!.textContent).not.toMatch(/NaN|undefined|\[object|Infinity/);
    }
    // Ряд по дням — и таблицей (для чтения с экрана и для копирования).
    fireEvent.click(screen.getByRole('tab', { name: t.sections.pulse }));
    await screen.findByText(t.blocks.weekly!);
    fireEvent.click(screen.getAllByRole('button', { name: t.chart.asTable })[0]!);
    expect(screen.getByRole('columnheader', { name: t.chart.day })).toBeInTheDocument();
    // Вид «Когорты» и строгий счёт — параметрами запроса.
    fireEvent.click(screen.getByRole('radio', { name: t.viewCohort }));
    await waitFor(() => expect(calls.some((c) => c.path.includes('view=cohort'))).toBe(true));
    fireEvent.click(screen.getByRole('checkbox', { name: t.strict }));
    await waitFor(() => expect(calls.some((c) => c.path.includes('strict=1'))).toBe(true));
    expect(location.search).toContain('view=cohort');
    // Удержание: сетка когорт с «рано» там, где срок ещё не вышел.
    fireEvent.click(screen.getByRole('tab', { name: t.sections.retention }));
    await screen.findByText(t.blocks.cohorts!);
    expect(document.querySelector('.an-cohorts')).not.toBeNull();
    // Ошибки: строка группы открывает её подробности — версии, шаги, последние случаи.
    fireEvent.click(screen.getByRole('tab', { name: t.sections.errors }));
    await screen.findByText(t.blocks.groups!);
    const group = samples.errors.data.groups[0]!;
    const row = document.querySelector<HTMLElement>('.an-table[data-rows="links"] tbody tr')!;
    fireEvent.click(row);
    await screen.findByText(t.blocks.samples!);
    expect(
      calls.some((c) => c.path.startsWith(`/api/fleet/insight/errors/${encodeURIComponent(group.key)}?`)),
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: t.back }));
    await screen.findByText(t.blocks.groups!);
  }, 60_000);

  it('«Безопасность»: щит, действующие блокировки со снятием, отказы защиты и роботы за неделю', async () => {
    history.replaceState(null, '', '/security');
    const calls = serve(routes);
    render(<AdminApp />);
    const t = text.security;
    await screen.findByText(t.shieldOn, {}, { timeout: 10_000 });
    // Действующая блокировка — строкой; снятая в список не попадает.
    await screen.findByText('203.0.113.7');
    expect(screen.queryByText('198.51.100.9')).toBeNull();
    expect(screen.getByText(t.by.auto!)).toBeInTheDocument();
    // Числа недели — из аналитики выбранной среды.
    await waitFor(() =>
      expect(
        calls.some((c) => c.path.startsWith('/api/fleet/insight/quality?') && c.path.includes('env=product')),
      ).toBe(true),
    );
    expect((await screen.findAllByText('RATE_LIMITED')).length).toBeGreaterThan(0);
    expect(document.querySelector('.an')!.textContent).not.toMatch(/NaN|undefined|\[object/);
    // Снять блокировку — рычагом ядра этой среды.
    fireEvent.click(screen.getByRole('button', { name: t.liftOf('203.0.113.7') }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/fleet/core/meet/blocks/b1')).toBe(
        true,
      ),
    );
  }, 30_000);

  it('«Обращения»: ящик всей системы, упавшее ядро — строкой, обращение ведётся рычагами своей машины', async () => {
    history.replaceState(null, '', '/support');
    const calls = serve(routes);
    render(<AdminApp />);
    await screen.findByText('AAAAAAAA', {}, { timeout: 10_000 });
    expect(screen.getByText('BBBBBBBB')).toBeInTheDocument();
    expect(screen.getByText(/msk: Ядро msk не отвечает/)).toBeInTheDocument();
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
