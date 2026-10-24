import { ApiError, request } from '../api/client';

/**
 * Страница владельца сервера «Активность» (`/activity`, E10-B): вход паролем владельца и запросы к
 * `/api/v1/admin/*` с токеном в `X-Cord-Admin`.
 *
 * Типы — зеркало записей ядра (`ActivityReport`, `Audit`, `Blocks`, `ActivityController`) руками:
 * `generated.ts` перегенерирует интегрирующая сессия, и тогда их можно взять оттуда.
 *
 * Токен — в `sessionStorage`: закрыл вкладку — вышел. Восемь часов — потолок, который ставит ядро.
 */
export const ADMIN_KEY = 'cord:admin:v1';

export type LiveRoom = {
  id: string;
  code: string;
  createdAt: number;
  startedAt: number | null;
  endsAt: number | null;
  humans: number;
  connected: number;
  waiting: number;
  bots: number;
  screens: number;
  integrations: string[];
  approvalRequired: boolean;
  /** Ядро знает адрес создателя — значит, его можно заблокировать. */
  createdHere: boolean;
};

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
  /** Корзины длительности; `upToSeconds: -1` — «дольше последней». */
  durations: { upToSeconds: number; meetings: number }[];
  integrations: Record<string, number>;
  endReasons: Record<string, number>;
};

/** Качество связи за период — итоги звонков от браузеров (`ActivityReport.Quality`, client-report). */
export type Quality = {
  from: number;
  to: number;
  meetings: number;
  reports: number;
  seconds: number;
  rttMs: number | null;
  rttMaxMs: number | null;
  lossPercent: number | null;
  jitterMs: number | null;
  bitrateKbps: number | null;
  freezes: number;
  freezesPerHour: number | null;
  /** Доли от 0 до 1; `null` — итогов нет. */
  lossyShare: number | null;
  relayShare: number | null;
  codecs: Record<string, number>;
  days: { day: string; reports: number; rttMs: number | null; lossPercent: number | null }[];
  recent: {
    code: string | null;
    startedAt: number;
    reports: number;
    rttMs: number | null;
    rttMaxMs: number | null;
    lossPercent: number | null;
    jitterMs: number | null;
    freezes: number;
    relay: boolean;
  }[];
};

export type AuditEvent = {
  id: number;
  at: number;
  action: string;
  outcome: 'ok' | 'denied' | 'error';
  code: string | null;
  roomId: string | null;
  roomCode: string | null;
  targetId: string | null;
  actorKind: string;
  actorId: string | null;
  actorName: string | null;
  ipHash: string | null;
  profileHash: string | null;
  details: Record<string, unknown>;
};

export type AuditPage = { items: AuditEvent[]; next: string | null };

export type AuditFilter = {
  group?: string;
  outcome?: string;
  code?: string;
  cursor?: string;
};

export type Block = {
  id: string;
  kind: 'ip' | 'profile';
  subject: string;
  reason: string | null;
  createdAt: number;
  expiresAt: number;
  createdBy: 'admin' | 'auto';
  liftedAt: number | null;
};

export type ServerInfo = {
  shield: boolean;
  blocksActive: number;
  build: string | null;
  /** Сроки в миллисекундах; `-1` — «никогда». */
  auditMs: number;
  meetingStatsMs: number;
  activityDailyMs: number;
  blockDefaultMs: number;
  autoBlockCount: number | null;
  autoBlockWindowMs: number;
  autoBlockTermMs: number;
};

export type BlockRequest = {
  kind?: 'ip' | 'profile';
  subject?: string;
  roomId?: string;
  memberId?: string;
  term?: string;
  reason?: string;
};

type Session = { token: string; expiresAt: number };

/** Обращение в поддержку (E13) так, как его видит владелец. */
export type SupportStatus = 'NEW' | 'OPEN' | 'DONE';
export type SupportTicket = {
  id: string;
  number: string;
  createdAt: number;
  topic: string;
  message: string;
  contact: string | null;
  diagnostics: string | null;
  /** «Сообщить о проблеме» (R79): что отмечено; у обычного обращения — пусто. */
  issues?: string[];
  status: SupportStatus;
  statusAt: number;
  notifiedAt: number | null;
};

export function adminToken(): string | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(ADMIN_KEY) ?? 'null') as Session | null;
    if (saved?.token && saved.expiresAt > Date.now() / 1000) return saved.token;
  } catch {
    /* Не входили. */
  }
  return null;
}

export function forgetAdmin() {
  try {
    sessionStorage.removeItem(ADMIN_KEY);
  } catch {
    /* Хранилище недоступно — помнить и нечего. */
  }
}

/** Ядро сказало «войдите заново»: токен истёк или пароль владельца сменили. */
export function needsLogin(error: unknown): boolean {
  return error instanceof ApiError && (error.code === 'ADMIN_REQUIRED' || error.status === 401);
}

export async function login(password: string): Promise<void> {
  const session = await request<Session>('/admin/session', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
  try {
    sessionStorage.setItem(ADMIN_KEY, JSON.stringify(session));
  } catch {
    /* Без хранилища вход живёт до перезагрузки — `held` ниже. */
  }
  held = session.token;
}

let held: string | null = null;

function admin<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = adminToken() ?? held ?? '';
  return request<T>(`/admin${path}`, {
    ...init,
    headers: { 'X-Cord-Admin': token },
  });
}

const query = (values: Record<string, string | number | undefined>) =>
  new URLSearchParams(
    Object.entries(values)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => [k, String(v)]),
  ).toString();

export const activityApi = {
  now: () => admin<Now>('/now'),
  meetings: (from: number, to: number) =>
    admin<Summary>(`/meetings?${query({ from, to, tz: -new Date().getTimezoneOffset() })}`),
  quality: (from: number, to: number) =>
    admin<Quality>(`/quality?${query({ from, to, tz: -new Date().getTimezoneOffset() })}`),
  audit: (filter: AuditFilter) =>
    admin<AuditPage>(
      `/audit?${query({ group: filter.group, outcome: filter.outcome, code: filter.code, cursor: filter.cursor })}`,
    ),
  server: () => admin<ServerInfo>('/server'),
  blocks: () => admin<Block[]>('/blocks'),
  block: (body: BlockRequest) => admin<Block[]>('/blocks', { method: 'POST', body: JSON.stringify(body) }),
  lift: (id: string) => admin<void>(`/blocks/${id}`, { method: 'DELETE' }),
  close: (roomId: string, blockCreator: boolean) =>
    admin<Now>(`/rooms/${roomId}/close`, { method: 'POST', body: JSON.stringify({ blockCreator }) }),
  clearShield: () => admin<void>('/shield', { method: 'DELETE' }),
  support: (before?: number) => admin<SupportTicket[]>(`/support?${query({ before })}`),
  supportStatus: (id: string, status: SupportStatus) =>
    admin<void>(`/support/${id}/status`, { method: 'PUT', body: JSON.stringify({ status }) }),
};

/** Слово действия журнала для каталога: точки ключей i18next не любят. */
export const AUDIT_ACTIONS = [
  'room_created',
  'room_closed',
  'participant_joined',
  'participant_removed',
  'attachment_reserved',
  'admin_login',
  'admin_room_closed',
  'admin_shield_cleared',
  'block_created',
  'block_lifted',
  'block_auto',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number] | 'other';

export function actionKey(action: string): AuditAction {
  const key = action.replace('.', '_');
  return (AUDIT_ACTIONS as readonly string[]).includes(key) ? (key as AuditAction) : 'other';
}
