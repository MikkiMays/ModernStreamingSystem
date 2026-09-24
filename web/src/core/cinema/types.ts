import type { ProviderId } from './providers';

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

/**
 * Сериал: обложка, описание и список сезонов. Серии самого открытого сезона приезжают тем же
 * конвертом, что и любая другая страница каталога (`items`/`next`) — маршрут появится отдельной
 * задачей, здесь только форма ответа, которую уже можно набирать типами.
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
