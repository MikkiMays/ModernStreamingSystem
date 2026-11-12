import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminApp, sectionPath } from './AdminApp';
import { attentionOf } from './screens/Overview';
import { DASHBOARDS, dashboardUrl, MAIN_DASHBOARD } from './grafana';
import { nodeStates } from './nodes';
import { text } from '../i18n/admin/ru';
import type { NodesView, Overview, SupportCounts } from './api';

/**
 * Каркас пульта после R220: разделы по группам, Grafana отдельной вкладкой, тема пульта, выбор ядра только у
 * разделов ядра, полоса телефона, обзор «что требует внимания» и медиаузлы как узлы ядра продукта, а не машины
 * «без ядра». Служба `fleet` подменена; проверяется поведение и разметка доступности, а не вид.
 */
type Call = { method: string; path: string };

function serve(routes: (path: string) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      calls.push({ method: init.method ?? 'GET', path: url.pathname + url.search });
      const result = routes(url.pathname);
      if (result.status === 204) return new Response(null, { status: 204 });
      return new Response(JSON.stringify(result.body ?? {}), {
        status: result.status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return calls;
}

/** Ширина окна для `matchMedia`: телефон — до 767 px. */
function viewport(width: number) {
  vi.stubGlobal('matchMedia', (query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    return {
      matches: max ? width <= Number(max[1]) : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  });
}

const me = {
  actor: 'owner',
  since: 1,
  expiresAt: 2,
  allowIps: false,
  executor: { mode: 'ssh', sshMachines: ['meet', 'b'] },
  adminHost: null,
  agentOps: [],
};

const machines = [
  {
    id: 'meet',
    title: 'meet',
    role: 'product-core',
    host: '108.165.32.23',
    installDir: '/opt/meet',
    ssh: true,
    nodeId: 'fra',
    product: 'cord.online',
    core: { url: 'http://127.0.0.1:19112', credential: 'key' },
  },
  {
    id: 'b',
    title: 'B',
    role: 'media-node',
    host: '152.234.227.199',
    installDir: '/opt',
    ssh: true,
    nodeId: 'hel',
    product: null,
    core: null,
  },
];

const nodes: NodesView = {
  registry: {
    format: 'nodes/v1',
    nodes: [
      { id: 'main', control: true, title: { ru: 'Франкфурт' }, country: 'DE', enabled: true },
      { id: 'hel', title: { ru: 'Хельсинки' }, country: 'FI', enabled: true },
      { id: 'msk', title: { ru: 'Москва' }, country: 'RU', enabled: true },
    ],
  },
  registryError: null,
  levels: {
    data: [
      { id: 'main', title: { ru: 'Франкфурт' }, country: 'DE', control: true, level: 1, state: 'ok' },
      { id: 'hel', title: { ru: 'Хельсинки' }, country: 'FI', control: false, level: 3, state: 'busy' },
      { id: 'msk', title: { ru: 'Москва' }, country: 'RU', control: false, level: 0, state: 'down' },
    ],
    error: null,
  },
};

const metrics = { cpu: 0.2, steal: 0, memUsed: 0.3, memTotalBytes: 8e9, diskFreeBytes: 5e10, uplinkMbps: 3 };
const room = (id: string, node: string, humans: number) => ({
  id,
  code: id,
  createdAt: 1,
  startedAt: 1,
  humans,
  connected: humans,
  waiting: 0,
  bots: 0,
  screens: 0,
  integrations: [],
  createdHere: true,
  mediaNode: node,
});

const overview: Overview = {
  serverTime: 1_800_000_000,
  machines: [
    {
      ...(machines[0] as Overview['machines'][number]),
      metrics,
      status: null,
      now: {
        data: {
          serverTime: 1,
          live: 2,
          waiting: 0,
          humans: 5,
          connected: 5,
          bots: 0,
          screens: 0,
          rooms: [room('r1', 'main', 2), room('r2', 'hel', 3)],
        },
        error: null,
      },
      maintenance: { data: { phase: 'none', window: null, closed: null, now: 'x' }, error: null },
    },
    {
      ...(machines[1] as Overview['machines'][number]),
      metrics,
      status: null,
      now: null,
      maintenance: null,
    },
  ],
  alerts: { alerts: [], error: null },
  jobs: [],
  executor: { mode: 'ssh', sshMachines: ['meet', 'b'] },
};

const counts: SupportCounts = {
  fresh: 2,
  open: 0,
  waiting: 0,
  done: 0,
  archived: 0,
  breached: 1,
  unassigned: 2,
};

function routes(path: string): { status: number; body?: unknown } {
  if (path === '/api/fleet/auth/me') return { status: 200, body: me };
  if (path === '/api/fleet/machines') return { status: 200, body: machines };
  if (path === '/api/fleet/overview') return { status: 200, body: overview };
  if (path === '/api/fleet/support/counts') return { status: 200, body: { total: counts, machines: {} } };
  if (path === '/api/fleet/nodes/meet') return { status: 200, body: nodes };
  if (path === '/api/fleet/jobs') return { status: 200, body: [] };
  if (path === '/api/fleet/core/meet/now') return { status: 200, body: overview.machines[0]!.now!.data };
  return { status: 404, body: { status: 404, code: 'NOT_FOUND', detail: path } };
}

describe('каркас пульта R220', () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    history.replaceState(null, '', '/');
  });

  it('разделы — по группам, выбранный отмечен, счётчик обращений; Grafana — новой вкладкой без opener и referrer', async () => {
    serve(routes);
    render(<AdminApp />);
    const nav = await screen.findByRole('navigation', { name: text.app.menu }, { timeout: 10_000 });
    for (const group of Object.values(text.navGroups))
      expect(within(nav).getByRole('heading', { name: group })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: text.nav.overview })).toHaveAttribute(
      'aria-current',
      'page',
    );
    // Новые 2 + просроченное 1 — красный счётчик у «Обращений».
    const support = within(nav).getByRole('link', { name: new RegExp(text.nav.support) });
    await waitFor(() => expect(support).toHaveTextContent('3'));
    expect(support.querySelector('[data-tone="bad"]')).not.toBeNull();
    const grafana = screen.getByRole('link', { name: new RegExp(text.app.grafana) });
    expect(grafana).toHaveAttribute('href', `/grafana/d/${MAIN_DASHBOARD}`);
    expect(grafana).toHaveAttribute('target', '_blank');
    expect(grafana).toHaveAttribute('rel', 'noopener noreferrer');
    expect(document.title).toBe(`${text.nav.overview} — ${text.app.title}`);
    // Исполнитель виден всегда: вживую — с машинами.
    expect(screen.getByText(text.app.executorLive).closest('.admin-executor')).toHaveTextContent('meet, b');
  });

  it('переход по разделу: адрес, заголовок вкладки и фокус на заголовок раздела; выбор ядра — только у разделов ядра', async () => {
    serve(routes);
    render(<AdminApp />);
    await screen.findByRole('navigation', { name: text.app.menu }, { timeout: 10_000 });
    expect(screen.queryByRole('combobox')).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: text.nav.meetings }));
    await waitFor(() => expect(location.pathname).toBe(sectionPath('meetings')));
    expect(document.title).toBe(`${text.nav.meetings} — ${text.app.title}`);
    expect(screen.getByRole('heading', { level: 1, name: text.nav.meetings })).toHaveFocus();
    expect(await screen.findByRole('combobox')).toHaveDisplayValue('meet · cord.online');
  });

  it('тема пульта: три значка, выбор ставит data-theme и помнится', async () => {
    serve(routes);
    render(<AdminApp />);
    const group = await screen.findByRole('radiogroup', { name: text.app.theme }, { timeout: 10_000 });
    fireEvent.click(within(group).getByRole('radio', { name: text.app.themes.dark }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('cord:theme')).toBe('dark');
    fireEvent.click(within(group).getByRole('radio', { name: text.app.themes.system }));
    expect(document.documentElement.dataset.theme).toBe('system');
    expect(localStorage.getItem('cord:theme')).toBeNull();
  });

  it('телефон: полоса из четырёх разделов и «Ещё» — лист со всеми разделами и Grafana', async () => {
    viewport(390);
    serve(routes);
    render(<AdminApp />);
    const bar = await screen.findByRole('navigation', { name: text.app.quick }, { timeout: 10_000 });
    expect(
      within(bar)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual(['/', '/live', '/support', '/meetings']);
    expect(screen.queryByRole('complementary', { name: text.app.navigation })).toBeNull();
    await act(async () => {
      fireEvent.click(within(bar).getByRole('button', { name: text.app.more }));
    });
    const sheet = await screen.findByRole('dialog', { name: text.app.menu });
    expect(within(sheet).getByRole('link', { name: text.nav.audit })).toBeInTheDocument();
    expect(within(sheet).getByRole('link', { name: new RegExp(text.app.grafana) })).toHaveAttribute(
      'target',
      '_blank',
    );
  });
});

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
const hardware = {
  cores: 2,
  memTotalBytes: 4e9,
  diskTotalBytes: 8e10,
  kernel: null,
  os: null,
  arch: null,
  hostname: null,
  virtualization: null,
  bootTime: null,
};
const live = {
  serverTime: 1,
  error: null,
  totals: {
    meetings: 2,
    waiting: 0,
    humans: 5,
    screens: 0,
    bots: 0,
    integrations: 0,
    netInMbps: 1,
    netOutMbps: 2,
    busiest: null,
  },
  machines: [
    {
      ...machines[0],
      sources: { node: true, containers: null, core: true, sfu: true, gateway: true },
      hardware,
      load: nullLoad,
      containers: [],
      core: {
        live: 2,
        waiting: 0,
        humans: 5,
        connected: 5,
        bots: 0,
        screens: 0,
        integrations: {},
        joinsPerMin: 0,
        failuresPerMin: 0,
        clientErrorsPerMin: 0,
        loadLevel: null,
        loadShare: {},
        version: '1.3.0',
        nodes: [
          { node: 'main', rooms: 1, participants: 2, up: 1 },
          { node: 'hel', rooms: 1, participants: 3, up: 1 },
          { node: 'msk', rooms: 0, participants: 0, up: 0 },
        ],
      },
      sfu: null,
      gateway: null,
      now: null,
    },
    {
      ...machines[1],
      sources: { node: true, containers: null, core: null, sfu: true, gateway: true },
      hardware,
      load: nullLoad,
      containers: [],
      core: null,
      sfu: { rooms: 1, participants: 3, inMbps: 1, outMbps: 2, lossPercent: null, rttMs: null },
      gateway: null,
      now: null,
    },
  ],
};

describe('«Флот — live»: медиаузел и ядро продукта', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    history.replaceState(null, '', '/');
  });

  it('у медиаузла — связь с ядром продукта (реестр, магистраль, комнаты), а не «ядро не собирается»; у ядра — таблица узлов', async () => {
    history.replaceState(null, '', '/live');
    serve((path) =>
      path === '/api/fleet/live'
        ? { status: 200, body: live }
        : path === '/api/fleet/live/history'
          ? { status: 200, body: { machines: {}, error: null, step: 15 } }
          : routes(path),
    );
    render(<AdminApp />);
    const card = await screen.findByRole('region', { name: 'B' }, { timeout: 10_000 });
    expect(within(card).getByRole('heading', { name: text.live.linkTitle })).toBeInTheDocument();
    await waitFor(() =>
      expect(within(card).getByText(`${text.live.registry}: ${text.nodes.states.busy}`)).toBeInTheDocument(),
    );
    expect(within(card).getByText(`${text.live.backbone}: ${text.live.backboneUp}`)).toBeInTheDocument();
    expect(within(card).getByText(`→ ${text.live.linkCore} meet · cord.online`)).toBeInTheDocument();
    // Своего ядра у узла нет — и строки «ядро» среди источников тоже.
    expect(
      within(within(card).getByRole('list', { name: text.live.sourcesTitle })).queryByText(
        text.live.sources.core!,
      ),
    ).toBeNull();
    const core = screen.getByRole('region', { name: 'meet' });
    const table = within(core).getByRole('table', { name: text.live.nodes });
    const msk = within(table).getByRole('row', { name: /msk/ });
    expect(msk).toHaveTextContent(text.live.backboneDown);
    await waitFor(() => expect(msk).toHaveTextContent(text.nodes.states.down!));
  });
});

describe('что требует внимания', () => {
  it('худшее сверху, спокойная среда — пустой список; стенд и продукт не смешиваются', () => {
    const machines = [
      { id: 'a', role: 'dev+admin' },
      { id: 'meet', role: 'product-core' },
    ];
    const quiet = {
      level: 'ok' as const,
      reason: null,
      since: null,
      problems: [],
      machines: 1,
      online: 1,
    };
    const state = {
      serverTime: 1,
      environments: {
        product: {
          ...quiet,
          level: 'bad' as const,
          problems: [
            {
              level: 'warn' as const,
              kind: 'alert' as const,
              summary: 'steal 12 %',
              machine: 'meet',
              since: null,
            },
            {
              level: 'bad' as const,
              kind: 'core' as const,
              summary: 'Ядро не отвечает',
              machine: 'meet',
              since: null,
            },
          ],
        },
        dev: quiet,
      },
      monitoring: { error: null, alerts: null },
    };
    const job = {
      id: 'j1',
      kind: 'deploy',
      machine: 'meet',
      args: {},
      actor: 'owner',
      dryRun: false,
      status: 'failed' as const,
      createdAt: 1,
      startedAt: 1,
      finishedAt: 2,
      exitCode: 1,
      summary: null,
    };
    expect(attentionOf('dev', state, { ...counts, fresh: 0, breached: 0 }, [job], machines)).toEqual([]);
    const items = attentionOf('product', state, { ...counts, fresh: 2, breached: 1 }, [job], machines);
    expect(items.map((i) => [i.key, i.level])).toEqual([
      ['problem-1', 'bad'],
      ['problem-0', 'warn'],
      ['job-j1', 'warn'],
      ['breached', 'warn'],
      ['fresh', 'note'],
    ]);
    expect(items.find((i) => i.key === 'job-j1')!.to).toBe('/jobs/j1');
    // Сухой прогон и задача стенда в списке продукта не появляются.
    expect(
      attentionOf(
        'product',
        undefined,
        undefined,
        [
          { ...job, dryRun: true },
          { ...job, machine: 'a' },
        ],
        machines,
      ),
    ).toEqual([]);
  });

  it('узел на дренаже — состояние «дренаж», а не «нет связи»', () => {
    const states = nodeStates({
      ...nodes,
      registry: { format: 'nodes/v1', nodes: [{ id: 'hel', enabled: false }] },
    });
    expect(states.get('hel')).toMatchObject({ state: 'drained', enabled: false, title: 'Хельсинки' });
    expect(states.get('msk')?.state).toBe('down');
  });
});

describe('Grafana и знак пульта', () => {
  it('дашборды пульта есть среди собранных дашбордов Grafana', () => {
    const built = readdirSync(join(process.cwd(), '..', 'infra', 'monitoring', 'grafana', 'dashboards')).map(
      (file) =>
        JSON.parse(
          readFileSync(
            join(process.cwd(), '..', 'infra', 'monitoring', 'grafana', 'dashboards', file),
            'utf8',
          ),
        ).uid as string,
    );
    for (const uid of DASHBOARDS) expect(built).toContain(uid);
    expect(dashboardUrl()).toBe('/grafana/d/cord-fleet');
  });

  it('admin.html — свой красный значок, красная полоса браузера и слой пульта с первого кадра', () => {
    const html = readFileSync(join(process.cwd(), 'admin.html'), 'utf8');
    expect(html).toContain('<html lang="ru" data-app="admin">');
    expect(html).toContain('href="/src/admin/icon.svg"');
    expect(html).toContain('href="/src/admin/apple-touch-icon.png"');
    expect(html).not.toContain('href="/favicon.svg"');
    const colors = [...html.matchAll(/name="theme-color"[^>]*content="(#[0-9a-f]{6})"/g)].map((m) => m[1]!);
    expect(colors).toHaveLength(2);
    for (const color of colors) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
      expect(r).toBeGreaterThan(g! * 2);
      expect(r).toBeGreaterThan(b! * 2);
    }
    const icon = readFileSync(join(process.cwd(), 'src', 'admin', 'icon.svg'), 'utf8');
    expect(icon).toContain('fill="#d0233b"');
    expect(icon).not.toContain('#3564f3');
  });
});
