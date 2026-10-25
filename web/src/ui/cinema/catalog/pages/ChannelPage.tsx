import type { ReactNode } from 'react';
import { Tv } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { viewers, type ChannelTab, type CinemaChannel, type CinemaItem } from '../../../../core/cinema';
import { More } from '../More';
import { Empty, Failure, Loading, retryOf } from '../notes';
import { Grid } from '../tiles';
import type { Feed } from '../usePage';

/** Лицо канала: баннер, аватар, имя и одна строка о нём. */
function ChannelHead({ person }: { person: CinemaChannel }) {
  const { t } = useTranslation();
  const followers = viewers(t, person.followers);
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
            <Tv size={24} />
          </span>
        )}
        <div>
          <h3>{person.title}</h3>
          <small>
            {person.handle ? `${person.handle} · ` : ''}
            {followers
              ? t(($) => $.cinema.meta.followers, { value: followers })
              : t(($) => $.cinema.meta.channel)}
            {person.live && person.viewers
              ? ` · ${t(($) => $.cinema.meta.liveWatching, { value: viewers(t, person.viewers) })}`
              : ''}
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
 * Какие вкладки у канала бывают, знает сцена своей площадки — здесь их только рисуют; подписи
 * вкладок — в каталоге (`cinema.channel.tabs`), одни на все площадки.
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
  tabs: readonly ChannelTab[];
  tab: ChannelTab;
  onTab: (tab: ChannelTab) => void;
  feed: Feed;
  items: CinemaItem[];
  card: (item: CinemaItem) => ReactNode;
}) {
  const { t } = useTranslation();
  const followers = person ? viewers(t, person.followers) : null;
  return (
    <>
      {person && <ChannelHead person={person} />}
      <nav className="cinema-tabs" role="tablist" aria-label={t(($) => $.cinema.channel.tabsLabel)}>
        {tabs.map((entry) => (
          <button
            key={entry}
            role="tab"
            aria-selected={tab === entry}
            className="cinema-tab"
            onClick={() => onTab(entry)}
          >
            {t(($) => $.cinema.channel.tabs[entry])}
          </button>
        ))}
      </nav>
      {feed.isError && <Failure problem={feed.error} onRetry={retryOf(feed)} />}
      {tab === 'about' ? (
        person && (
          <div className="cinema-story">
            {person.description ? (
              <p className="cinema-about cinema-about-full">{person.description}</p>
            ) : (
              <Empty text={t(($) => $.cinema.channel.noAbout)} />
            )}
            <p className="cinema-detail-meta">
              {followers && <span>{t(($) => $.cinema.meta.followers, { value: followers })}</span>}
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
                tab === 'playlists' || tab === 'streams' || tab === 'shorts'
                  ? t(($) => $.cinema.channel.empty[tab])
                  : t(($) => $.cinema.channel.empty.other)
              }
            />
          )}
        </>
      )}
    </>
  );
}
