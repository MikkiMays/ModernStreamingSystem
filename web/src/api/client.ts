import type { Ack, Admission, Attachment, Capabilities, Command, Snapshot } from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
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
    const body = (await response.json().catch(() => ({}))) as { code?: string; detail?: string };
    throw new ApiError(
      response.status,
      body.code ?? 'REQUEST_FAILED',
      body.detail ?? 'Не удалось выполнить запрос',
    );
  }
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}
const post = (data?: unknown): RequestInit => ({
  method: 'POST',
  ...(data ? { body: JSON.stringify(data) } : {}),
});
export const publicApi = {
  capabilities: () => request<Capabilities>('/capabilities'),
  create: (data: {
    commandId: string;
    title: string;
    name: string;
    approvalRequired: boolean;
    integrationsAllowed?: boolean;
  }) => request<Admission>('/rooms', post(data)),
  join: (roomId: string, data: { commandId: string; invite: string; name: string }) =>
    request<Admission>(`/rooms/${roomId}/join`, post(data)),
  joinCode: (data: { commandId: string; code: string; name: string }) =>
    request<Admission>('/rooms/join-by-code', post(data)),
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
  rejoin = (name: string, commandId: string) =>
    request<Admission>(`${this.base}/rejoin`, post({ name, commandId }), this.credential);
  resume = () =>
    request<{ reset: boolean; snapshot: Snapshot | null }>(
      `${this.base}/resume`,
      post({ after: -1 }),
      this.credential,
    );
  command = (command: Command) => request<Ack>(`${this.base}/commands`, post(command), this.credential);
  /** Название и режим входа встречи, которая уже идёт. Только у ведущего. */
  settings = (settings: { title: string; approvalRequired: boolean }) =>
    request<Snapshot>(
      `${this.base}/settings`,
      { method: 'PUT', body: JSON.stringify(settings) },
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
    if (!response.ok) throw new Error('Файл недоступен или срок хранения истёк');
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file.name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}
