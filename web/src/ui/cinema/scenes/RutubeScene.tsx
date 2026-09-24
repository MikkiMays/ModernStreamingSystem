import { useEffect, useMemo, type CSSProperties } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { CinemaApi, PROVIDERS, type CinemaItem } from '../../../core/cinema';
import { useStore } from '../../primitives';
import { More } from '../catalog/More';
import { Empty, Failure, Loading } from '../catalog/notes';
import { ChannelPage, type ChannelTabSpec } from '../catalog/pages/ChannelPage';
import { ItemPage } from '../catalog/pages/ItemPage';
import { SeriesPage } from '../catalog/pages/SeriesPage';
import { Shell } from '../catalog/Shell';
import { Shelf } from '../catalog/Shelf';
import { ChannelTile, Grid, PosterTile, Tile } from '../catalog/tiles';
import { usePage } from '../catalog/usePage';
import { useKeyed, useStack } from '../catalog/useStack';
import { useTogether } from '../catalog/useTogether';
import type { SceneProps } from '.';

/** Вкладки канала Rutube: у площадки нет ни трансляций отдельной лентой, ни плейлистов. */
const TABS: readonly ChannelTabSpec[] = [
  { id: 'videos', name: 'Видео' },
  { id: 'about', name: 'О канале' },
];

/** Смотрится ли это вместе прямо отсюда: ролик или идущий эфир ТВ. Канал автора — дверь. */
function playable(item: CinemaItem): boolean {
  return item.kind === 'video' || (item.kind === 'channel' && item.live);
}

/**
 * Сцена Rutube: эфиры ТВ, сериалы и шоу, разделы площадки и поиск по ней.
 *
 * С ЧЕГО НАЧИНАЕТСЯ. Rutube открывают ради двух вещей, которых нет у YouTube и Twitch: идущего
 * эфира федеральных каналов и сериалов с сезонами. Поэтому витрина — это две полки, эфир первым,
 * и ряд разделов площадки над ними; набранный поиск ищет ролики, каналы и сериалы разом.
 *
 * ЧТО ЗДЕСЬ СВОЁ. Плитки, страницы и стопка — общие (`catalog/`). Своё у Rutube — только то, чем
 * он отличается: карточка канала бывает и идущим эфиром (его включают), и каналом автора (в него
 * заходят), у серии есть сериал, а раздел выбирают кнопкой в ряду, не уходя с витрины.
 *
 * Цвет площадки — только в двух местах: плашка с её именем в полосе и выбранный раздел.
 * Остальное — тот же тёмный каталог, что у YouTube и Twitch: переходя между площадками, человек
 * узнаёт кинозал, а не попадает в чужой сайт.
 */
export default function RutubeScene({ provider, meeting, onClose }: SceneProps) {
  const spec = PROVIDERS[provider];
  const accent = { '--accent': spec.accent } as CSSProperties;
  const api = useMemo(() => new CinemaApi(meeting.admission), [meeting]);
  const watching = !!useStore(meeting.snapshot).watch;
  const { canUse, busy, error, open } = useTogether(meeting);
  const { stack, view, go, back, switchTab, switchSeason, toChannel, home: toHome } = useStack(provider);
  const [query, setQuery] = useKeyed(provider, '');
  /** Ищем не на каждую букву: поиск уходит на сервер, а тот — к площадке. */
  const [settled, setSettled] = useKeyed(provider, '');
  /** Открытый раздел площадки; пусто — витрина. */
  const [section, setSection] = useKeyed(provider, '');
  useEffect(() => {
    const timer = setTimeout(() => setSettled(query.trim()), 420);
    return () => clearTimeout(timer);
  }, [query, setSettled]);

  const home = view.at === 'home';
  const showcase = home && !settled && !section;
  // Пустой запрос у Rutube — это витрина: эфиры лентой и полка «Сериалы и шоу». Она же
  // открывается целиком («Все эфиры»), поэтому запрос один на обе страницы.
  const results = useInfiniteQuery({
    queryKey: ['cinema', 'search', provider, settled],
    queryFn: ({ pageParam, signal }) => api.search(provider, settled, pageParam, signal),
    initialPageParam: '',
    getNextPageParam: (last) => last.next ?? undefined,
    enabled: showcase || (home && !!settled) || view.at === 'shelf',
    staleTime: 60000,
  });
  // Разделы — ряд кнопок, а не лента: их четыре десятка, и площадка отдаёт их разом. Спрашиваются
  // вместе с витриной, а не после неё.
  const sections = useQuery({
    queryKey: ['cinema', 'sections', provider],
    queryFn: ({ signal }) => api.categories(provider, '', '', signal),
    enabled: home,
    staleTime: 3600000,
  });
  const feed = useInfiniteQuery({
    queryKey: ['cinema', 'section', provider, section],
    queryFn: ({ pageParam, signal }) => api.category(provider, section, pageParam, signal),
    initialPageParam: '',
    getNextPageParam: (last) => last.next ?? undefined,
    enabled: home && !settled && !!section,
    staleTime: 60000,
  });
  const page = usePage(api, provider, view);

  const first = results.data?.pages[0];
  const found = results.data?.pages.flatMap((portion) => portion.items) ?? [];
  const shows = first?.series ?? [];
  const inSection = feed.data?.pages.flatMap((portion) => portion.items) ?? [];

  /** Куда ведёт карточка: сериал — на его страницу, канал автора — на канал, остальное — на страницу ролика. */
  const enter = (item: CinemaItem) => {
    if (item.kind === 'series')
      return go({ at: 'series', id: item.id, season: '', title: item.title, poster: item.poster });
    if (item.kind === 'channel' && !item.live) return toChannel(item.id);
    return go({ at: 'item', item });
  };
  const card = (item: CinemaItem) =>
    item.kind === 'series' ? (
      <PosterTile key={`series:${item.id}`} item={item} onEnter={enter} />
    ) : item.kind === 'channel' && !item.live ? (
      <ChannelTile key={`channel:${item.id}`} item={item} onEnter={enter} />
    ) : (
      <Tile
        key={`${item.kind}:${item.id}`}
        item={item}
        playable={playable(item)}
        canUse={canUse}
        busy={busy}
        onWatch={open}
        onEnter={enter}
        onChannel={toChannel}
      />
    );

  return (
    <Shell
      onBack={stack.length > 1 ? back : undefined}
      tabs={
        <span className="cinema-platform" style={accent}>
          <spec.icon size={15} />
          {spec.name}
        </span>
      }
      query={query}
      placeholder={spec.searchPlaceholder}
      onSearch={(value) => {
        setQuery(value);
        if (view.at !== 'home') toHome();
      }}
      onClear={() => setQuery('')}
      watching={watching}
      onClose={onClose}
      locked={!canUse}
      error={error}
    >
      {home && !settled ? (
        <>
          {/* Разделы — вкладками в один ряд над витриной: выбранный раздел заменяет полки своей
              лентой, «Главная» возвращает их, и с витрины при этом никто не уходит. */}
          <nav className="cinema-chips" role="tablist" aria-label="Разделы Rutube" style={accent}>
            <button
              role="tab"
              aria-selected={!section}
              className="cinema-chip-button"
              onClick={() => setSection('')}
            >
              Главная
            </button>
            {(sections.data?.items ?? []).map((entry) => (
              <button
                key={entry.id}
                role="tab"
                aria-selected={section === entry.id}
                className="cinema-chip-button"
                onClick={() => setSection(entry.id)}
              >
                {entry.title}
              </button>
            ))}
          </nav>

          {section ? (
            <>
              {feed.isError ? <Failure problem={feed.error} /> : null}
              <Grid>{inSection.map(card)}</Grid>
              {feed.isFetching && !feed.isFetchingNextPage ? <Loading /> : null}
              <More
                shown={!!feed.hasNextPage}
                busy={feed.isFetchingNextPage}
                onMore={() => void feed.fetchNextPage()}
              />
              {!feed.isFetching && !feed.isError && inSection.length === 0 ? (
                <Empty text="В этом разделе пока нечего показать комнате." />
              ) : null}
            </>
          ) : (
            <>
              {results.isError ? <Failure problem={results.error} /> : null}
              {first?.items.length ? (
                <Shelf
                  title="Прямой эфир"
                  more="Все эфиры"
                  onMore={() => go({ at: 'shelf', id: 'live', title: 'Прямой эфир' })}
                >
                  {first.items.map(card)}
                </Shelf>
              ) : null}
              {shows.length ? (
                <Shelf
                  kind="tall"
                  title="Сериалы и шоу"
                  more="Все сериалы и шоу"
                  onMore={() => go({ at: 'shelf', id: 'shows', title: 'Сериалы и шоу' })}
                >
                  {shows.map(card)}
                </Shelf>
              ) : null}
              {results.isFetching && !results.data ? <Loading /> : null}
            </>
          )}
        </>
      ) : null}

      {home && settled ? (
        <>
          {/* Полки над лентой: набрав имя канала или сериала, ищут сам канал или сериал, а не
              ролики про него, — и находят его первым. */}
          {first?.channels.length ? (
            <>
              <h4 className="cinema-heading">Каналы</h4>
              <Grid kind="faces">{first.channels.map(card)}</Grid>
            </>
          ) : null}
          {shows.length ? (
            <Shelf kind="tall" title="Сериалы и шоу">
              {shows.map(card)}
            </Shelf>
          ) : null}
          {first?.channels.length || shows.length ? <h4 className="cinema-heading">Видео и эфиры</h4> : null}
          {results.isError ? <Failure problem={results.error} /> : null}
          {results.data ? <Grid>{found.map(card)}</Grid> : null}
          {results.isFetching && !results.isFetchingNextPage ? <Loading /> : null}
          <More
            shown={!!results.hasNextPage}
            busy={results.isFetchingNextPage}
            onMore={() => void results.fetchNextPage()}
          />
          {first && !found.length && !first.channels.length && !shows.length && !results.isFetching ? (
            <Empty text="Ничего не нашлось. Попробуйте другие слова." />
          ) : null}
        </>
      ) : null}

      {view.at === 'shelf' ? (
        <>
          <h4 className="cinema-heading">{view.title}</h4>
          {results.isError ? <Failure problem={results.error} /> : null}
          {view.id === 'shows' ? (
            <Grid kind="tall">{shows.map(card)}</Grid>
          ) : (
            <>
              <Grid>{found.map(card)}</Grid>
              <More
                shown={!!results.hasNextPage}
                busy={results.isFetchingNextPage}
                onMore={() => void results.fetchNextPage()}
              />
            </>
          )}
          {results.isFetching && !results.isFetchingNextPage ? <Loading /> : null}
        </>
      ) : null}

      {view.at === 'channel' ? (
        <ChannelPage
          person={page.person}
          tabs={TABS}
          tab={view.tab}
          onTab={switchTab}
          feed={page.opened}
          items={page.items}
          card={card}
        />
      ) : null}

      {view.at === 'series' ? (
        <SeriesPage
          series={page.series}
          title={view.title}
          poster={view.poster}
          season={view.season || page.season}
          onSeason={switchSeason}
          feed={page.opened}
          items={page.items}
          card={card}
          empty="Здесь нечего показать комнате: остальные серии на Rutube — по подписке или недоступны отсюда."
        />
      ) : null}

      {view.at === 'item' ? (
        <ItemPage
          item={view.item}
          details={page.details}
          canUse={canUse}
          busy={busy}
          onWatch={open}
          onChannel={toChannel}
          onSeries={(id) => go({ at: 'series', id, season: '', title: '', poster: null })}
        />
      ) : null}
    </Shell>
  );
}
