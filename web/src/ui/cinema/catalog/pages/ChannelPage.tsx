import type { ReactNode } from 'react';
import { Tv } from 'lucide-react';
import { viewers, type ChannelTab, type CinemaChannel, type CinemaItem } from '../../../../core/cinema';
import { More } from '../More';
import { Empty, Failure, Loading } from '../notes';
import { Grid } from '../tiles';
import type { Feed } from '../usePage';

/** Вкладка страницы канала: какая лента за ней и как она называется у самой площадки. */
export interface ChannelTabSpec {
  id: ChannelTab;
  name: string;
}

/** Лицо канала: баннер, аватар, имя и одна строка о нём. */
function ChannelHead({ person }: { person: CinemaChannel }) {
  return (
    <header className="cinema-channel-head">
      {person.banner && (
        <span className="cinema-banner" style={{ backgroundImage: `url(${person.banner})` }} />
      )}
      <div className="cinema-channel-face">
        {person.avatar ? (
          <img className="cinema-avatar" src={person.avatar} alt="" />
        ) : (
          <span className="cinema-avatar cinema-avatar-blank">
            <Tv size={22} />
          </span>
        )}
        <div>
          <h3>{person.title}</h3>
          <small>
            {person.handle ? `${person.handle} · ` : ''}
            {viewers(person.followers) ? `${viewers(person.followers)} подписчиков` : 'Канал'}
            {person.live && person.viewers ? ` · в эфире, ${viewers(person.viewers)} смотрят` : ''}
            {person.category ? ` · ${person.category}` : ''}
          </small>
        </div>
      </div>
    </header>
  );
}

/**
 * Страница канала: шапка, вкладки площадки и лента открытой вкладки (или «О канале»).
 *
 * Какие вкладки у канала бывают, знает сцена своей площадки — здесь их только рисуют.
 */
export function ChannelPage({
  person,
  tabs,
  tab,
  onTab,
  feed,
  items,
  card,
}: {
  /** Шапка канала; пусто, пока площадка её не прислала. */
  person: CinemaChannel | null;
  tabs: readonly ChannelTabSpec[];
  tab: ChannelTab;
  onTab: (tab: ChannelTab) => void;
  feed: Feed;
  items: CinemaItem[];
  card: (item: CinemaItem) => ReactNode;
}) {
  return (
    <>
      {person && <ChannelHead person={person} />}
      <nav className="cinema-tabs" role="tablist" aria-label="Разделы канала">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            role="tab"
            aria-selected={tab === entry.id}
            className="cinema-tab"
            onClick={() => onTab(entry.id)}
          >
            {entry.name}
          </button>
        ))}
      </nav>
      {feed.isError && <Failure problem={feed.error} />}
      {tab === 'about' ? (
        person && (
          <div className="cinema-story">
            {person.description ? (
              <p className="cinema-about cinema-about-full">{person.description}</p>
            ) : (
              <Empty text="Канал ничего о себе не написал." />
            )}
            <p className="cinema-detail-meta">
              {viewers(person.followers) && <span>{viewers(person.followers)} подписчиков</span>}
              {person.handle && <span>{person.handle}</span>}
            </p>
          </div>
        )
      ) : (
        <>
          <Grid>{items.map(card)}</Grid>
          {feed.isFetching && !feed.isFetchingNextPage && <Loading />}
          <More
            shown={!!feed.hasNextPage}
            busy={feed.isFetchingNextPage}
            onMore={() => void feed.fetchNextPage()}
          />
          {!feed.isFetching && items.length === 0 && (
            <Empty
              text={
                tab === 'playlists'
                  ? 'У канала нет плейлистов.'
                  : tab === 'streams'
                    ? 'Канал не ведёт трансляций.'
                    : tab === 'shorts'
                      ? 'Коротких роликов у канала нет.'
                      : 'Здесь пока нечего смотреть.'
              }
            />
          )}
        </>
      )}
    </>
  );
}
