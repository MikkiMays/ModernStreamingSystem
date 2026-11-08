import { text } from '../i18n/admin/ru';

/**
 * Запросы к службе `fleet` (`/api/fleet/*`, docs/architecture/admin-panel.md §6.5). Сессия — в
 * `HttpOnly`-куке, браузер шлёт её сам; изменяющие запросы несут `X-Fleet-Request: 1` (CSRF, Р-113).
 * Отказы — RFC 7807 `{status, code, detail}` → `FleetError`.
 */
export class FleetError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly problem: Record<string, unknown> = {},
  ) {
    super(message);
  }

  /** Отказ словами: текст службы, если он есть; иначе — по коду; иначе — общее. */
  get human(): string {
    if (this.message) return this.message;
    return text.errors[this.code] ?? text.errors.generic!;
  }
}

export function failureText(failure: unknown): string {
  if (failure instanceof FleetError) return failure.human;
  if (failure instanceof TypeError) return text.errors.network!;
  return failure instanceof Error && failure.message ? failure.message : text.errors.generic!;
}

const BASE = '/api/fleet';

async function send<T>(
  method: string,
  path: string,
  body?: unknown,
  params?: Record<string, unknown>,
): Promise<T> {
  const url = new URL(BASE + path, location.origin);
  for (const [key, value] of Object.entries(params ?? {}))
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') headers['X-Fleet-Request'] = '1';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  if (response.status === 204) return undefined as T;
  const type = response.headers.get('content-type') ?? '';
  const data: unknown = type.includes('json') ? await response.json() : await response.text();
  if (!response.ok) {
    const problem = (typeof data === 'object' && data ? data : {}) as Record<string, unknown>;
    throw new FleetError(
      response.status,
      String(problem.code ?? 'HTTP_' + response.status),
      typeof problem.detail === 'string' ? problem.detail : '',
      problem,
    );
  }
  return data as T;
}

export const fleet = {
  get: <T>(path: string, params?: Record<string, unknown>) => send<T>('GET', path, undefined, params),
  post: <T>(path: string, body?: unknown) => send<T>('POST', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => send<T>('PUT', path, body ?? {}),
  delete: <T>(path: string) => send<T>('DELETE', path),
};

// ── Типы ответов службы (зеркало `services/fleet/fleet/app.py`) ────────────────────────────────────
export type Me = {
  actor: 'owner' | 'agent';
  since: number | null;
  expiresAt: number | null;
  allowIps: boolean;
  executor: { mode: 'dry-run' | 'ssh'; sshMachines: string[] };
  adminHost: string | null;
  agentOps: string[];
};

export type Machine = {
  id: string;
  title: string;
  role: 'dev+admin' | 'product-core' | 'media-node';
  host: string;
  installDir: string;
  ssh: boolean;
  nodeId: string | null;
  product: string | null;
  core: { url: string; credential: 'password' | 'key' | null } | null;
};

export type Problem = { status: number; code: string; detail: string; [key: string]: unknown };
export type Boxed<T> = { data: T | null; error: Problem | null };

export type Now = {
  serverTime: number;
  live: number;
  waiting: number;
  humans: number;
  connected: number;
  bots: number;
  screens: number;
  rooms: LiveRoom[];
};

export type LiveRoom = {
  id: string;
  code: string;
  createdAt: number;
  startedAt: number | null;
  humans: number;
  connected: number;
  waiting: number;
  bots: number;
  screens: number;
  integrations: string[];
  createdHere: boolean;
  mediaNode?: string | null;
};

export type MaintenanceWindow = {
  id: string;
  kind: string;
  startsAt: string | null;
  endsAt: string | null;
  expiresAt: string | null;
  reason: string | null;
  createdAt: string | null;
  startedAt: string | null;
};

export type MaintenanceStatus = {
  phase: 'none' | 'scheduled' | 'grace' | 'active';
  window: MaintenanceWindow | null;
  closed: 'cancelled' | 'finished' | null;
  now: string;
};

export type MachineMetrics = {
  cpu: number | null;
  steal: number | null;
  memUsed: number | null;
  memTotalBytes: number | null;
  diskFreeBytes: number | null;
  uplinkMbps: number | null;
  error?: string;
};

export type OverviewMachine = Machine & {
  metrics: MachineMetrics;
  status: { lines: string[]; updatedAt: number } | null;
  now: Boxed<Now> | null;
  maintenance: Boxed<MaintenanceStatus> | null;
};

export type Alert = {
  name: string;
  severity: string | null;
  node: string | null;
  state: string;
  activeAt: string | null;
  summary: string | null;
};

export type Job = {
  id: string;
  kind: string;
  machine: string;
  args: Record<string, unknown>;
  actor: string;
  dryRun: boolean;
  status: 'queued' | 'running' | 'ok' | 'failed' | 'cancelled';
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  exitCode: number | null;
  summary: string | null;
};

export type JobLine = { n: number; ts: number; stream: string; text: string };

export type Overview = {
  serverTime: number;
  machines: OverviewMachine[];
  alerts: { alerts: Alert[]; error: string | null };
  jobs: Job[];
  executor: { mode: 'dry-run' | 'ssh'; sshMachines: string[] };
};

export type RegistryNode = {
  id: string;
  control?: boolean;
  ip?: string;
  title?: Record<string, string>;
  country?: string;
  enabled?: boolean;
  maxRooms?: number;
  uplinkMbps?: number;
  cores?: number;
  app?: string;
  rtc?: string;
  turn?: string;
  mode?: string;
  ssh?: string;
};

export type NodeLevel = {
  id: string;
  title: Record<string, string>;
  country: string | null;
  control: boolean;
  level: number;
  state: string;
};

export type NodesView = {
  registry: { format: string; nodes: RegistryNode[] } | null;
  registryError: string | null;
  levels: Boxed<NodeLevel[]>;
};

export type AddServerPlan = {
  fields: Record<string, unknown>;
  dns: { name: string; type: string; value: string; proxied: boolean }[];
  plan: string[];
  installDir: string;
  job: Job | null;
};

export type AuditRow = {
  id: number;
  ts: number;
  actor: string;
  sessionId: string | null;
  ip: string | null;
  action: string;
  target: string | null;
  args: Record<string, unknown> | null;
  outcome: 'ok' | 'refused' | 'failed';
  detail: string | null;
  jobId: string | null;
};

export type Session = {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: number;
  lastSeenAt: number;
  current: boolean;
};

export type Summary = {
  from: number;
  to: number;
  meetings: number;
  humanSeconds: number;
  medianSeconds: number;
  longestSeconds: number;
  peakHumans: number;
  uniqueDevices: number;
  joins: number;
  joinFailures: number;
  days: { day: string; meetings: number; humanSeconds: number; peakHumans: number }[];
};
