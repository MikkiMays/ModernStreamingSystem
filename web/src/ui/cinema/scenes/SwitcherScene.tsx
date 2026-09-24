import { useEffect, useMemo, type CSSProperties } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Clapperboard, Gamepad2, Radio } from 'lucide-react';
import { CinemaApi, PROVIDERS, SWITCHER_TABS, type CinemaItem, type ProviderId } from '../../../core/cinema';
import { useStore } from '../../primitives';
import { More } from '../catalog/More';
import { Empty, Failure, Loading } from '../catalog/notes';
import { CategoryPage } from '../catalog/pages/CategoryPage';
import { ChannelPage, type ChannelTabSpec } from '../catalog/pages/ChannelPage';
import { ItemPage } from '../catalog/pages/ItemPage';
import { PlaylistPage } from '../catalog/pages/PlaylistPage';
import { Shell } from '../catalog/Shell';
import { CategoryTile, ChannelTile, Grid, PlaylistTile, Tile } from '../catalog/tiles';
import { usePage } from '../catalog/usePage';
import { useKeyed, useStack } from '../catalog/useStack';
import { useTogether } from '../catalog/useTogether';
import type { SceneProps } from '.';

/**
 * Сцена YouTube и Twitch: две площадки одного каталога с переключателем сверху слева.
 *
 * Это прежний каталог кинозала целиком — те же страницы, тексты и поведение; общие части
 * (оболочка, плитки, страницы, стопка) вынесены в `catalog/`, а здесь осталось то, чем YouTube
 * и Twitch отличаются друг от друга: витрина Twitch с эфирами и разделами, подсказки YouTube,
 * вкладки канала и что значит карточка канала на каждой из площадок.
 *
 * Переключение площадки не пересоздаёт сцену: вкладки, поле поиска и фокус на нажатой вкладке
 * остаются теми же элементами, а открытое (стопка, поиск, витрина) принадлежит площадке и в том
 * же кадре начинается с чистого листа (`useKeyed`).
 */

/**
 * С чего начать, когда ещё ничего не набрано.
 *
 * Пустой экран с надписью «наберите название» — это вопрос без подсказки: люди приходят в
 * кинозал не с готовым запросом, а с «давай что-нибудь посмотрим».
 */
const HINTS = ['Фильмы целиком', 'Музыка', 'Подкасты', 'Документальные', 'Стендап', 'Мультфильмы'];

/** Вкладки канала. У YouTube они те же, что на самой площадке; у Twitch их две. */
const TABS: Partial<Record<ProviderId, readonly ChannelTabSpec[]>> = {
  youtube: [
    { id: 'videos', name: 'Видео' },
    { id: 'streams', name: 'Трансляции' },
    { id: 'shorts', name: 'Короткие' },
    { id: 'playlists', name: 'Плейлисты' },
    { id: 'about', name: 'О канале' },
  ],
  twitch: [
    { id: 'videos', name: 'Видео' },
    { id: 'about', name: 'О канале' },
  ],
};

/** Смотрится ли это вместе прямо отсюда, или в это заходят. */
function playable(item: CinemaItem): boolean {
  return item.kind === 'video' || (item.kind === 'channel' && item.provider === 'twitch');
}

export default function SwitcherScene({ provider, meeting, onProvider, onClose }: SceneProps) {
  const api = useMemo(() => new CinemaApi(meeting.admission), [meeting]);
  const watching = !!useStore(meeting.snapshot).watch;
  const { canUse, busy, error, open } = useTogether(meeting);
  const { stack, view, go, back, switchTab, toChannel, home: toHome } = useStack(provider);
  /** Что показывает витрина площадки: живые эфиры или разделы. Только у Twitch. */
  const [shelf, setShelf] = useKeyed<'live' | 'categories'>(provider, 'live');
  const [query, setQuery] = useKeyed(provider, '');
  /** Ищем не на каждую букву: поиск уходит на сервер, а тот — к площадке. */
  const [settled, setSettled] = useKeyed(provider, '');
  useEffect(() => {
    const timer = setTimeout(() => setSettled(query.trim()), 420);
    return () => clearTimeout(timer);
  }, [query, setSettled]);

  const home = view.at === 'home';
  const results = useInfiniteQuery({
    queryKey: ['cinema', 'search', provider, settled],
    queryFn: ({ pageParam, signal }) => api.search(provider, settled, pageParam, signal),
    initialPageParam: '',
    getNextPageParam: (last) => last.next ?? undefined,
    enabled: home && shelf === 'live' && (provider === 'twitch' || settled.length > 1),
    staleTime: 60000,
  });
  const categories = useInfiniteQuery({
    queryKey: ['cinema', 'categories', provider, settled],
    queryFn: ({ pageParam, signal }) => api.categories(provider, settled, pageParam, signal),
    initialPageParam: '',
    getNextPageParam: (last) => last.next ?? undefined,
    enabled: home && shelf === 'categories' && provider === 'twitch',
    staleTime: 60000,
  });
  const page = usePage(api, provider, view);

  /** Куда ведёт карточка: в просмотр её подробностей или внутрь — на канал, в плейлист, в раздел. */
  const enter = (item: CinemaItem) => {
    if (item.kind === 'playlist') return go({ at: 'playlist', id: item.id });
    if (item.kind === 'category') return go({ at: 'category', id: item.id, title: item.title });
    if (item.kind === 'channel' && item.provider === 'youtube')
      return toChannel(String(item.channelId || item.id));
    return go({ at: 'item', item });
  };
  const card = (item: CinemaItem) =>
    item.kind === 'playlist' ? (
      <PlaylistTile key={`playlist:${item.id}`} item={item} onEnter={enter} />
    ) : item.kind === 'category' ? (
      <CategoryTile key={`category:${item.id}`} item={item} onEnter={enter} />
    ) : item.kind === 'channel' && item.provider === 'youtube' ? (
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
        <div className="cinema-services" role="tablist" aria-label="Площадка">
          {SWITCHER_TABS.map((id) => {
            const service = PROVIDERS[id];
            return (
              <button
                key={id}
                role="tab"
                aria-selected={provider === id}
                className="cinema-service"
                data-id={id}
                title={service.hint}
                // Цвет выбранной вкладки — из реестра площадок, той же карточки, что красит и
                // плитку в панели интеграций: CSS больше не хранит вторую копию этих hex-ов.
                style={{ '--accent': service.accent } as CSSProperties}
                onClick={() => onProvider(id)}
              >
                <service.icon size={15} />
                {service.name}
              </button>
            );
          })}
        </div>
      }
      query={query}
      placeholder={PROVIDERS[provider].searchPlaceholder}
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
      {home && (
        <>
          {/* У Twitch каталог начинается не с поиска: там сначала выбирают, что смотрят,
              и только потом — кого. Поэтому разделы стоят рядом с эфирами, а не прячутся. */}
          {provider === 'twitch' && (
            <nav className="cinema-shelves" role="tablist" aria-label="Витрина Twitch">
              <button
                role="tab"
                aria-selected={shelf === 'live'}
                className="cinema-shelf-tab"
                onClick={() => setShelf('live')}
              >
                <Radio size={15} /> Эфиры
              </button>
              <button
                role="tab"
                aria-selected={shelf === 'categories'}
                className="cinema-shelf-tab"
                onClick={() => setShelf('categories')}
              >
                <Gamepad2 size={15} /> Категории
              </button>
            </nav>
          )}

          {shelf === 'categories' && provider === 'twitch' ? (
            <>
              <h4 className="cinema-heading">{settled ? 'Найденные разделы' : 'Популярные разделы'}</h4>
              {categories.isError && <Failure problem={categories.error} />}
              {categories.data && (
                <Grid kind="boxes">{categories.data.pages.flatMap((p) => p.items).map(card)}</Grid>
              )}
              {categories.isFetching && !categories.isFetchingNextPage && <Loading />}
              <More
                shown={!!categories.hasNextPage}
                busy={categories.isFetchingNextPage}
                onMore={() => void categories.fetchNextPage()}
              />
              {categories.data?.pages[0]?.items.length === 0 && !categories.isFetching && (
                <Empty text="Таких разделов на Twitch нет." />
              )}
            </>
          ) : (
            <>
              {provider === 'youtube' && settled.length <= 1 && (
                <div className="cinema-empty">
                  <Clapperboard size={40} />
                  <b>Что включим комнате?</b>
                  <small>Найдётся то же, что и на YouTube: ролик, фильм целиком или канал.</small>
                  <div className="cinema-hints">
                    {HINTS.map((hint) => (
                      <button key={hint} className="cinema-chip-button" onClick={() => setQuery(hint)}>
                        {hint}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {provider === 'twitch' && !settled && <h4 className="cinema-heading">Сейчас в эфире</h4>}
              {/* Полки над лентой: каналы у YouTube, разделы у Twitch. Набрав имя канала,
                  человек ищет сам канал, а не ролики про него — и находит его первым. */}
              {!!results.data?.pages[0]?.channels.length && (
                <>
                  <h4 className="cinema-heading">Каналы</h4>
                  <Grid kind="faces">{results.data.pages[0].channels.map(card)}</Grid>
                  <h4 className="cinema-heading">Видео</h4>
                </>
              )}
              {!!results.data?.pages[0]?.categories.length && (
                <>
                  <h4 className="cinema-heading">Разделы</h4>
                  {/* Полка, а не витрина: обложки здесь мельче и стоят одним рядом. В полный
                      рост они занимали весь первый экран, и найденные каналы — то, за чем
                      сюда и пришли, — оказывались ниже края. */}
                  <div className="cinema-shelf">
                    <Grid kind="boxes">{results.data.pages[0].categories.slice(0, 6).map(card)}</Grid>
                  </div>
                  <h4 className="cinema-heading">Каналы</h4>
                </>
              )}
              {results.isError && <Failure problem={results.error} />}
              {results.data && <Grid>{results.data.pages.flatMap((p) => p.items).map(card)}</Grid>}
              {results.isFetching && !results.isFetchingNextPage && <Loading />}
              <More
                shown={!!results.hasNextPage}
                busy={results.isFetchingNextPage}
                onMore={() => void results.fetchNextPage()}
              />
              {results.data?.pages[0]?.items.length === 0 &&
                !results.data?.pages[0]?.channels.length &&
                !results.data?.pages[0]?.categories.length &&
                !results.isFetching && <Empty text="Ничего не нашлось. Попробуйте другие слова." />}
            </>
          )}
        </>
      )}

      {view.at === 'channel' && (
        <ChannelPage
          person={page.person}
          tabs={TABS[provider] ?? []}
          tab={view.tab}
          onTab={switchTab}
          feed={page.opened}
          items={page.items}
          card={card}
        />
      )}

      {view.at === 'playlist' && (
        <PlaylistPage
          playlist={page.playlist}
          feed={page.opened}
          items={page.items}
          card={card}
          onChannel={toChannel}
        />
      )}

      {view.at === 'category' && (
        <CategoryPage
          category={page.category}
          title={view.title}
          // Разделы в этом каталоге бывают только у Twitch.
          note="Раздел Twitch"
          feed={page.opened}
          items={page.items}
          card={card}
        />
      )}

      {view.at === 'item' && (
        <ItemPage
          item={view.item}
          details={page.details}
          canUse={canUse}
          busy={busy}
          onWatch={open}
          onChannel={toChannel}
        />
      )}
    </Shell>
  );
}
