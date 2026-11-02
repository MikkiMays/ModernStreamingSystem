import { useEffect, useMemo, type CSSProperties } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  CinemaApi,
  PROVIDERS,
  providerName,
  QUERY_LONGEST,
  regionRefusal,
  type CinemaItem,
} from '../../../core/cinema';
import { linkOf } from '../../../core/cinema/link';
import { useStore } from '../../primitives';
import { More } from '../catalog/More';
import { Empty, Failure, Following, Loading, Region, retryOf, Unreachable } from '../catalog/notes';
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
import { useProviders } from '../useProviders';
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
 * НЕ ИЗ РОССИИ (R172). ivi отдаёт бесплатное только серверу в России. Сервер в другой стране служба
 * узнаёт сама (`geocheck/whoami`) и говорит об этом кодом (`CINEMA_REGION` со страной сервера) — в
 * списке площадок и в отказе на любой вопрос к ivi. Тогда сцена сразу, без «Спрашиваем площадку…»,
 * говорит, в чём дело, и ни витрины, ни поиска не спрашивает: они заведомо пусты, а пустая витрина и
 * «не удалось открыть» на каждом фильме выглядели поломкой. Карточка в панели гаснет с той же причиной;
 * сюда приходят ссылкой или нажав раньше, чем служба ответила. Сервер, который не достаёт до ivi вовсе
 * (`CINEMA_UNREACHABLE`, R112), — как у остальных площадок: блок «недоступен» с «Повторить».
 */
export default function IviScene({ provider, at, meeting, onClose }: SceneProps) {
  const { t } = useTranslation();
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
  /** Что служба сказала об ivi: работает ли она с этого сервера и почему нет. */
  const providers = useProviders(api);
  const down = providers.unreachable(provider);
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
  /**
   * Страна сервера, если ivi с него не работает (`CINEMA_REGION`): по списку площадок — или по отказу
   * любого вопроса, если список ещё не пришёл. Тогда каталог больше ничего не спрашивает.
   */
  const told = providers.region(provider);
  /** Площадка недоступна и ничего не набрано: показывать нечего, спрашивать незачем (как у YouTube). */
  const quiet = told !== null || (down && !settled);
  const results = useInfiniteQuery({
    queryKey: ['cinema', 'search', provider, settled],
    queryFn: ({ pageParam, signal }) => api.search(provider, settled, pageParam, signal),
    initialPageParam: '',
    getNextPageParam: (last) => last.next ?? undefined,
    enabled: home && !!settled && !linked && told === null,
    staleTime: 60000,
  });
  // Три вкладки — тот же общий разбор, что у Rutube и VK: площадка отдаёт их разом и надолго.
  const tabs = useQuery({
    queryKey: ['cinema', 'tabs', provider],
    queryFn: ({ signal }) => api.categories(provider, '', '', signal),
    enabled: home && !quiet,
    staleTime: 3600000,
  });
  const feed = useInfiniteQuery({
    queryKey: ['cinema', 'tab', provider, section],
    queryFn: ({ pageParam, signal }) => api.category(provider, section, pageParam, signal),
    initialPageParam: '',
    getNextPageParam: (last) => last.next ?? undefined,
    enabled: home && !settled && !!section && !quiet,
    staleTime: 60000,
  });
  const page = usePage(api, provider, view);
  /*
    Отказ «только с серверов в России» на любом вопросе — то же, что слово списка площадок: список мог
    ещё не прийти. Отказавший вопрос больше не спрашивается (отказ лежит в его памяти), и сцена так и
    остаётся в этом состоянии, без «Повторить» по кругу.
  */
  const region =
    told ??
    [tabs.error, feed.error, results.error, page.details.error, page.opened.error]
      .map(regionRefusal)
      .find((country) => country !== null) ??
    null;

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
          <spec.icon size={16} />
          {providerName(t, provider)}
        </span>
      }
      query={query}
      placeholder={t(($) => $.cinema.providers[provider].search)}
      maxLength={QUERY_LONGEST}
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
      {region !== null ? <Region name={providerName(t, provider)} country={region} /> : null}

      {region === null && home && down && !settled ? (
        <Unreachable name={providerName(t, provider)} onRetry={providers.refetch} />
      ) : null}

      {region === null && home && linked ? (
        <Following
          checking={!!link.checking}
          problem={link.problem}
          waiting={link.asked !== linkOf(settled)}
          onRetry={() => follow(settled)}
        />
      ) : null}

      {region === null && home && !settled && !down ? (
        <>
          {/* Три раздела — вкладками в один ряд над сеткой, одна остановка Tab на ряд (`Tabs`),
              как «Разделы» у Rutube и VK Видео. Ряд лежит в полосе (`cinema-strip`), не в ленте. */}
          {chips.length ? (
            <div className="cinema-strip">
              <Tabs
                label={t(($) => $.cinema.ivi.sectionsLabel)}
                items={chips}
                selected={section}
                onSelect={setSection}
                className="cinema-chips"
                tabClassName="cinema-chip-button"
                style={accent}
              />
            </div>
          ) : null}
          {feed.isError ? <Failure problem={feed.error} onRetry={retryOf(feed)} /> : null}
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
            <Empty text={t(($) => $.cinema.ivi.emptySection)} />
          ) : null}
        </>
      ) : null}

      {region === null && home && settled && !linked ? (
        <>
          {results.isError ? <Failure problem={results.error} onRetry={retryOf(results)} /> : null}
          {results.data ? <Grid kind="tall">{found.map(card)}</Grid> : null}
          {results.isFetching && !results.isFetchingNextPage ? <Loading /> : null}
          <More
            shown={!!results.hasNextPage}
            busy={results.isFetchingNextPage}
            onMore={() => void results.fetchNextPage()}
          />
          {results.data && !found.length && !results.isFetching ? (
            <Empty text={t(($) => $.cinema.search.nothing)} />
          ) : null}
        </>
      ) : null}

      {region === null && view.at === 'series' ? (
        <SeriesPage
          series={page.series}
          title={view.title}
          poster={view.poster}
          season={view.season || page.season}
          onSeason={switchSeason}
          feed={page.opened}
          items={page.items}
          card={episode}
          empty={t(($) => $.cinema.ivi.seriesEmpty)}
        />
      ) : null}

      {region === null && view.at === 'item' ? (
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
