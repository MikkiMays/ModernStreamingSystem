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
export async function request<T>(path: string, init: RequestInit = {}, credential?: string): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(8000),
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
      ...init.headers,
    },
  });
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
      headers: { Authorization: `Bearer ${this.credential}` },
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
