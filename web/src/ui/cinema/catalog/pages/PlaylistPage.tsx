import type { ReactNode } from 'react';
import { Eye, ListVideo } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { published, viewers, type CinemaItem, type CinemaPlaylist } from '../../../../core/cinema';
import { More } from '../More';
import { Empty, Failure, Loading, retryOf } from '../notes';
import { Grid } from '../tiles';
import type { Feed } from '../usePage';

/** Плейлист: обложка, чей он, сколько в нём и когда обновлялся, — и его ролики лентой. */
export function PlaylistPage({
  playlist,
  feed,
  items,
  card,
  onChannel,
}: {
  /** Шапка плейлиста; пусто, пока площадка её не прислала. */
  playlist: CinemaPlaylist | null;
  feed: Feed;
  items: CinemaItem[];
  card: (item: CinemaItem) => ReactNode;
  onChannel: (id: string) => void;
}) {
  const { t } = useTranslation();
  const views = playlist ? viewers(t, playlist.views) : null;
  const date = playlist ? published(t, playlist.published) : null;
  return (
    <>
      {playlist && (
        <header className="cinema-detail cinema-detail-list">
          <div className="cinema-detail-art">
            {playlist.poster ? <img src={playlist.poster} alt="" /> : <ListVideo size={34} />}
          </div>
          <div className="cinema-detail-body">
            <h3>{playlist.title}</h3>
            <p className="cinema-detail-meta">
              {playlist.channelId ? (
                <button className="cinema-author" onClick={() => onChannel(String(playlist.channelId))}>
                  {playlist.author || t(($) => $.cinema.meta.channel)}
                </button>
              ) : (
                <span>{playlist.author}</span>
              )}
              {playlist.count && <span>{t(($) => $.cinema.meta.videos, { count: playlist.count })}</span>}
              {views && (
                <span>
                  <Eye size={12} /> {t(($) => $.cinema.meta.views, { value: views })}
                </span>
              )}
              {date && <span>{t(($) => $.cinema.meta.updated, { date })}</span>}
            </p>
            {playlist.description && <p className="cinema-about">{playlist.description}</p>}
          </div>
        </header>
      )}
      {feed.isError && <Failure problem={feed.error} onRetry={retryOf(feed)} />}
      <Grid>{items.map(card)}</Grid>
      {feed.isFetching && !feed.isFetchingNextPage && <Loading />}
      <More
        shown={!!feed.hasNextPage}
        busy={feed.isFetchingNextPage}
        onMore={() => void feed.fetchNextPage()}
      />
      {!feed.isFetching && items.length === 0 && <Empty text={t(($) => $.cinema.playlist.empty)} />}
    </>
  );
}
