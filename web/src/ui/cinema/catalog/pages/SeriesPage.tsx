import type { ReactNode } from 'react';
import { Clapperboard } from 'lucide-react';
import { plural, type CinemaItem, type CinemaSeriesInfo } from '../../../../core/cinema';
import { More } from '../More';
import { Empty, Failure, Loading } from '../notes';
import { Tabs } from '../Tabs';
import { Grid } from '../tiles';
import type { Feed } from '../usePage';

/**
 * Страница сериала: постер, имя, год и описание, вкладки сезонов и серии открытого сезона.
 *
 * Общая для всех площадок, у которых сериал — это отдельная страница (Rutube, ivi, плейлист «По
 * ссылке»): чем площадка отличается, решает её сцена — какую плитку взять для серии и что
 * сказать, если показать нечего. Сезоны переключаются вкладками, как вкладки канала: это одно
 * и то же движение и одно и то же место на экране. Сезонов бывает и три десятка, поэтому ряд —
 * с одной остановкой Tab и стрелками (`Tabs`).
 */
export function SeriesPage({
  series,
  title,
  poster,
  season,
  onSeason,
  feed,
  items,
  card,
  empty,
}: {
  /** Шапка сериала; пусто, пока площадка её не прислала. */
  series: CinemaSeriesInfo | null;
  /** Имя и постер с карточки, по которой вошли: шапка не ждёт ответа, чтобы назваться. */
  title: string;
  poster: string | null;
  /** Открытый сезон — выбранный руками или тот, что открыла площадка. */
  season: string | null;
  onSeason: (season: string) => void;
  feed: Feed;
  items: CinemaItem[];
  card: (item: CinemaItem) => ReactNode;
  /** Что сказать, если в сезоне нечего показать комнате, — словами площадки. */
  empty: string;
}) {
  const picture = series?.poster ?? poster;
  const seasons = series?.seasons ?? [];
  return (
    <>
      <header className="cinema-detail cinema-detail-tall">
        <div className="cinema-detail-art">
          {picture ? <img src={picture} alt="" /> : <Clapperboard size={34} />}
        </div>
        <div className="cinema-detail-body">
          <h3>{series?.title || title || 'Сериал'}</h3>
          {/* Строка пустой не бывает: у сериала из плейлиста нет ни года, ни сезонов, и пустая
              строка оставила бы в шапке лишний зазор. */}
          {series?.year || seasons.length > 0 ? (
            <p className="cinema-detail-meta">
              {series?.year ? <span>{series.year}</span> : null}
              {seasons.length > 0 ? (
                <span>{plural(seasons.length, 'сезон', 'сезона', 'сезонов')}</span>
              ) : null}
            </p>
          ) : null}
          {series?.description ? <p className="cinema-about">{series.description}</p> : null}
        </div>
      </header>
      {/* Вкладка одна — выбирать не из чего: такой ряд был бы подписью, а не выбором. */}
      {seasons.length > 1 ? (
        <Tabs
          label="Сезоны"
          items={seasons.map((entry) => ({ id: entry.id, name: entry.title }))}
          selected={season ?? ''}
          onSelect={onSeason}
          className="cinema-tabs"
          tabClassName="cinema-tab"
        />
      ) : null}
      {feed.isError ? <Failure problem={feed.error} /> : null}
      <Grid>{items.map(card)}</Grid>
      {feed.isFetching && !feed.isFetchingNextPage ? <Loading /> : null}
      <More
        shown={!!feed.hasNextPage}
        busy={feed.isFetchingNextPage}
        onMore={() => void feed.fetchNextPage()}
      />
      {!feed.isFetching && !feed.isError && items.length === 0 ? <Empty text={empty} /> : null}
    </>
  );
}
