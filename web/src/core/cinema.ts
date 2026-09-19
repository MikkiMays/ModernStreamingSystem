import { request } from '../api/client';
import type { Admission } from '../api/types';
import type { WatchProvider } from './watch';

/**
 * Кинозал со стороны браузера: каталог и адрес потока.
 *
 * Ни одного запроса к YouTube или Twitch отсюда не уходит. Поиск, обложки и сам поток идут
 * через `/api/v1/services/cinema/...` — то есть через наш сервер, который единственный и ходит
 * наружу. Так это работает и там, где до площадок из браузера не достучаться.
 */
export interface CinemaItem {
  provider: WatchProvider;
  kind: 'video' | 'channel';
  id: string;
  title: string;
  author: string;
  duration: number | null;
  live: boolean;
  viewers?: number | null;
  category?: string | null;
  /** Адрес обложки **у нас**, уже подписанный. */
  poster: string | null;
}

export interface CinemaSource {
  provider: WatchProvider;
  contentId: string;
  title: string;
  author: string;
  duration: number | null;
  live: boolean;
  /** `hls` — плейлист со всеми уровнями качества; `file` — один готовый файл. */
  kind: 'hls' | 'file';
  url: string;
  poster: string | null;
}

export class CinemaApi {
  private base: string;
  constructor(private admission: Admission) {
    this.base = `/services/rooms/${admission.roomId}/cinema`;
  }
  /** Пустой запрос — это витрина: у Twitch популярные эфиры, у YouTube ничего. */
  search = (provider: WatchProvider, query: string, signal?: AbortSignal) =>
    request<{ items: CinemaItem[] }>(
      `${this.base}/search?provider=${provider}&query=${encodeURIComponent(query)}`,
      { signal },
      this.admission.credential,
    ).then((answer) => answer.items);
  resolve = (provider: WatchProvider, contentId: string, kind: 'video' | 'channel') =>
    request<CinemaSource>(
      `${this.base}/resolve`,
      { method: 'POST', body: JSON.stringify({ provider, contentId, kind }) },
      this.admission.credential,
    );
}

/** `1:04:12` для часа с лишним, `4:12` для остального. Ноль и пустота — это прочерк. */
export function clock(seconds: number | null | undefined): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return '—';
  const whole = Math.floor(seconds);
  const parts = [Math.floor(whole / 3600), Math.floor((whole % 3600) / 60), whole % 60];
  return parts[0]
    ? `${parts[0]}:${String(parts[1]).padStart(2, '0')}:${String(parts[2]).padStart(2, '0')}`
    : `${parts[1]}:${String(parts[2]).padStart(2, '0')}`;
}

/** «12 тыс.» вместо 12 345: точное число зрителей никому не нужно, а место занимает. */
export function viewers(count: number | null | undefined): string | null {
  if (!count || count < 0) return null;
  if (count < 1000) return `${count}`;
  if (count < 1_000_000) return `${Math.round(count / 100) / 10} тыс.`;
  return `${Math.round(count / 100_000) / 10} млн`;
}
