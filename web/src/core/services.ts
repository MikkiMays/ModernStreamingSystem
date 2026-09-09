import { ApiError, request } from '../api/client';
import type { Admission } from '../api/types';

export interface MusicTrack {
  id: string;
  title: string;
  artist: string;
  duration: number;
  addedBy: string;
  source: 'upload' | 'telegram' | 'yandex';
}
export function musicSourceName(source: MusicTrack['source']) {
  return { upload: 'Аудиофайл', telegram: 'Telegram', yandex: 'Яндекс Музыка' }[source];
}
export interface MusicState {
  roomId: string;
  enabled: boolean;
  paused: boolean;
  position: number;
  revision: number;
  status: 'disabled' | 'connecting' | 'idle' | 'playing' | 'paused' | 'error';
  error: string | null;
  participantId: string | null;
  repeat: boolean;
  queue: MusicTrack[];
}
export interface ServiceCatalog {
  services: { id: string; name: string; description: string }[];
  telegram: { username: string | null; connected: boolean };
  sources: string[];
  maxFileBytes: number;
}
export type MusicAction =
  'play' | 'pause' | 'skip' | 'stop' | 'clear' | 'shuffle' | 'repeat' | 'remove' | 'next' | 'seek';
const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) });
export const servicesApi = {
  catalog: () => request<ServiceCatalog>('/services/catalog'),
  previewClaim: (token: string) =>
    request<{ roomId: string; title: string; name: string }>('/services/claims/preview', post({ token })),
  redeemClaim: (token: string, name: string, commandId: string) =>
    request<Admission>('/services/claims/redeem', post({ token, name, commandId })),
};
export class MusicApi {
  private base: string;
  constructor(private admission: Admission) {
    this.base = `/services/rooms/${admission.roomId}`;
  }
  state = () => request<MusicState>(`${this.base}/music`, {}, this.admission.credential);
  enable = () =>
    request<MusicState>(
      `${this.base}/music/enable`,
      post({ commandId: crypto.randomUUID() }),
      this.admission.credential,
    );
  disable = () => request<MusicState>(`${this.base}/music`, { method: 'DELETE' }, this.admission.credential);
  command = (action: MusicAction, extra: { trackId?: string; position?: number; enabled?: boolean } = {}) =>
    request<MusicState>(
      `${this.base}/music/commands`,
      post({ commandId: crypto.randomUUID(), action, ...extra }),
      this.admission.credential,
    );
  permissions = (enabled: boolean) =>
    request(
      `/rooms/${this.admission.roomId}/integrations`,
      { method: 'PUT', body: JSON.stringify({ enabled }) },
      this.admission.credential,
    );
  linkTelegram = () =>
    request<{ command: string; expiresAt: number }>(
      `${this.base}/telegram/link`,
      post({}),
      this.admission.credential,
    );
  async upload(file: File, signal: AbortSignal) {
    const response = await fetch(`/api/v1${this.base}/music/upload/${crypto.randomUUID()}`, {
      method: 'PUT',
      signal,
      body: file,
      headers: {
        Authorization: `Bearer ${this.admission.credential}`,
        'Content-Type': 'application/octet-stream',
        'X-Filename': encodeURIComponent(file.name),
      },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new ApiError(response.status, 'MUSIC_UPLOAD_FAILED', body.detail ?? 'Не удалось добавить трек');
    }
    return response.json() as Promise<MusicState>;
  }
}

export interface YandexAccount {
  connected: boolean;
  name: string | null;
}
export interface YandexAuthorization {
  id: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
  interval: number;
  status: 'pending' | 'connected';
}
export interface YandexTrack {
  id: string;
  title: string;
  artist: string;
  duration: number;
  available: boolean;
}
export class YandexApi {
  private base: string;
  constructor(private admission: Admission) {
    this.base = `/services/rooms/${admission.roomId}/yandex`;
  }
  private call<T>(path: string, init: RequestInit = {}) {
    return request<T>(this.base + path, init, this.admission.credential);
  }
  status = () => this.call<YandexAccount>('');
  start = () => this.call<YandexAuthorization>('/auth', post({}));
  poll = (id: string) => this.call<YandexAuthorization>(`/auth/${id}`, post({}));
  cancel = (id: string) => this.call<void>(`/auth/${id}`, { method: 'DELETE' });
  connectToken = (token: string) => this.call<YandexAccount>('/token', post({ token }));
  disconnect = () => this.call<YandexAccount>('', { method: 'DELETE' });
  search = (query: string) => this.call<YandexTrack[]>('/search', post({ query }));
  enqueue = (trackId: string) =>
    this.call<MusicState>('/queue', {
      ...post({ trackId, commandId: crypto.randomUUID() }),
      signal: AbortSignal.timeout(180000),
    });
}
