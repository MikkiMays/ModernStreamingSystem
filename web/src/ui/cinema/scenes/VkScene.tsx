import { useEffect, useMemo, type CSSProperties } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link2 } from 'lucide-react';
import { CinemaApi, PROVIDERS, QUERY_LONGEST, type CinemaItem } from '../../../core/cinema';
import { linkOf } from '../../../core/cinema/link';
import { useStore } from '../../primitives';
import { cardsOf } from '../catalog/cards';
import { More } from '../catalog/More';
import { Empty, Failure, Following, Loading } from '../catalog/notes';
import { ChannelPage, type ChannelTabSpec } from '../catalog/pages/ChannelPage';
import { ItemPage, named } from '../catalog/pages/ItemPage';
import { PlaylistPage } from '../catalog/pages/PlaylistPage';
import { Shell } from '../catalog/Shell';
import { Shelf } from '../catalog/Shelf';
import { Tabs } from '../catalog/Tabs';
import { ChannelTile, Grid, PlaylistTile, Tile } from '../catalog/tiles';
import { useLink } from '../catalog/useLink';
import { usePage } from '../catalog/usePage';
import { useKeyed, useStack } from '../catalog/useStack';
import { useTogether } from '../catalog/useTogether';
import type { SceneProps } from '.';

/** Вкладки сообщества VK: его ролики и его плейлисты — то, ради чего на него заходят. */
const TABS: readonly ChannelTabSpec[] = [
  { id: 'videos', name: 'Видео' },
  { id: 'playlists', name: 'Плейлисты' },
];

/** Смотрится ли это вместе прямо отсюда: ролик или идущий эфир. Сообщество и плейлист — двери. */
function playable(item: CinemaItem): boolean {
  return item.kind === 'video' || (item.kind === 'channel' && item.live);
}

/**
 * Сцена VK Видео: разделы площадки, поиск по видео и сообществам, сообщества с плейлистами.
 *
 * С ЧЕГО НАЧИНАЕТСЯ. С разделов самой площадки — ряда кнопок над сеткой роликов, первым в котором
 * стоит её «Все». Какие разделы есть, решает VK по адресу сервера (из Германии нет «Фильмов» и
 * «Сериалов», из России они будут), поэтому здесь ни один не вписан: ряд — ровно то, что она
 * отдала, в её порядке.
 *
 * ССЫЛКА — ТОЖЕ ПОИСК. Каталог VK отвечает только с анонимным токеном, и когда вход или каталог
 * лежат, сцена говорит об этом прямо — а вставленная в поиск ссылка на ролик или эфир всё равно
 * открывает его страницу: ссылку служба узнаёт по самому адресу (`useLink`), а поток разбирает без
 * всякого токена.
 *
 * Плитки, страницы и стопка — общие (`catalog/`); своё у VK — сообщество (в него заходят, в нём
 * вкладки «Видео» и «Плейлисты») и идущий эфир (его включают). Цвет площадки — только на плашке с
 * её именем в полосе и на выбранном разделе, как у Rutube.
 */
export default function VkScene({ provider, at, meeting, onClose }: SceneProps) {
  const spec = PROVIDERS[provider];
  const accent = { '--accent': spec.accent } as CSSProperties;
  const api = useMemo(() => new CinemaApi(meeting.admission), [meeting]);
  const watching = !!useStore(meeting.snapshot).watch;
  const { canUse, busy, error, open } = useTogether(meeting);
  const { stack, view, go, back, switchTab, toChannel, home: toHome } = useStack(provider, at);
  const [query, setQuery] = useKeyed(provider, '');
  /** Ищем не на каждую букву: поиск уходит на сервер, а тот — к площадке. */
  const [settled, setSettled] = useKeyed(provider, '');
  /** Выбранный раздел; пусто — первый, что отдала площадка («Все»). */
  const [section, setSection] = useKeyed(provider, '');
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
  /** Набрана ссылка — не поиск: такой ролик открывается по адресу, куда скажет служба. */
  const linked = !!linkOf(settled);
  const sections = useQuery({
    queryKey: ['cinema', 'sections', provider],
    queryFn: ({ signal }) => api.categories(provider, '', '', signal),
    enabled: home,
    staleTime: 3600000,
  });
  const chips = (sections.data?.items ?? []).map((entry) => ({ id: entry.id, name: entry.title }));
  const opened = section || chips[0]?.id || '';
  const feed = useInfiniteQuery({
    queryKey: ['cinema', 'section', provider, opened],
    queryFn: ({ pageParam, signal }) => api.category(provider, opened, pageParam, signal),
    initialPageParam: '',
    getNextPageParam: (last) => last.next ?? undefined,
    enabled: home && !settled && !!opened,
    staleTime: 60000,
  });
  const results = useInfiniteQuery({
    queryKey: ['cinema', 'search', provider, settled],
    queryFn: ({ pageParam, signal }) => api.search(provider, settled, pageParam, signal),
    initialPageParam: '',
    getNextPageParam: (last) => last.next ?? undefined,
    enabled: home && !!settled && !linked,
    staleTime: 60000,
  });
  const page = usePage(api, provider, view);

  const first = results.data?.pages[0];
  const found = cardsOf(results.data?.pages);
  const inSection = cardsOf(feed.data?.pages);

  /** Куда ведёт карточка: плейлист и сообщество — внутрь, ролик и эфир — на свою страницу. */
  const enter = (item: CinemaItem) => {
    if (item.kind === 'playlist') return go({ at: 'playlist', id: item.id });
    if (item.kind === 'channel' && !item.live) return toChannel(item.id);
    return go({ at: 'item', item });
  };
  /**
   * «Смотреть вместе» — с именем со страницы ролика, если она уже приехала: карточка по ссылке
   * знает только номер, а комната должна увидеть название, а не «Видео VK по ссылке».
   */
  const watch = (item: CinemaItem) => open(named(item, page.details.data));
  const card = (item: CinemaItem) =>
    item.kind === 'playlist' ? (
      <PlaylistTile key={`playlist:${item.id}`} item={item} onEnter={enter} />
    ) : item.kind === 'channel' && !item.live ? (
      <ChannelTile key={`channel:${item.id}`} item={item} onEnter={enter} />
    ) : (
      <Tile
        key={`${item.kind}:${item.id}`}
        item={item}
        playable={playable(item)}
        canUse={canUse}
        busy={busy}
        onWatch={watch}
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
      {home && linked ? (
        <Following
          checking={!!link.checking}
          problem={link.problem}
          waiting={link.asked !== linkOf(settled)}
        />
      ) : null}

      {home && !settled ? (
        <>
          {/* Разделы — вкладками в один ряд над сеткой, одна остановка Tab на ряд (`Tabs`). Ряд
              лежит в полосе (`cinema-strip`), а не прямо в ленте: см. `cinema.css`. */}
          {chips.length ? (
            <div className="cinema-strip">
              <Tabs
                label="Разделы VK Видео"
                items={chips}
                selected={opened}
                onSelect={setSection}
                className="cinema-chips"
                tabClassName="cinema-chip-button"
                style={accent}
              />
            </div>
          ) : null}
          {sections.isError ? (
            <div className="cinema-empty" role="alert">
              <Link2 size={40} />
              <b>Каталог VK Видео сейчас не открывается</b>
              <small>
                {(sections.error as Error).message}. Ролик или эфир VK всё равно откроется по ссылке —
                вставьте её в поиск.
              </small>
            </div>
          ) : null}
          {feed.isError ? <Failure problem={feed.error} /> : null}
          <Grid>{inSection.map(card)}</Grid>
          {(sections.isFetching && !sections.data) || (feed.isFetching && !feed.isFetchingNextPage) ? (
            <Loading />
          ) : null}
          <More
            shown={!!feed.hasNextPage}
            busy={feed.isFetchingNextPage}
            onMore={() => void feed.fetchNextPage()}
          />
          {feed.data && !feed.isFetching && !feed.isError && inSection.length === 0 ? (
            <Empty text="В этом разделе пока нечего показать комнате." />
          ) : null}
        </>
      ) : null}

      {home && settled && !linked ? (
        <>
          {/* Сообщества — полкой над роликами: набрав имя сообщества, ищут его само, а не ролики
              про него, — и находят первым. */}
          {first?.channels.length ? (
            <Shelf kind="faces" title="Сообщества">
              {first.channels.map(card)}
            </Shelf>
          ) : null}
          {first?.channels.length ? <h4 className="cinema-heading">Видео</h4> : null}
          {results.isError ? <Failure problem={results.error} /> : null}
          {results.data ? <Grid>{found.map(card)}</Grid> : null}
          {results.isFetching && !results.isFetchingNextPage ? <Loading /> : null}
          <More
            shown={!!results.hasNextPage}
            busy={results.isFetchingNextPage}
            onMore={() => void results.fetchNextPage()}
          />
          {first && !found.length && !first.channels.length && !results.isFetching ? (
            <Empty text="Ничего не нашлось. Попробуйте другие слова — или вставьте ссылку на ролик VK." />
          ) : null}
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

      {view.at === 'playlist' ? (
        <PlaylistPage
          playlist={page.playlist}
          feed={page.opened}
          items={page.items}
          card={card}
          onChannel={toChannel}
        />
      ) : null}

      {view.at === 'item' ? (
        <ItemPage
          item={view.item}
          details={page.details}
          canUse={canUse}
          busy={busy}
          onWatch={watch}
          onChannel={toChannel}
        />
      ) : null}
    </Shell>
  );
}
