import { useEffect, useMemo, type CSSProperties } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { CinemaApi, PROVIDERS, type CinemaItem } from '../../../core/cinema';
import { linkOf } from '../../../core/cinema/link';
import { useStore } from '../../primitives';
import { More } from '../catalog/More';
import { Empty, Failure, Following, Loading } from '../catalog/notes';
import { ItemPage, named } from '../catalog/pages/ItemPage';
import { SeriesPage } from '../catalog/pages/SeriesPage';
import { cardsOf } from '../catalog/cards';
import { Shell } from '../catalog/Shell';
import { Tabs, type TabSpec } from '../catalog/Tabs';
import { Grid, PosterTile, Tile } from '../catalog/tiles';
import { useLink } from '../catalog/useLink';
import { usePage } from '../catalog/usePage';
import { useKeyed, useStack } from '../catalog/useStack';
import { useTogether } from '../catalog/useTogether';
import type { SceneProps } from '.';

/** Открывается ли сцена без набранного раздела: первая вкладка — «Фильмы» (`14` у площадки). */
const FIRST_TAB = '14';

/** Ничего здесь не смотрится прямо с сетки: у ivi нет ни каналов, ни идущих эфиров — только
 *  постеры, которые открывают, — «Смотреть вместе» есть лишь на странице ролика (`ItemPage`). */
function nowhere(): void {}

/**
 * Сцена ivi: фильмы, сериалы и мультфильмы каталогом площадки — только то, что она отдаёт
 * бесплатно.
 *
 * С ЧЕГО НАЧИНАЕТСЯ. У ivi нет ни каналов, ни идущих эфиров — только три раздела (Фильмы, Сериалы,
 * Мультфильмы) и поиск по ним разом. Каждая карточка — постер 2:3, как афиша в кинотеатре: этим
 * ivi и отличается от Rutube и VK Видео, где так выглядит только полка «Сериалы и шоу», а всё
 * остальное — широкий кадр ролика. Разделы — тот же ряд вкладок над сеткой, что у Rutube и VK
 * («Разделы …»), просто их всегда ровно три, и площадка отдаёт их по тем же именам, что и сама
 * называет.
 *
 * ЧТО ЗДЕСЬ СВОЁ. Плитки, страницы и стопка — общие (`catalog/`); постер — везде `PosterTile`,
 * а не только у сериалов. Серия внутри сериала — по-прежнему широкий кадр (`Tile`): у неё свой
 * кадр и длительность, а не постер всего сериала на каждой карточке.
 *
 * Площадка отсюда недоступна не из России (`GET providers`, `available: false`) — карточка в
 * панели интеграций гаснет с этой причиной раньше, чем сцена вообще откроется.
 */
export default function IviScene({ provider, at, meeting, onClose }: SceneProps) {
  const spec = PROVIDERS[provider];
  const accent = { '--accent': spec.accent } as CSSProperties;
  const api = useMemo(() => new CinemaApi(meeting.admission), [meeting]);
  const watching = !!useStore(meeting.snapshot).watch;
  const { canUse, busy, error, open } = useTogether(meeting);
  const { stack, view, go, back, switchSeason, home: toHome } = useStack(provider, at);
  const [query, setQuery] = useKeyed(provider, '');
  /** Ищем не на каждую букву: поиск уходит на сервер, а тот — к площадке. */
  const [settled, setSettled] = useKeyed(provider, '');
  /** Открытый раздел; по умолчанию — «Фильмы», а не пусто: у ivi нет отдельной витрины без него. */
  const [section, setSection] = useKeyed(provider, FIRST_TAB);
  const link = useLink(meeting, api);
  /**
   * Ссылку спрашивают, когда её вставили целиком или открыли Enter, — не на паузу в наборе: каждая
   * пауза была бы разбором чужой страницы. Вставленная — сразу, без паузы поиска.
   */
  const follow = (text: string) => {
    const url = linkOf(text);
    if (!url) return;
    setSettled(text.trim());
    void link.follow(url).then((opened) => opened && setQuery(''));
  };
  useEffect(() => {
    const timer = setTimeout(() => setSettled(query.trim()), 420);
    return () => clearTimeout(timer);
  }, [query, setSettled]);

  const home = view.at === 'home';
  /** Набрана ссылка — не поиск: разделы и поиска в это время нет, пока служба не скажет, куда она ведёт. */
  const linked = !!linkOf(settled);
  const results = useInfiniteQuery({
    queryKey: ['cinema', 'search', provider, settled],
    queryFn: ({ pageParam, signal }) => api.search(provider, settled, pageParam, signal),
    initialPageParam: '',
    getNextPageParam: (last) => last.next ?? undefined,
    enabled: home && !!settled && !linked,
    staleTime: 60000,
  });
  // Три вкладки — тот же общий разбор, что у Rutube и VK: площадка отдаёт их разом и надолго.
  const tabs = useQuery({
    queryKey: ['cinema', 'tabs', provider],
    queryFn: ({ signal }) => api.categories(provider, '', '', signal),
    enabled: home,
    staleTime: 3600000,
  });
  const feed = useInfiniteQuery({
    queryKey: ['cinema', 'tab', provider, section],
    queryFn: ({ pageParam, signal }) => api.category(provider, section, pageParam, signal),
    initialPageParam: '',
    getNextPageParam: (last) => last.next ?? undefined,
    enabled: home && !settled && !!section,
    staleTime: 60000,
  });
  const page = usePage(api, provider, view);

  const found = cardsOf(results.data?.pages);
  const inSection = cardsOf(feed.data?.pages);
  const chips: TabSpec[] = (tabs.data?.items ?? []).map((entry) => ({ id: entry.id, name: entry.title }));

  /** Куда ведёт постер: сериал — на его страницу, фильм или мультфильм — на страницу ролика. */
  const enter = (item: CinemaItem) => {
    if (item.kind === 'series')
      return go({ at: 'series', id: item.id, season: '', title: item.title, poster: item.poster });
    return go({ at: 'item', item });
  };
  /** Витрина и поиск — постерами 2:3: это и есть каталог ivi, а не полка над лентой. */
  const card = (item: CinemaItem) => (
    <PosterTile key={`${item.kind}:${item.id}`} item={item} onEnter={enter} />
  );
  /** Серия внутри сериала — прежним широким кадром: у неё свой кадр, длительность и «Смотреть вместе». */
  const episode = (item: CinemaItem) => (
    <Tile
      key={`${item.kind}:${item.id}`}
      item={item}
      playable
      canUse={canUse}
      busy={busy}
      onWatch={open}
      onEnter={enter}
      onChannel={nowhere}
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
      onSearch={(value, whole) => {
        setQuery(value);
        link.cancel();
        if (view.at !== 'home') toHome();
        if (whole) follow(value);
      }}
      onSubmit={follow}
      onClear={() => setQuery('')}
      watching={watching}
      onClose={onClose}
      locked={!canUse}
      error={error}
    >
      {home && linked ? (
        <Following
          checking={!!link.checking}
          problem={link.problem}
          waiting={link.asked !== linkOf(settled)}
        />
      ) : null}

      {home && !settled ? (
        <>
          {/* Три раздела — вкладками в один ряд над сеткой, одна остановка Tab на ряд (`Tabs`),
              как «Разделы» у Rutube и VK Видео. Ряд лежит в полосе (`cinema-strip`), не в ленте. */}
          {chips.length ? (
            <div className="cinema-strip">
              <Tabs
                label="Разделы ivi"
                items={chips}
                selected={section}
                onSelect={setSection}
                className="cinema-chips"
                tabClassName="cinema-chip-button"
                style={accent}
              />
            </div>
          ) : null}
          {feed.isError ? <Failure problem={feed.error} /> : null}
          <Grid kind="tall">{inSection.map(card)}</Grid>
          {(tabs.isFetching && !tabs.data) || (feed.isFetching && !feed.isFetchingNextPage) ? (
            <Loading />
          ) : null}
          <More
            shown={!!feed.hasNextPage}
            busy={feed.isFetchingNextPage}
            onMore={() => void feed.fetchNextPage()}
          />
          {feed.data && !feed.isFetching && !feed.isError && inSection.length === 0 ? (
            <Empty text="В этом разделе пока нечего показать комнате: отсюда ivi не отдаёт бесплатное." />
          ) : null}
        </>
      ) : null}

      {home && settled && !linked ? (
        <>
          {results.isError ? <Failure problem={results.error} /> : null}
          {results.data ? <Grid kind="tall">{found.map(card)}</Grid> : null}
          {results.isFetching && !results.isFetchingNextPage ? <Loading /> : null}
          <More
            shown={!!results.hasNextPage}
            busy={results.isFetchingNextPage}
            onMore={() => void results.fetchNextPage()}
          />
          {results.data && !found.length && !results.isFetching ? (
            <Empty text="Ничего не нашлось. Попробуйте другие слова." />
          ) : null}
        </>
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
          card={episode}
          empty="Здесь нечего показать комнате: остальные серии на ivi — платные или недоступны отсюда."
        />
      ) : null}

      {view.at === 'item' ? (
        <ItemPage
          item={view.item}
          details={page.details}
          canUse={canUse}
          busy={busy}
          // Страница по ссылке знает только номер: комнате уходит имя со страницы ролика.
          onWatch={view.linked ? (item) => open(named(item, page.details.data)) : open}
          onChannel={nowhere}
          onSeries={(id) => go({ at: 'series', id, season: '', title: '', poster: null })}
        />
      ) : null}
    </Shell>
  );
}
