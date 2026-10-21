import type {
  Ack,
  Admission,
  Attachment,
  Capabilities,
  Command,
  DurakGame,
  PokerGame,
  Snapshot,
} from './types';
import { entryHeaders } from '../core/identity';
import { prepareProof, takeProof, type ProofAction } from '../core/proof';
import { noteError, type SupportReceipt, type SupportTicket } from '../core/support';
import type { Challenge } from '../core/proof-solve';
import { errorText, locale, t } from '../i18n';
import type { CallReport } from '../media/call-quality';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /**
     * Весь ответ отказа (RFC 7807): кроме `code` и `detail` ядро кладёт туда значения, которые
     * интерфейсу нужны не словами, — `roomId` и `title` у `ALREADY_IN_MEETING`, `max` у
     * `FAVORITES_FULL`.
     */
    readonly problem: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
/**
 * Where the server session is kept. `sessionStorage` on purpose: the connection lasts as long
 * as the application is open, and a closed tab is a disconnection.
 */
export const SESSION_KEY = 'cord:session:v1';
let bearer = storedToken();
function storedToken(): string | undefined {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? 'null') as {
      token?: string;
      expiresAt?: number;
    } | null;
    if (saved?.token && (saved.expiresAt ?? 0) > Date.now() / 1000) return saved.token;
  } catch {
    /* Not connected. */
  }
  return undefined;
}
/** Called by `core/session.ts` whenever the held token changes. */
export function useSession(token?: string) {
  bearer = token;
}

/**
 * Отказ сервера словами для человека.
 *
 * Строку `detail` пишут ядро и служба сами — её и показываем (на другом языке — перевод по `code`,
 * `errorText`). Но FastAPI на неверный ввод (запрос
 * длиннее разрешённого, не то число) отвечает 422 со списком ошибок проверки в том же `detail`, и
 * `new Error(массив)` показывал человеку «[object Object]». Такой список — про форму запроса, а не про
 * смысл отказа, поэтому вместо него одна фраза.
 */
function detailOf(detail: unknown): string {
  if (typeof detail === 'string') return detail;
  if (detail === undefined || detail === null) return t(($) => $.api.requestFailed);
  return t(($) => $.errors.INVALID_REQUEST);
}

/**
 * Срок отказа владельца сервера словами и по часам этого устройства — ядро называет его числом:
 * закрытый адрес или устройство (`403 BLOCKED`, E10-B) и встреча, которую он завершил и которую пока
 * не открыть из избранного (`403 CLOSED_BY_SERVER`).
 */
function ownerUntil(code: 'BLOCKED' | 'CLOSED_BY_SERVER', until: number): string {
  const date = new Date(until).toLocaleString(locale(t), {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
  return code === 'BLOCKED'
    ? t(($) => $.api.blockedUntil, { date })
    : t(($) => $.api.closedByServerUntil, { date });
}

export async function request<T>(path: string, init: RequestInit = {}, credential?: string): Promise<T> {
  const send = () =>
    fetch(`/api/v1${path}`, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(8000),
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
        ...(bearer ? { 'X-Cord-Session': bearer } : {}),
        ...init.headers,
      },
    });
  let response = await send();
  // A lapsed server session is not the caller's problem: shake hands again with the password
  // this device already holds and repeat the request once. Only a server whose password we do
  // not have reaches the interface as an error, and even then a meeting in progress stays up.
  if (response.status === 401 && path !== '/session') {
    const body = (await response
      .clone()
      .json()
      .catch(() => ({}))) as { code?: string };
    if (body.code === 'SERVER_PASSWORD_REQUIRED' && (await (await import('../core/session')).renew()))
      response = await send();
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      code?: string;
      detail?: unknown;
      until?: unknown;
    };
    // Код отказа — в последние ошибки для обращения в поддержку; адреса и тексты туда не идут.
    noteError(
      `${response.status} ${body.code ?? 'REQUEST_FAILED'} ${init.method ?? 'GET'} ${path.split('?')[0]!.replace(/[0-9a-f-]{36}/g, ':id')}`,
    );
    throw new ApiError(
      response.status,
      body.code ?? 'REQUEST_FAILED',
      (body.code === 'BLOCKED' || body.code === 'CLOSED_BY_SERVER') && typeof body.until === 'number'
        ? ownerUntil(body.code, body.until)
        : errorText(body.code, detailOf(body.detail)),
      body && typeof body === 'object' ? (body as Record<string, unknown>) : {},
    );
  }
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}
const post = (data?: unknown): RequestInit => ({
  method: 'POST',
  ...(data ? { body: JSON.stringify(data) } : {}),
});
/**
 * Вход во встречу: тело то же, что всегда, плюс профиль устройства и — после «Выйти оттуда и войти
 * сюда» — встреча, которую покидают (`core/identity.ts`, T52).
 */
const entry = (data: unknown, leave?: string): RequestInit => ({
  ...post(data),
  headers: entryHeaders(leave),
});
/** Задача «не бот» с сервера; `undefined` — проверка выключена (`204`). */
const challengeFor = (action: ProofAction) => () => request<Challenge | undefined>(`/proof?for=${action}`);
/** Начать решать задачу «не бот» заранее — как только открыта форма создания или входа по коду. */
export const prepareHuman = (action: ProofAction) => prepareProof(action, challengeFor(action));
/**
 * Вход, который сервер пускает только с ответом на задачу «не бот» (E11-B): создание встречи и вход
 * по коду. Ответ одноразовый и живёт пять минут — устаревший сервер отклоняет `PROOF_INVALID`, и вход
 * повторяется один раз со свежей задачей. Человек видит разве что чуть более долгое «Подключаемся».
 */
async function human<T>(action: ProofAction, path: string, init: RequestInit): Promise<T> {
  const send = async () => {
    const proof = await takeProof(action, challengeFor(action));
    return request<T>(path, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), ...(proof ? { 'X-Cord-Proof': proof } : {}) },
    });
  };
  try {
    return await send();
  } catch (error) {
    if (error instanceof ApiError && error.code === 'PROOF_INVALID') return send();
    throw error;
  }
}
export const publicApi = {
  capabilities: () => request<Capabilities>('/capabilities'),
  create: (
    data: {
      commandId: string;
      title: string;
      name: string;
      approvalRequired: boolean;
      integrationsAllowed?: boolean;
    },
    leave?: string,
  ) => human<Admission>('create', '/rooms', entry(data, leave)),
  join: (roomId: string, data: { commandId: string; invite: string; name: string }, leave?: string) =>
    request<Admission>(`/rooms/${roomId}/join`, entry(data, leave)),
  joinCode: (data: { commandId: string; code: string; name: string }, leave?: string) =>
    human<Admission>('code', '/rooms/join-by-code', entry(data, leave)),
  /** Обращение в поддержку (E13) — за той же задачей «не бот», открыто и до пароля сервера. */
  support: (data: SupportTicket) => human<SupportReceipt>('support', '/support', post(data)),
};
export class RoomApi {
  readonly base: string;
  constructor(readonly admission: Admission) {
    this.base = `/rooms/${admission.roomId}`;
  }
  get credential() {
    return this.admission.credential;
  }
  snapshot = () => request<Snapshot>(this.base, {}, this.credential);
  rejoin = (name: string, commandId: string, leave?: string) =>
    request<Admission>(`${this.base}/rejoin`, entry({ name, commandId }, leave), this.credential);
  resume = () =>
    request<{ reset: boolean; snapshot: Snapshot | null }>(
      `${this.base}/resume`,
      post({ after: -1 }),
      this.credential,
    );
  command = (command: Command) => request<Ack>(`${this.base}/commands`, post(command), this.credential);
  /**
   * Итог звонка для владельца сервера (docs/observability.md §15): шлётся уходя, поэтому `keepalive` —
   * запрос переживёт закрытие вкладки. Один на вход; ответ никому не нужен.
   */
  clientReport = (report: CallReport) =>
    request<void>(`${this.base}/client-report`, { ...post(report), keepalive: true }, this.credential);
  /** Название и режим входа встречи, которая уже идёт. Только у ведущего. */
  settings = (settings: { title: string; approvalRequired: boolean }) =>
    request<Snapshot>(
      `${this.base}/settings`,
      { method: 'PUT', body: JSON.stringify(settings) },
      this.credential,
    );
  /**
   * Кому можно приносить во встречу постороннее. Только у ведущего.
   *
   * Отдельная ручка ядра, а не поле настроек встречи: правило это проверяется на каждую
   * команду интеграции, и жило оно всегда здесь. Спрашивают о нём теперь там же, где о
   * названии и о входе, — в настройках встречи, а не на панели музыки.
   */
  integrations = (enabled: boolean) =>
    request<Snapshot>(
      `${this.base}/integrations`,
      { method: 'PUT', body: JSON.stringify({ enabled }) },
      this.credential,
    );
  token = () =>
    request<{ url: string; token: string; expiresAt: number }>(
      `${this.base}/media/token`,
      post(),
      this.credential,
    );
  screen = (enabled: boolean) =>
    request<Ack>(
      `${this.base}/media/screen`,
      post({ enabled, commandId: crypto.randomUUID() }),
      this.credential,
    );
  /**
   * История игр этой беседы: чем кончилась каждая.
   *
   * Спрашивается по требованию, а не приезжает в снимке: итоги десятка игр — это килобайты
   * таблиц, и пересылать их на каждое чужое повышение незачем.
   */
  games = () => request<PokerGame[]>(`${this.base}/games`, {}, this.credential);

  /** То же для дурака: итоги партий вместе со счётом вечера на их момент. */
  durakGames = () => request<DurakGame[]>(`${this.base}/durak-games`, {}, this.credential);
  files = () => request<Attachment[]>(`${this.base}/attachments`, {}, this.credential);
  reserve = (name: string, size: number, commandId: string) =>
    request<Attachment>(`${this.base}/attachments`, post({ name, size, commandId }), this.credential);
  cancel = (id: string) => request<void>(`/attachments/${id}`, { method: 'DELETE' }, this.credential);
  async download(file: Attachment) {
    const response = await fetch(`/api/v1/attachments/${file.id}/content`, {
      headers: {
        Authorization: `Bearer ${this.credential}`,
        ...(bearer ? { 'X-Cord-Session': bearer } : {}),
      },
    });
    if (!response.ok) throw new Error(t(($) => $.api.fileUnavailable));
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file.name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}
