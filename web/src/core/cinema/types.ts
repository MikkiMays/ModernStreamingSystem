import type { ProviderId } from './providers';

/**
 * Что бывает в каталоге.
 *
 * `video` смотрят, `channel` у Twitch — это идущий эфир (его тоже смотрят), а `channel` у
 * YouTube, `playlist`, `category` и `series` — двери: в них заходят, а не включают их комнате.
 * У Rutube `channel` бывает и тем и другим: идущий эфир ТВ (`live`) смотрят, канал автора —
 * открывают.
 */
export type CinemaKind = 'video' | 'channel' | 'playlist' | 'category' | 'series';

/** Вкладки страницы канала — те же, что у самой площадки. */
export type ChannelTab = 'videos' | 'streams' | 'shorts' | 'playlists' | 'about';

export interface CinemaItem {
  provider: ProviderId;
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
  /** Короткая подпись на плитке: «3 серия», «Сериал», «Шоу». Есть не у всех площадок. */
  badge?: string;
  /** Форма обложки: кадр 16:9 (по умолчанию) или постер 2:3 — у сериалов и фильмов. */
  shape?: 'wide' | 'tall';
  /** У серии — сериал, из которого она: с ним страница серии становится дверью ко всем сериям. */
  series?: string;
  /** Адрес обложки **у нас**, уже подписанный. */
  poster: string | null;
}

export interface CinemaChannel {
  provider: ProviderId;
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
  provider: ProviderId;
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

/** Поиск: лента находок и полки над ней — каналы у YouTube, разделы у Twitch, сериалы у Rutube. */
export interface CinemaResults extends CinemaPage {
  channels: CinemaItem[];
  categories: CinemaItem[];
  /** Сериалы и шоу постерами — только у площадок, где у сериала своя страница. */
  series?: CinemaItem[];
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

/**
 * Сериал: обложка, описание и список сезонов. Серии самого открытого сезона приезжают тем же
 * конвертом, что и любая другая страница каталога (`items`/`next`).
 */
export interface CinemaSeasonRef {
  id: string;
  title: string;
}
export interface CinemaSeriesInfo {
  id: string;
  title: string;
  poster: string | null;
  description: string | null;
  year: number | null;
  seasons: CinemaSeasonRef[];
}
export interface CinemaSeriesPage extends CinemaPage {
  series: CinemaSeriesInfo;
  /** Какой сезон отдан в `items`; `null`, если у сериала сезонов нет вовсе. */
  season: string | null;
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
  provider: ProviderId;
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

/**
 * На какой странице сцены открывается ссылка: ролик или эфир, канал, плейлист, сериал. Те же
 * страницы, на которые заходят из каталога, — у ссылки своих нет.
 */
export type CinemaPageKind = 'item' | 'channel' | 'playlist' | 'series';

/**
 * Где открыть сцену: страница площадки — по ссылке, вставленной где угодно в кинозале, — или сама
 * ссылка (`page: 'link'`), если своей площадки у неё нет: такую показывает сцена «По ссылке».
 */
export type CinemaAt = { page: CinemaPageKind; kind: CinemaKind; id: string } | { page: 'link'; url: string };

/** Ответ службы на ссылку своей площадки: чья она, что это, номер в её форме и страница сцены. */
export interface CinemaRoute {
  provider: ProviderId;
  kind: CinemaKind;
  id: string;
  page: CinemaPageKind;
}

/** Дорожка звука или субтитров у видео по ссылке — язык и как её назвал сайт. */
export interface CinemaLinkTrack {
  lang: string;
  label: string;
  /** Субтитры распознаны речью, а не написаны автором. */
  auto?: boolean;
}

/**
 * Что нашлось по ссылке без своей площадки (общий путь, задачи 15b и 15c): та же карточка каталога
 * и то, по чему решают, включать ли, — лучшее качество, дорожки звука, субтитры и, если по ссылке
 * плейлист, его серии. Необязательное — потому что не каждый сайт это называет.
 */
export interface CinemaLinkItem extends CinemaItem {
  /** Сайт, откуда видео: `ok.ru`, `dzen.ru`. */
  site?: string | null;
  /** Лучшее качество, как его называют: `1080p`, `4K`. */
  quality?: string | null;
  audio?: CinemaLinkTrack[];
  captions?: CinemaLinkTrack[];
  /** Серии плейлиста — каждая своей карточкой: включают их по одной. */
  episodes?: CinemaItem[];
}

/**
 * Ответ `POST …/cinema/link`: ссылку узнала площадка (`route`) — или нет, и тогда это карточка
 * общего пути либо `null` с причиной словами.
 */
export type CinemaLinkAnswer =
  { route: CinemaRoute } | { route?: undefined; item: CinemaLinkItem | null; reason?: string | null };

/** Что умеет площадка — тем же набором ключей, что и сервис-реестр на стороне службы. */
export interface CinemaProviderFeatures {
  search: boolean;
  channels: boolean;
  playlists: boolean;
  categories: boolean;
  series: boolean;
  live: boolean;
}

/** Нужен ли площадке аккаунт, чтобы отвечать вообще (`none`) или отвечать полнее (`optional`). */
export type CinemaAccountLevel = 'none' | 'optional' | 'required';

/** Строка ответа `GET .../cinema/providers`: включена ли площадка и что у неё есть. */
export interface CinemaProviderStatus {
  id: ProviderId;
  available: boolean;
  reason: string | null;
  account: CinemaAccountLevel;
  connected: boolean;
  features: CinemaProviderFeatures;
}
export interface CinemaProvidersResponse {
  providers: CinemaProviderStatus[];
}
