import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminApp, parseRoute } from './AdminApp';
import { FleetError, failureText } from './api';
import { text } from '../i18n/admin/ru';

/**
 * Пульт флота (R207): вход, каркас, обзор и задачи против подменённой службы `fleet`. Проверяется поведение
 * экранов — состояния «пусто/ошибка», заголовок CSRF на изменяющих запросах, плашка исполнителя, а не вид.
 */
type Route = (url: URL, init: RequestInit) => { status: number; body?: unknown };

function serve(routes: Route) {
  const calls: { method: string; path: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers = Object.fromEntries(Object.entries((init.headers as Record<string, string>) ?? {}));
    calls.push({
      method: init.method ?? 'GET',
      path: url.pathname + url.search,
      headers,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const result = routes(url, init);
    if (result.status === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(result.body ?? {}), {
      status: result.status,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
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
    title: 'A',
    role: 'dev+admin',
    host: '127.0.0.1',
    installDir: '/opt/ModernStreamingSystem',
    ssh: false,
    nodeId: 'fra',
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
    core: { url: 'http://127.0.0.1:28080', credential: null },
  },
];
const overview = {
  serverTime: 1,
  machines: [
    {
      ...machines[0],
      metrics: {
        cpu: 0.12,
        steal: 0.01,
        memUsed: 0.4,
        memTotalBytes: 16e9,
        diskFreeBytes: 41e9,
        uplinkMbps: 3,
      },
      status: null,
      now: {
        data: { serverTime: 1, live: 2, waiting: 0, humans: 9, connected: 9, bots: 0, screens: 1, rooms: [] },
        error: null,
      },
      maintenance: { data: { phase: 'none', window: null, closed: null, now: 'x' }, error: null },
    },
    {
      ...machines[1],
      metrics: {
        cpu: null,
        steal: null,
        memUsed: null,
        memTotalBytes: null,
        diskFreeBytes: null,
        uplinkMbps: null,
        error: 'нет',
      },
      status: null,
      now: { data: null, error: { status: 502, code: 'CORE_UNREACHABLE', detail: 'Ядро meet не отвечает' } },
      maintenance: null,
    },
  ],
  alerts: { alerts: [], error: null },
  jobs: [],
  executor: { mode: 'dry-run', sshMachines: [] },
};

let signedIn = false;

function fleetRoutes(url: URL, init: RequestInit): { status: number; body?: unknown } {
  const path = url.pathname;
  if (path === '/api/fleet/auth/login') {
    const body = JSON.parse(String(init.body)) as { password: string; code: string };
    if (body.password === 'secret' && body.code === '123456') {
      signedIn = true;
      return { status: 204 };
    }
    return { status: 401, body: { status: 401, code: 'AUTH_INVALID', detail: 'Неверный пароль или код' } };
  }
  if (!signedIn)
    return { status: 401, body: { status: 401, code: 'AUTH_REQUIRED', detail: 'Войдите в пульт' } };
  if (path === '/api/fleet/auth/me') return { status: 200, body: me };
  if (path === '/api/fleet/auth/logout') {
    signedIn = false;
    return { status: 204 };
  }
  if (path === '/api/fleet/machines') return { status: 200, body: machines };
  if (path === '/api/fleet/overview') return { status: 200, body: overview };
  if (path === '/api/fleet/jobs' && init.method === 'POST')
    return {
      status: 200,
      body: {
        id: 'j1',
        kind: 'deploy',
        machine: 'a',
        args: {},
        actor: 'owner',
        dryRun: true,
        status: 'queued',
        createdAt: 1,
        startedAt: null,
        finishedAt: null,
        exitCode: null,
        summary: null,
      },
    };
  if (path === '/api/fleet/jobs') return { status: 200, body: [] };
  if (path === '/api/fleet/jobs/j1')
    return {
      status: 200,
      body: {
        job: {
          id: 'j1',
          kind: 'deploy',
          machine: 'a',
          args: { services: ['core'] },
          actor: 'owner',
          dryRun: true,
          status: 'ok',
          createdAt: 1,
          startedAt: 1,
          finishedAt: 2,
          exitCode: 0,
          summary: 'Сухой прогон: план показан',
        },
        lines: [
          { n: 1, ts: 1, stream: 'info', text: 'СУХОЙ ПРОГОН' },
          { n: 2, ts: 1, stream: 'plan', text: '1. $ backlog/bin/deploy.sh --drain core' },
        ],
      },
    };
  return { status: 404, body: { status: 404, code: 'NOT_FOUND', detail: path } };
}

describe('пульт флота', () => {
  beforeEach(() => {
    signedIn = false;
    history.replaceState(null, '', '/');
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('маршрут — первый сегмент пути, неизвестный — обзор', () => {
    expect(parseRoute('/')).toEqual({ section: 'overview', rest: [] });
    expect(parseRoute('/jobs/abc')).toEqual({ section: 'jobs', rest: ['abc'] });
    expect(parseRoute('/nope')).toEqual({ section: 'overview', rest: [] });
  });

  it('отказ службы — словами: текст службы, иначе по коду, иначе сеть', () => {
    expect(failureText(new FleetError(409, 'MACHINE_BUSY', 'На машине a уже идёт задача'))).toBe(
      'На машине a уже идёт задача',
    );
    expect(failureText(new FleetError(403, 'FORBIDDEN', ''))).toBe(text.errors.FORBIDDEN);
    expect(failureText(new TypeError('Failed to fetch'))).toBe(text.errors.network);
  });

  it('без сессии — форма входа; неверный код — одна ошибка; верный — обзор с машинами и плашкой исполнителя', async () => {
    const calls = serve(fleetRoutes);
    render(<AdminApp />);
    const password = await screen.findByLabelText(text.login.password);
    fireEvent.change(password, { target: { value: 'secret' } });
    fireEvent.change(screen.getByLabelText(text.login.code), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: text.login.signIn }));
    await screen.findByText('Неверный пароль или код');
    const login = calls.find((c) => c.path === '/api/fleet/auth/login')!;
    expect(login.headers['X-Fleet-Request']).toBe('1');

    fireEvent.change(screen.getByLabelText(text.login.code), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: text.login.signIn }));
    await screen.findByText(text.app.executorDry, {}, { timeout: 10_000 });
    await screen.findAllByText('A', {}, { timeout: 10_000 });
    await screen.findByText('CORE_UNREACHABLE', {}, { timeout: 10_000 });
    expect(screen.getByText('2 встречи · 9 человек')).toBeInTheDocument();
    expect(screen.getByText(text.overview.noJobs)).toBeInTheDocument();
    // Ядро meet не отвечает — обзор говорит «есть проблемы» и ведёт к машине.
    expect(screen.getByRole('heading', { name: text.overview.status.bad })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: new RegExp(`meet: ${text.overview.coreDown}`) })).toHaveAttribute(
      'href',
      '/live#machine-meet',
    );
    // Выбора машины-контекста на обзоре нет: он — у разделов ядра.
    expect(screen.queryByRole('combobox')).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: text.nav.meetings }));
    // Выбор машины-контекста — только машины с учётными данными ядра.
    const picker = await screen.findByRole('combobox', {}, { timeout: 10_000 });
    expect(picker).toHaveDisplayValue('A');
    expect(screen.queryByRole('option', { name: 'meet · cordcam.ru' })).toBeNull();
  });

  it('экран задачи показывает план сухого прогона и опрашивает хвост', async () => {
    signedIn = true;
    history.replaceState(null, '', '/jobs/j1');
    const calls = serve(fleetRoutes);
    render(<AdminApp />);
    await screen.findByText('1. $ backlog/bin/deploy.sh --drain core', {}, { timeout: 10_000 });
    expect(screen.getByText(text.jobs.ok)).toBeInTheDocument();
    expect(screen.getByText(text.jobs.dry)).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/api/fleet/jobs/j1?after=0')).toBe(true);
  });

  it('выход гасит сессию и возвращает форму входа', async () => {
    signedIn = true;
    const calls = serve(fleetRoutes);
    render(<AdminApp />);
    const out = await screen.findByRole('button', { name: text.app.signOut }, { timeout: 10_000 });
    await act(async () => {
      fireEvent.click(out);
    });
    await waitFor(() => expect(screen.getByLabelText(text.login.password)).toBeInTheDocument(), {
      timeout: 10_000,
    });
    expect(calls.find((c) => c.path === '/api/fleet/auth/logout')?.headers['X-Fleet-Request']).toBe('1');
  });

  it('разделы без кода честно говорят, что в разработке', async () => {
    signedIn = true;
    history.replaceState(null, '', '/flags');
    serve(fleetRoutes);
    render(<AdminApp />);
    await screen.findByText(text.later.title, {}, { timeout: 10_000 });
    expect(screen.getByText(text.later.flags)).toBeInTheDocument();
  });
});
