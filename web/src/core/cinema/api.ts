import { request } from '../../api/client';
import type { Admission } from '../../api/types';
import type { ProviderId } from './providers';
import type {
  ChannelTab,
  CinemaCategoryPage,
  CinemaChannelPage,
  CinemaDetails,
  CinemaLinkAnswer,
  CinemaPage,
  CinemaPlaylistPage,
  CinemaProvidersResponse,
  CinemaResults,
  CinemaSeriesPage,
  CinemaSource,
} from './types';

/**
 * Длиннее запросов поиска служба не принимает (`cinema/routes.py`, `query: max_length=120`): такой
 * вопрос получил бы 422. Поле поиска каталога поэтому длиннее и не набирается.
 */
export const QUERY_LONGEST = 120;

/**
 * Кинотеатр со стороны браузера: каталог, страницы каналов и адрес потока.
 *
 * Ни одного запроса к YouTube или Twitch отсюда не уходит. Поиск, обложки, описания и сам
 * поток идут через `/api/v1/services/rooms/{id}/cinema/...` — то есть через наш сервер,
 * который единственный и ходит наружу. Так это работает и там, где до площадок из браузера не
 * достучаться, и поэтому же строгий CSP остаётся нетронутым: ни чужих скриптов, ни чужих
 * картинок на странице нет.
 */
export class CinemaApi {
  private base: string;
  constructor(private admission: Admission) {
    this.base = `/services/rooms/${admission.roomId}/cinema`;
  }
  private ask = <T>(path: string, signal?: AbortSignal) =>
    request<T>(`${this.base}${path}`, { signal }, this.admission.credential);
  /** Какие площадки включены на этой установке и отвечают ли они прямо сейчас. */
  providers = (signal?: AbortSignal) => this.ask<CinemaProvidersResponse>('/providers', signal);
  /** Пустой запрос — это витрина: у Twitch популярные эфиры, у YouTube ничего. */
  search = (provider: ProviderId, query: string, cursor = '', signal?: AbortSignal) =>
    this.ask<CinemaResults>(
      `/search?provider=${provider}&query=${encodeURIComponent(query)}&cursor=${encodeURIComponent(cursor)}`,
      signal,
    );
  channel = (
    provider: ProviderId,
    id: string,
    tab: ChannelTab = 'videos',
    cursor = '',
    signal?: AbortSignal,
  ) =>
    this.ask<CinemaChannelPage>(
      `/channel?provider=${provider}&id=${encodeURIComponent(id)}&tab=${tab}` +
        `&cursor=${encodeURIComponent(cursor)}`,
      signal,
    );
  playlist = (provider: ProviderId, id: string, cursor = '', signal?: AbortSignal) =>
    this.ask<CinemaPlaylistPage>(
      `/playlist?provider=${provider}&id=${encodeURIComponent(id)}&cursor=${encodeURIComponent(cursor)}`,
      signal,
    );
  /** Разделы площадки: у Twitch это игры и рубрики, у YouTube их нет. */
  categories = (provider: ProviderId, query = '', cursor = '', signal?: AbortSignal) =>
    this.ask<CinemaPage>(
      `/categories?provider=${provider}&query=${encodeURIComponent(query)}` +
        `&cursor=${encodeURIComponent(cursor)}`,
      signal,
    );
  category = (provider: ProviderId, id: string, cursor = '', signal?: AbortSignal) =>
    this.ask<CinemaCategoryPage>(
      `/category?provider=${provider}&id=${encodeURIComponent(id)}&cursor=${encodeURIComponent(cursor)}`,
      signal,
    );
  /** Страница сериала: сезоны и серии открытого сезона (пустой сезон — площадка выберет сама). */
  series = (provider: ProviderId, id: string, season = '', cursor = '', signal?: AbortSignal) =>
    this.ask<CinemaSeriesPage>(
      `/series?provider=${provider}&id=${encodeURIComponent(id)}&season=${encodeURIComponent(season)}` +
        `&cursor=${encodeURIComponent(cursor)}`,
      signal,
    );
  details = (provider: ProviderId, id: string, kind: 'video' | 'channel', signal?: AbortSignal) =>
    this.ask<CinemaDetails>(
      `/details?provider=${provider}&kind=${kind}&id=${encodeURIComponent(id)}`,
      signal,
    );
  /**
   * Чья это ссылка и на какой странице её открыть. Телом, а не в адресе запроса: ссылка — ввод
   * человека до двух тысяч знаков, и журналам прокси по дороге её знать незачем.
   */
  link = (url: string, signal?: AbortSignal) =>
    request<CinemaLinkAnswer>(
      `${this.base}/link`,
      { method: 'POST', body: JSON.stringify({ url }), signal },
      this.admission.credential,
    );
  /**
   * Адрес потока.
   *
   * Таймаут свой и длиннее обычных восьми секунд: площадка иногда ещё не разбирала ролик и
   * начинает прямо на этот запрос (`yt-dlp` без кэша), и укладывается не всегда быстро.
   * Восьмисекундный запрос обрывался раньше, чем площадка успевала ответить, — не от сбоя, а
   * просто от настройки, рассчитанной на обычный список или страницу. Страницу «По ссылке» служба
   * разбирает до тридцати секунд (чужой сайт, наш охраняемый выход) — ей срок длиннее.
   */
  resolve = (
    provider: ProviderId,
    contentId: string,
    kind: 'video' | 'channel',
    options: { adaptive?: boolean; refresh?: boolean } = {},
  ) =>
    request<CinemaSource>(
      `${this.base}/resolve`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(provider === 'link' ? 45000 : 20000),
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
