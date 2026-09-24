import type { ReactNode } from 'react';
import { Eye, ListVideo } from 'lucide-react';
import { published, viewers, type CinemaItem, type CinemaPlaylist } from '../../../../core/cinema';
import { More } from '../More';
import { Empty, Failure, Loading } from '../notes';
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
                  {playlist.author || 'Канал'}
                </button>
              ) : (
                <span>{playlist.author}</span>
              )}
              {playlist.count && <span>{playlist.count} видео</span>}
              {viewers(playlist.views) && (
                <span>
                  <Eye size={12} /> {viewers(playlist.views)} просмотров
                </span>
              )}
              {published(playlist.published) && <span>Обновлён {published(playlist.published)}</span>}
            </p>
            {playlist.description && <p className="cinema-about">{playlist.description}</p>}
          </div>
        </header>
      )}
      {feed.isError && <Failure problem={feed.error} />}
      <Grid>{items.map(card)}</Grid>
      {feed.isFetching && !feed.isFetchingNextPage && <Loading />}
      <More
        shown={!!feed.hasNextPage}
        busy={feed.isFetchingNextPage}
        onMore={() => void feed.fetchNextPage()}
      />
      {!feed.isFetching && items.length === 0 && <Empty text="Плейлист пуст." />}
    </>
  );
}
