import { ApiError, request } from '../api/client';
import type { Admission } from '../api/types';
import { t as translate, type Translate } from '../i18n';
import { CATALOG_TIMEOUT } from './cinema/reach';

/** Откуда трек в очереди. YouTube и SoundCloud — площадки без аккаунта (E06-B, T18). */
export type MusicSource = 'upload' | 'telegram' | 'yandex' | 'youtube' | 'soundcloud';
export interface MusicTrack {
  id: string;
  title: string;
  artist: string;
  duration: number;
  addedBy: string;
  source: MusicSource;
  /** Имя обложки у службы (`<uuid>.jpg`) или `null` — обложки нет. */
  cover: string | null;
}
/**
 * Имена источников латиницей — так их пишут на любом языке. Остальные («Аудиофайл», «Яндекс
 * Музыка») — в каталоге (`music.sources`).
 */
const BRANDS: Partial<Record<MusicSource, string>> = {
  telegram: 'Telegram',
  youtube: 'YouTube',
  soundcloud: 'SoundCloud',
};
/** Источник трека словами; незнакомый (новая служба знает больше) — просто «Музыка». */
export function musicSourceName(t: Translate, source: MusicSource): string {
  if (source === 'upload' || source === 'yandex') return t(($) => $.music.sources[source]);
  return BRANDS[source] ?? t(($) => $.music.sources.unknown);
}
/**
 * Адрес обложки. Картинку отдаёт служба со своего адреса и без заголовка входа: `<img>` его не
 * пошлёт, а чужие адреса картинок CSP не пускает.
 */
export function coverUrl(cover: string) {
  return `/api/v1/services/music/covers/${encodeURIComponent(cover)}`;
}
/** Найденный на площадке без аккаунта трек: его добавляют по `url`. */
export interface PlatformTrack {
  url: string;
  title: string;
  artist: string;
  duration: number;
  /** `false` — эфир, фрагмент SoundCloud Go+ или длиннее часа (предел службы, R116): в очередь не добавить. */
  available: boolean;
  source: 'youtube' | 'soundcloud';
}
export interface MusicState {
  roomId: string;
  enabled: boolean;
  paused: boolean;
  position: number;
  revision: number;
  status: 'disabled' | 'connecting' | 'idle' | 'playing' | 'paused' | 'error' | 'starved' | 'reconnecting';
  error: string | null;
  participantId: string | null;
  repeat: boolean;
  queue: MusicTrack[];
  /** Есть ли куда вернуться кнопкой «назад» (`previous`): служба помнит сыгранные треки. */
  previous?: boolean;
}
export interface ServiceCatalog {
  services: { id: string; name: string; description: string }[];
  /** `webapp` — Mini App включён на сервере и бот на связи (E09): витрина открывает Telegram. */
  telegram: { username: string | null; connected: boolean; webapp?: boolean };
  sources: string[];
  /**
   * Источники, до которых этот сервер сейчас не достаёт (R112): поиск и ссылки YouTube идут тем же
   * автоматом площадки, что и кинозал. Служба постарше поля не шлёт — тогда недоступных нет.
   */
  unreachable?: string[];
  maxFileBytes: number;
}
/** Вход из Mini App Telegram: имя из проверенной `initData` и приглашение во встречу беседы. */
export interface TelegramEntry {
  roomId: string;
  title: string;
  name: string;
  inviteUrl: string;
}
/** Код привязки беседы: команда для чата и ссылка «Добавить бота в группу». */
export interface TelegramLinkCode {
  command: string;
  expiresAt: number;
  startgroupUrl: string;
}
/** Беседа, которую встреча открывает кнопкой Mini App. */
export interface TelegramChat {
  id: string;
  chatTitle: string;
  since: number;
  pinned: boolean;
}
export type MusicAction =
  | 'play'
  | 'pause'
  | 'skip'
  | 'previous'
  | 'stop'
  | 'clear'
  | 'shuffle'
  | 'repeat'
  | 'remove'
  | 'next'
  | 'seek'
  | 'move';
const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) });
export const servicesApi = {
  catalog: () => request<ServiceCatalog>('/services/catalog'),
  previewClaim: (token: string) =>
    request<{ roomId: string; title: string; name: string }>('/services/claims/preview', post({ token })),
  redeemClaim: (token: string, name: string, commandId: string) =>
    request<Admission>('/services/claims/redeem', post({ token, name, commandId })),
  /** Без заголовка входа: пропуск здесь — `initData`, подписанная токеном бота. */
  telegramEnter: (initData: string) =>
    request<TelegramEntry>('/services/telegram/webapp/enter', post({ initData })),
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
  command = (
    action: MusicAction,
    extra: { trackId?: string; position?: number; enabled?: boolean; index?: number } = {},
  ) =>
    request<MusicState>(
      `${this.base}/music/commands`,
      post({ commandId: crypto.randomUUID(), action, ...extra }),
      this.admission.credential,
    );
  /**
   * Поиск на площадке без аккаунта: YouTube или SoundCloud. У службы на него жёсткий срок (как у
   * каталога кинозала, R112), браузер ждёт на пять секунд дольше (`CATALOG_TIMEOUT`): дольше ответа
   * уже не будет. Площадку, до которой сервер не достаёт, служба отказывает сразу (`MUSIC_UNREACHABLE`).
   */
  search = (source: PlatformTrack['source'], query: string) =>
    request<PlatformTrack[]>(
      `${this.base}/music/search`,
      { ...post({ source, query }), signal: AbortSignal.timeout(CATALOG_TIMEOUT) },
      this.admission.credential,
    );
  /** Трек по ссылке или из найденного: служба скачивает его и ставит в очередь. */
  addLink = (url: string) =>
    request<MusicState>(
      `${this.base}/music/link`,
      { ...post({ url, commandId: crypto.randomUUID() }), signal: AbortSignal.timeout(180000) },
      this.admission.credential,
    );
  linkTelegram = () =>
    request<TelegramLinkCode>(`${this.base}/telegram/link`, post({}), this.admission.credential);
  telegramChats = () =>
    request<{ links: TelegramChat[] }>(`${this.base}/telegram`, {}, this.admission.credential);
  unlinkTelegram = (id: string) =>
    request<{ links: TelegramChat[] }>(
      `${this.base}/telegram/links/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
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
      throw new ApiError(
        response.status,
        'MUSIC_UPLOAD_FAILED',
        body.detail ?? translate(($) => $.music.upload.failed),
      );
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
  connected?: boolean;
  name?: string | null;
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
  /** Подтвердили — `connected` и токен этому участнику, один раз (R157). */
  poll = (id: string) => this.call<YandexAuthorization | YandexDevicePoll>(`/auth/${id}`, post({}));
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

/** Ответ опроса входа по коду устройства без встречи: ждём — или токен, ровно один раз. */
export type YandexDevicePoll =
  (YandexAuthorization & { status: 'pending' }) | { status: 'connected'; token: string; name: string | null };

/**
 * Вход в Яндекс Музыку по QR без встречи — из «Аккаунтов» настроек (R39, DECISIONS Р-15). Комнаты нет,
 * поэтому и пропуска нет: код живёт на службе, а токен по подтверждении отдаётся этому устройству один
 * раз и на сервере не остаётся — дальше его хранит устройство, как вставленный руками.
 */
export const yandexDeviceApi = {
  start: () => request<YandexAuthorization>('/services/yandex/device', post({})),
  // Служба сама спрашивает Яндекс до 15 с — браузер ждёт дольше обычных восьми.
  poll: (id: string) =>
    request<YandexDevicePoll>(`/services/yandex/device/${encodeURIComponent(id)}`, {
      ...post({}),
      signal: AbortSignal.timeout(20000),
    }),
  cancel: (id: string) =>
    request<{ cancelled: boolean }>(`/services/yandex/device/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
};
