import { Eye, Play, Tv, Users } from 'lucide-react';
import { clock, published, viewers, type CinemaDetails, type CinemaItem } from '../../../../core/cinema';
import { Failure, Loading } from '../notes';

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

/** Страница ролика или эфира: кадр, всё, что о нём известно, и «Смотреть вместе». */
export function ItemPage({
  item,
  details,
  canUse,
  busy,
  onWatch,
  onChannel,
}: {
  /** Карточка, по которой вошли: включается комнате именно она, а не её подробности. */
  item: CinemaItem;
  details: { data?: CinemaDetails | null; isLoading: boolean; isError: boolean; error: unknown };
  canUse: boolean;
  busy: string;
  onWatch: (item: CinemaItem) => void;
  onChannel: (id: string) => void;
}) {
  const shown = merge(item, details.data);
  return (
    <div className="cinema-detail">
      <div className="cinema-detail-art">
        {shown.poster ? <img src={shown.poster} alt="" /> : <Tv size={34} />}
        {shown.live && <span className="cinema-live">В эфире</span>}
      </div>
      <div className="cinema-detail-body">
        <h3>{shown.title}</h3>
        <p className="cinema-detail-meta">
          <span>{shown.author}</span>
          {viewers(shown.followers) && <span>{viewers(shown.followers)} подписчиков</span>}
          {viewers(shown.viewers) && (
            <span>
              <Users size={12} /> {viewers(shown.viewers)} смотрят
            </span>
          )}
          {viewers(shown.views) && (
            <span>
              <Eye size={12} /> {viewers(shown.views)} просмотров
            </span>
          )}
          {clock(shown.duration) !== '—' && <span>{clock(shown.duration)}</span>}
          {published(shown.published) && <span>{published(shown.published)}</span>}
          {shown.category && <span className="cinema-chip">{shown.category}</span>}
        </p>
        <div className="cinema-detail-actions">
          <button className="button primary" disabled={!canUse || !!busy} onClick={() => void onWatch(item)}>
            <Play size={18} /> Смотреть вместе
          </button>
          {shown.channelId && (
            <button className="button secondary" onClick={() => onChannel(String(shown.channelId))}>
              <Tv size={17} /> Открыть канал
            </button>
          )}
        </div>
        {details.isLoading && <Loading />}
        {details.isError && <Failure problem={details.error} />}
        {shown.description && <p className="cinema-about">{shown.description}</p>}
      </div>
    </div>
  );
}
