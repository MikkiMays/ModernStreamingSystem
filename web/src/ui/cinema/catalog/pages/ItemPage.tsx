import { Eye, ListVideo, Play, Tv, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { clock, published, viewers, type CinemaDetails, type CinemaItem } from '../../../../core/cinema';
import { Failure, Loading, retryOf } from '../notes';

/**
 * Подробности накрывают карточку из сетки — но только тем, что в них действительно есть.
 *
 * Страница открывается мгновенно с тем, что уже известно из сетки, и дополняется, когда
 * площадка ответит. Простое наложение объектов стирало бы известное пустотой: у карточки
 * живого эфира есть число зрителей, а в подробностях канала на его месте бывает `null`.
 */
export function merge(item: CinemaItem, extra: CinemaDetails | null | undefined): CinemaDetails {
  const filled = Object.fromEntries(
    Object.entries(extra ?? {}).filter(([, value]) => value !== null && value !== undefined),
  );
  return { ...item, ...filled, description: String(filled.description ?? item.description ?? '') };
}

/**
 * Карточка с именем со страницы ролика — если страница уже приехала и она про тот же ролик.
 *
 * Карточка по ссылке знает только номер, и комната иначе увидела бы в «Сейчас смотрим» заглушку
 * «Видео YouTube по ссылке» вместо названия, которое уже стоит на странице.
 */
export function named(item: CinemaItem, details: CinemaDetails | null | undefined): CinemaItem {
  return details && details.id === item.id && details.title ? { ...item, title: details.title } : item;
}

/** Страница ролика или эфира: кадр, всё, что о нём известно, и «Смотреть вместе». */
export function ItemPage({
  item,
  details,
  canUse,
  busy,
  onWatch,
  onChannel,
  onSeries,
}: {
  /** Карточка, по которой вошли: включается комнате именно она, а не её подробности. */
  item: CinemaItem;
  details: {
    data?: CinemaDetails | null;
    isLoading: boolean;
    isError: boolean;
    error: unknown;
    /** Спросить страницу ролика заново — «Повторить» у отказа. */
    refetch?: () => Promise<unknown>;
  };
  canUse: boolean;
  busy: string;
  onWatch: (item: CinemaItem) => void;
  onChannel: (id: string) => void;
  /** Дверь ко всем сериям сериала — у площадок, которые знают, из какого сериала серия. */
  onSeries?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const shown = merge(item, details.data);
  const followers = viewers(t, shown.followers);
  const watching = viewers(t, shown.viewers);
  const views = viewers(t, shown.views);
  const date = published(t, shown.published);
  return (
    <div className="cinema-detail">
      <div className="cinema-detail-art">
        {shown.poster ? <img src={shown.poster} alt="" /> : <Tv size={32} />}
        {shown.live && <span className="cinema-live">{t(($) => $.cinema.meta.live)}</span>}
      </div>
      <div className="cinema-detail-body">
        <h3>{shown.title}</h3>
        <p className="cinema-detail-meta">
          <span>{shown.author}</span>
          {followers && <span>{t(($) => $.cinema.meta.followers, { value: followers })}</span>}
          {watching && (
            <span>
              <Users size={12} /> {t(($) => $.cinema.meta.watching, { value: watching })}
            </span>
          )}
          {views && (
            <span>
              <Eye size={12} /> {t(($) => $.cinema.meta.views, { value: views })}
            </span>
          )}
          {clock(shown.duration) !== '—' && <span>{clock(shown.duration)}</span>}
          {date && <span>{date}</span>}
          {shown.category && <span className="cinema-chip">{shown.category}</span>}
        </p>
        <div className="cinema-detail-actions">
          <button className="button primary" disabled={!canUse || !!busy} onClick={() => void onWatch(item)}>
            <Play size={20} /> {t(($) => $.cinema.item.watch)}
          </button>
          {shown.channelId && (
            <button className="button secondary" onClick={() => onChannel(String(shown.channelId))}>
              <Tv size={20} /> {t(($) => $.cinema.item.openChannel)}
            </button>
          )}
          {shown.series && onSeries ? (
            <button className="button secondary" onClick={() => onSeries(String(shown.series))}>
              <ListVideo size={20} /> {t(($) => $.cinema.item.allEpisodes)}
            </button>
          ) : null}
        </div>
        {details.isLoading && <Loading />}
        {details.isError && <Failure problem={details.error} onRetry={retryOf(details)} />}
        {shown.description && <p className="cinema-about">{shown.description}</p>}
      </div>
    </div>
  );
}
