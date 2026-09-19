import { request } from '../api/client';
import type { Admission } from '../api/types';
import type { WatchProvider } from './watch';

/**
 * Кинотеатр со стороны браузера: каталог, страницы каналов и адрес потока.
 *
 * Ни одного запроса к YouTube или Twitch отсюда не уходит. Поиск, обложки, описания и сам
 * поток идут через `/api/v1/services/rooms/{id}/cinema/...` — то есть через наш сервер,
 * который единственный и ходит наружу. Так это работает и там, где до площадок из браузера не
 * достучаться, и поэтому же строгий CSP остаётся нетронутым: ни чужих скриптов, ни чужих
 * картинок на странице нет.
 */
export interface CinemaItem {
  provider: WatchProvider;
  kind: 'video' | 'channel';
  id: string;
  title: string;
  author: string;
  /** Чей это канал: с ним карточка становится дверью на страницу канала. */
  channelId?: string | null;
  duration: number | null;
  live: boolean;
  /** Смотрят прямо сейчас — у эфира. */
  viewers?: number | null;
  /** Посмотрели всего — у ролика и записи. */
  views?: number | null;
  category?: string | null;
  published?: string | null;
  /** Адрес обложки **у нас**, уже подписанный. */
  poster: string | null;
}

export interface CinemaChannel {
  provider: WatchProvider;
  id: string;
  title: string;
  description: string;
  followers: number | null;
  viewers: number | null;
  live: boolean;
  category: string | null;
  avatar: string | null;
  banner: string | null;
}

export interface CinemaPage {
  channel: CinemaChannel;
  items: CinemaItem[];
}

export interface CinemaDetails extends CinemaItem {
  description: string;
  followers?: number | null;
  channelAvatar?: string | null;
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
  private ask = <T>(path: string, signal?: AbortSignal) =>
    request<T>(`${this.base}${path}`, { signal }, this.admission.credential);
  /** Пустой запрос — это витрина: у Twitch популярные эфиры, у YouTube ничего. */
  search = (provider: WatchProvider, query: string, signal?: AbortSignal) =>
    this.ask<{ items: CinemaItem[] }>(
      `/search?provider=${provider}&query=${encodeURIComponent(query)}`,
      signal,
    ).then((answer) => answer.items);
  channel = (provider: WatchProvider, id: string, signal?: AbortSignal) =>
    this.ask<CinemaPage>(`/channel?provider=${provider}&id=${encodeURIComponent(id)}`, signal);
  details = (provider: WatchProvider, id: string, kind: 'video' | 'channel', signal?: AbortSignal) =>
    this.ask<CinemaDetails>(
      `/details?provider=${provider}&kind=${kind}&id=${encodeURIComponent(id)}`,
      signal,
    );
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

/** `20141110` от YouTube и `2026-09-19` от Twitch — одной строкой для человека. */
export function published(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  if (digits.length < 8) return null;
  const date = new Date(
    Number(digits.slice(0, 4)),
    Number(digits.slice(4, 6)) - 1,
    Number(digits.slice(6, 8)),
  );
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}
