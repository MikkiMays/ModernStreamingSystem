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
/**
 * Что бывает в каталоге.
 *
 * `video` смотрят, `channel` у Twitch — это идущий эфир (его тоже смотрят), а `channel` у
 * YouTube, `playlist` и `category` — двери: в них заходят, а не включают их комнате.
 */
export type CinemaKind = 'video' | 'channel' | 'playlist' | 'category';

/** Вкладки страницы канала — те же, что у самой площадки. */
export type ChannelTab = 'videos' | 'streams' | 'shorts' | 'playlists' | 'about';

export interface CinemaItem {
  provider: WatchProvider;
  kind: CinemaKind;
  id: string;
  title: string;
  author: string;
  /** Чей это канал: с ним карточка становится дверью на страницу канала. */
  channelId?: string | null;
  duration: number | null;
  live: boolean;
  /** Смотрят прямо сейчас — у эфира и у раздела Twitch. */
  viewers?: number | null;
  /** Посмотрели всего — у ролика и записи. */
  views?: number | null;
  /** Сколько подписано — у карточки канала. */
  followers?: number | null;
  /** Сколько роликов — у плейлиста, когда площадка это сказала. */
  count?: number | null;
  description?: string | null;
  category?: string | null;
  published?: string | null;
  /** Адрес обложки **у нас**, уже подписанный. */
  poster: string | null;
}

export interface CinemaChannel {
  provider: WatchProvider;
  id: string;
  title: string;
  /** `@псевдоним` у YouTube, логин у Twitch — то, по чему канал узнают. */
  handle?: string;
  description: string;
  followers: number | null;
  viewers: number | null;
  live: boolean;
  category: string | null;
  avatar: string | null;
  banner: string | null;
}

export interface CinemaPlaylist {
  provider: WatchProvider;
  kind: 'playlist';
  id: string;
  title: string;
  author: string;
  channelId: string | null;
  description: string;
  count: number | null;
  views: number | null;
  published: string | null;
  poster: string | null;
}

/**
 * Порция каталога.
 *
 * `next` — место, с которого продолжать; его передают обратно, не разбирая. Пусто значит
 * «дальше ничего нет», и именно на это опирается подгрузка по мере прокрутки.
 */
export interface CinemaPage {
  items: CinemaItem[];
  next: string | null;
}

/** Поиск: лента находок и полки над ней — каналы у YouTube, разделы у Twitch. */
export interface CinemaResults extends CinemaPage {
  channels: CinemaItem[];
  categories: CinemaItem[];
}

/** Страница канала. `channel` пуст, когда такой вкладки у канала нет вовсе. */
export interface CinemaChannelPage extends CinemaPage {
  channel: CinemaChannel | null;
}
export interface CinemaPlaylistPage extends CinemaPage {
  playlist: CinemaPlaylist;
}
export interface CinemaCategoryPage extends CinemaPage {
  category: CinemaItem;
}

export interface CinemaDetails extends CinemaItem {
  description: string;
  followers?: number | null;
  channelAvatar?: string | null;
}

/**
 * Дорожка текста, которой в самом потоке нет.
 *
 * В плейлисте YouTube лежат только субтитры, написанные руками; распознанные речью —
 * те, что есть почти у всякого ролика, — площадка отдаёт отдельными файлами, и приносит их
 * наш сервер. Для меню разница между ними — одна подпись, поэтому и приезжают они одинаково.
 */
export interface CinemaCaption {
  /** Код языка, как его называет площадка: `ru`, `en-US`, `zh-Hans`. */
  lang: string;
  /** Как назвала дорожку площадка. Запасное название: обычно оно на английском. */
  label: string;
  /** Распознано речью, а не написано автором. */
  auto: boolean;
  /** Готовый WebVTT **у нас**, уже подписанный. */
  url: string;
}

export interface CinemaSource {
  provider: WatchProvider;
  contentId: string;
  title: string;
  author: string;
  duration: number | null;
  live: boolean;
  /** `hls` — плейлист со всеми уровнями качества; `file` — один готовый файл. */
  kind: 'hls' | 'dash' | 'file';
  url: string;
  expiresAt?: number;
  notice?: string | null;
  /**
   * На каком языке ролик говорит сам.
   *
   * Без этого звуковую дорожку выбрать не из чего: у YouTube в плейлисте **ни одна** из
   * двух десятков озвучек не помечена основной, и плеер берёт первую по коду языка.
   */
  language: string;
  captions: CinemaCaption[];
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
  search = (provider: WatchProvider, query: string, cursor = '', signal?: AbortSignal) =>
    this.ask<CinemaResults>(
      `/search?provider=${provider}&query=${encodeURIComponent(query)}&cursor=${cursor}`,
      signal,
    );
  channel = (
    provider: WatchProvider,
    id: string,
    tab: ChannelTab = 'videos',
    cursor = '',
    signal?: AbortSignal,
  ) =>
    this.ask<CinemaChannelPage>(
      `/channel?provider=${provider}&id=${encodeURIComponent(id)}&tab=${tab}&cursor=${cursor}`,
      signal,
    );
  playlist = (provider: WatchProvider, id: string, cursor = '', signal?: AbortSignal) =>
    this.ask<CinemaPlaylistPage>(
      `/playlist?provider=${provider}&id=${encodeURIComponent(id)}&cursor=${cursor}`,
      signal,
    );
  /** Разделы площадки: у Twitch это игры и рубрики, у YouTube их нет. */
  categories = (provider: WatchProvider, query = '', cursor = '', signal?: AbortSignal) =>
    this.ask<CinemaPage>(
      `/categories?provider=${provider}&query=${encodeURIComponent(query)}&cursor=${cursor}`,
      signal,
    );
  category = (provider: WatchProvider, id: string, cursor = '', signal?: AbortSignal) =>
    this.ask<CinemaCategoryPage>(
      `/category?provider=${provider}&id=${encodeURIComponent(id)}&cursor=${cursor}`,
      signal,
    );
  details = (provider: WatchProvider, id: string, kind: 'video' | 'channel', signal?: AbortSignal) =>
    this.ask<CinemaDetails>(
      `/details?provider=${provider}&kind=${kind}&id=${encodeURIComponent(id)}`,
      signal,
    );
  resolve = (
    provider: WatchProvider,
    contentId: string,
    kind: 'video' | 'channel',
    options: { adaptive?: boolean; refresh?: boolean } = {},
  ) =>
    request<CinemaSource>(
      `${this.base}/resolve`,
      {
        method: 'POST',
        body: JSON.stringify({
          provider,
          contentId,
          kind,
          adaptive: typeof MediaSource !== 'undefined',
          ...options,
        }),
      },
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
