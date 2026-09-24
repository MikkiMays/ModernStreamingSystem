import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  Clapperboard,
  Eye,
  Gamepad2,
  ListVideo,
  LoaderCircle,
  Play,
  Radio,
  Search,
  Tv,
  Users,
  X,
} from 'lucide-react';
import type { Meeting } from '../core/meeting';
import {
  CinemaApi,
  clock,
  PROVIDERS,
  published,
  viewers,
  type ChannelTab,
  type CinemaCategoryPage,
  type CinemaChannel,
  type CinemaChannelPage,
  type CinemaDetails,
  type CinemaItem,
  type CinemaPage,
  type CinemaPlaylistPage,
} from '../core/cinema';
import type { WatchProvider } from '../core/watch';
import { IconButton, useStore } from './primitives';

/**
 * Кинотеатр: каталог площадки на сцене встречи, а не строчка в боковой панели.
 *
 * ПОЧЕМУ НЕ В ПАНЕЛИ. Там он и был: узкая колонка, список в один столбец, обложка размером с
 * ноготь. Выбирают кино глазами — по кадру, по названию, по тому, сколько людей это смотрит
 * прямо сейчас, — и триста пикселей ширины отбирают ровно это. Поэтому выбор площадки сразу
 * открывает зал: широкая сетка, поиск сверху, страница канала и страница видео. Панель
 * интеграций осталась там, где ей и место, — это выключатель, а не витрина.
 *
 * ЧТО ЗДЕСЬ ЧЬЁ. Каталог — личное дело смотрящего: пока один листает, комната продолжает
 * смотреть то, что уже открыто, и звук никуда не девается. Общим становится только нажатие
 * «Смотреть вместе», и это обычная команда комнате.
 *
 * КАК ЗДЕСЬ ХОДЯТ. Стопкой: каждый переход кладётся сверху, «назад» снимает верхнее. Поэтому
 * из плейлиста возвращаются на канал, с канала — в поиск, и ни один переход не уводит из
 * каталога насовсем. Вкладки канала стопку не растят — они меняют верхнее: пять нажатий по
 * вкладкам не должны превращаться в пять нажатий «назад».
 *
 * ОТКУДА ДАННЫЕ. Всё до последней обложки — с нашего сервера: у площадок браузер спросить не
 * может (из сети человека они недоступны), да и не должен — чужие адреса на странице означают
 * дырки в CSP.
 */
const SERVICES: { id: WatchProvider; name: string; hint: string }[] = [
  { id: 'youtube', name: 'YouTube', hint: 'Ролики, фильмы и каналы' },
  { id: 'twitch', name: 'Twitch', hint: 'Живые эфиры и записи' },
];

/**
 * С чего начать, когда ещё ничего не набрано.
 *
 * Пустой экран с надписью «наберите название» — это вопрос без подсказки: люди приходят в
 * кинозал не с готовым запросом, а с «давай что-нибудь посмотрим».
 */
const HINTS = ['Фильмы целиком', 'Музыка', 'Подкасты', 'Документальные', 'Стендап', 'Мультфильмы'];

/** Вкладки канала. У YouTube они те же, что на самой площадке; у Twitch их две. */
const TABS: Record<WatchProvider, { id: ChannelTab; name: string }[]> = {
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

/** Что открыто прямо сейчас. Всё, кроме `home`, — это страница, на которую зашли. */
type View =
  | { at: 'home' }
  | { at: 'channel'; id: string; tab: ChannelTab }
  | { at: 'playlist'; id: string }
  | { at: 'category'; id: string; title: string }
  | { at: 'item'; item: CinemaItem };

/**
 * Любая страница каталога — это лента с продолжением, и отличаются они только шапкой.
 *
 * Поэтому запрос на них один: три отдельных превратились бы в три почти одинаковых хука с
 * одинаковой подгрузкой, одинаковой обработкой ошибки и тремя местами, где её можно забыть.
 */
type Opened = CinemaPage &
  Partial<Pick<CinemaChannelPage, 'channel'>> &
  Partial<Pick<CinemaPlaylistPage, 'playlist'>> &
  Partial<Pick<CinemaCategoryPage, 'category'>>;

/**
 * Подробности накрывают карточку из сетки — но только тем, что в них действительно есть.
 *
 * Страница открывается мгновенно с тем, что уже известно из сетки, и дополняется, когда
 * площадка ответит. Простое наложение объектов стирало бы известное пустотой: у карточки
 * живого эфира есть число зрителей, а в подробностях канала на его месте бывает `null`.
 */
function merge(item: CinemaItem, extra: CinemaDetails | null | undefined): CinemaDetails {
  const filled = Object.fromEntries(
    Object.entries(extra ?? {}).filter(([, value]) => value !== null && value !== undefined),
  );
  return { ...item, ...filled, description: String(filled.description ?? item.description ?? '') };
}

/** Смотрится ли это вместе прямо отсюда, или в это заходят. */
function playable(item: CinemaItem): boolean {
  return item.kind === 'video' || (item.kind === 'channel' && item.provider === 'twitch');
}

/**
 * Конец ленты, который сам просит продолжения.
 *
 * Кнопка настоящая, а не запасная: наблюдатель нажимает её за человека, когда лента доехала
 * до низа, но клавиатура, программа чтения с экрана и браузер без `IntersectionObserver`
 * получают то же самое обычным нажатием. Запас в шесть сотен пикселей — чтобы следующая
 * порция успела приехать до того, как в ленте кончатся карточки.
 */
function More({ shown, busy, onMore }: { shown: boolean; busy: boolean; onMore: () => void }) {
  const [node, setNode] = useState<HTMLButtonElement | null>(null);
  const latest = useRef(onMore);
  latest.current = onMore;
  useEffect(() => {
    if (!node || busy || typeof IntersectionObserver !== 'function') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) latest.current();
      },
      { rootMargin: '600px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, busy]);
  if (!shown) return null;
  return (
    <button ref={setNode} className="cinema-more" disabled={busy} onClick={onMore}>
      {busy ? <LoaderCircle size={17} /> : null}
      {busy ? 'Загружаем…' : 'Показать ещё'}
    </button>
  );
}

export function CinemaBrowser({
  meeting,
  provider,
  onProvider,
  onClose,
  watching,
}: {
  meeting: Meeting;
  provider: WatchProvider;
  onProvider: (provider: WatchProvider) => void;
  onClose: () => void;
  /** Комната уже что-то смотрит: значит, закрытие каталога возвращает к плееру, а не в разговор. */
  watching: boolean;
}) {
  const api = useMemo(() => new CinemaApi(meeting.admission), [meeting]);
  const snapshot = useStore(meeting.snapshot);
  const self = snapshot.participants.find((p) => p.id === meeting.admission.participantId);
  const canUse = !!self && (self.owner || snapshot.integrationsAllowed !== false);
  const [stack, setStack] = useState<View[]>([{ at: 'home' }]);
  const view: View = stack[stack.length - 1] ?? { at: 'home' };
  /** Что показывает витрина площадки: живые эфиры или разделы. Только у Twitch. */
  const [shelf, setShelf] = useState<'live' | 'categories'>('live');
  // Что именно открыто, вынуто из разбора один раз: внутри обработчиков нажатий разбор
  // размеченного типа уже не виден, и каждая кнопка иначе просила бы его заново.
  const channelId = view.at === 'channel' ? view.id : '';
  const channelTab: ChannelTab = view.at === 'channel' ? view.tab : 'videos';
  const item = view.at === 'item' ? view.item : null;
  const [query, setQuery] = useState('');
  /** Ищем не на каждую букву: поиск уходит на сервер, а тот — к площадке. */
  const [settled, setSettled] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setSettled(query.trim()), 420);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    setQuery('');
    setSettled('');
    setShelf('live');
    setStack([{ at: 'home' }]);
  }, [provider]);

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
  /** Адрес открытой страницы одной строкой: он же и ключ её запроса. */
  const address =
    view.at === 'channel'
      ? `channel:${view.id}:${view.tab}`
      : view.at === 'playlist'
        ? `playlist:${view.id}`
        : view.at === 'category'
          ? `category:${view.id}`
          : '';
  const opened = useInfiniteQuery({
    queryKey: ['cinema', 'page', provider, address],
    queryFn: ({ pageParam, signal }): Promise<Opened> => {
      if (view.at === 'channel') return api.channel(provider, view.id, view.tab, pageParam, signal);
      if (view.at === 'playlist') return api.playlist(provider, view.id, pageParam, signal);
      if (view.at === 'category') return api.category(provider, view.id, pageParam, signal);
      return Promise.resolve({ items: [], next: null });
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.next ?? undefined,
    enabled: !!address,
    // Лента канала начинается со свежего, и «свежее» не должно означать «свежее полчаса
    // назад»: возвращаясь на канал, человек видит сохранённое сразу, а следом — настоящее.
    staleTime: 0,
  });
  const details = useQuery({
    queryKey: ['cinema', 'item', provider, item ? `${item.kind}:${item.id}` : ''],
    queryFn: ({ signal }) =>
      item && (item.kind === 'video' || item.kind === 'channel')
        ? api.details(provider, item.id, item.kind, signal)
        : null,
    enabled: !!item,
    staleTime: 300000,
  });

  const pages = opened.data?.pages ?? [];
  const list = pages.flatMap((page) => page.items);
  const playlist = pages.find((page) => page.playlist)?.playlist ?? null;
  const category = pages.find((page) => page.category)?.category ?? null;
  /**
   * Шапка канала переживает вкладку, на которой её не отдали.
   *
   * Вкладки у канала бывают не все: у кого-то нет трансляций, у кого-то коротких роликов, и
   * площадка отвечает на такую вкладку отказом. Без этой памяти нажатие по пустой вкладке
   * стирало бы с экрана и лицо канала, и его имя — как будто ушли не на вкладку, а в никуда.
   */
  const [known, setKnown] = useState<{ id: string; channel: CinemaChannel } | null>(null);
  const fresh = pages.find((page) => page.channel)?.channel ?? null;
  useEffect(() => {
    if (fresh) setKnown({ id: channelId, channel: fresh });
  }, [fresh, channelId]);
  const person = fresh ?? (known?.id === channelId ? known.channel : null);

  const shown = item ? merge(item, details.data) : null;

  const open = async (item: CinemaItem) => {
    if (!canUse) return;
    setBusy(item.id);
    setError('');
    try {
      await meeting.command('watch.open', item.title, undefined, {
        provider: item.provider,
        kind: item.kind === 'channel' ? 'channel' : 'video',
        contentId: item.id,
      });
      // Включили — значит, смотреть, а не листать дальше: каталог уходит, зал остаётся.
      meeting.openCinema(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const go = (next: View) => setStack((current) => [...current, next]);
  const back = () => setStack((current) => (current.length > 1 ? current.slice(0, -1) : current));
  /** Вкладка канала меняет открытое, а не кладётся сверху. */
  const switchTab = (tab: ChannelTab) =>
    setStack((current) =>
      current.map((entry, index) =>
        index === current.length - 1 && entry.at === 'channel' ? { ...entry, tab } : entry,
      ),
    );
  const toChannel = useCallback(
    (id: string) => setStack((current) => [...current, { at: 'channel', id, tab: 'videos' }]),
    [],
  );
  /** Куда ведёт карточка: в просмотр её подробностей или внутрь — на канал, в плейлист, в раздел. */
  const enter = (item: CinemaItem) => {
    if (item.kind === 'playlist') return go({ at: 'playlist', id: item.id });
    if (item.kind === 'category') return go({ at: 'category', id: item.id, title: item.title });
    if (item.kind === 'channel' && item.provider === 'youtube')
      return toChannel(String(item.channelId || item.id));
    return go({ at: 'item', item });
  };

  const tile = (item: CinemaItem) => (
    <article className="cinema-tile" key={`${item.kind}:${item.id}`}>
      <span className="cinema-poster">
        {item.poster ? <img src={item.poster} alt="" loading="lazy" /> : <Tv size={26} />}
        {item.live ? (
          <span className="cinema-live">В эфире</span>
        ) : (
          item.duration && <span className="cinema-duration">{clock(item.duration)}</span>
        )}
        {playable(item) && (
          <button
            className="cinema-start"
            disabled={!canUse || !!busy}
            aria-label={`Смотреть вместе: ${item.title}`}
            onClick={() => void open(item)}
          >
            {busy === item.id ? <LoaderCircle size={20} /> : <Play size={20} />}
          </button>
        )}
      </span>
      {/* Растянутая кнопка вместо обёртки всей плитки: внутрь плитки нужны ещё две кнопки, а
          кнопка в кнопке — это ни разметка, ни клавиатура. */}
      <button className="cinema-open" aria-label={`Подробнее: ${item.title}`} onClick={() => enter(item)} />
      <b className="cinema-tile-title">{item.title}</b>
      <span className="cinema-tile-meta">
        {item.channelId ? (
          <button className="cinema-author" onClick={() => toChannel(String(item.channelId))}>
            {item.author || 'Канал'}
          </button>
        ) : (
          <span>{item.author}</span>
        )}
        {viewers(item.viewers) && (
          <span>
            <Users size={11} /> {viewers(item.viewers)}
          </span>
        )}
        {!item.viewers && viewers(item.views) && (
          <span>
            <Eye size={11} /> {viewers(item.views)}
          </span>
        )}
        {item.category && <span className="cinema-chip">{item.category}</span>}
      </span>
    </article>
  );

  /** Плейлист: та же обложка, но с корешком стопки и числом роликов. В него заходят. */
  const playlistTile = (item: CinemaItem) => (
    <article className="cinema-tile cinema-tile-list" key={`playlist:${item.id}`}>
      <span className="cinema-poster">
        {item.poster ? <img src={item.poster} alt="" loading="lazy" /> : <ListVideo size={26} />}
        <span className="cinema-stack">
          <ListVideo size={13} />
          {item.count ? `${item.count}` : 'Плейлист'}
        </span>
      </span>
      <button
        className="cinema-open"
        aria-label={`Открыть плейлист: ${item.title}`}
        onClick={() => enter(item)}
      />
      <b className="cinema-tile-title">{item.title}</b>
      <span className="cinema-tile-meta">
        <span>{item.author}</span>
      </span>
    </article>
  );

  /** Раздел Twitch: вертикальная обложка, как на самой площадке, и сколько его смотрят. */
  const categoryTile = (item: CinemaItem) => (
    <article className="cinema-tile cinema-tile-box" key={`category:${item.id}`}>
      <span className="cinema-box">
        {item.poster ? <img src={item.poster} alt="" loading="lazy" /> : <Gamepad2 size={26} />}
      </span>
      <button
        className="cinema-open"
        aria-label={`Открыть раздел: ${item.title}`}
        onClick={() => enter(item)}
      />
      <b className="cinema-tile-title">{item.title}</b>
      <span className="cinema-tile-meta">
        {viewers(item.viewers) && (
          <span>
            <Users size={11} /> {viewers(item.viewers)}
          </span>
        )}
      </span>
    </article>
  );

  /** Канал YouTube в результатах поиска: лицо, имя, псевдоним и сколько подписано. */
  const channelTile = (item: CinemaItem) => (
    <article className="cinema-tile cinema-tile-face" key={`channel:${item.id}`}>
      <span className="cinema-face">
        {item.poster ? <img src={item.poster} alt="" loading="lazy" /> : <Tv size={22} />}
      </span>
      <button
        className="cinema-open"
        aria-label={`Открыть канал: ${item.title}`}
        onClick={() => enter(item)}
      />
      <b className="cinema-tile-title">{item.title}</b>
      <span className="cinema-tile-meta">
        {item.author && <span>{item.author}</span>}
        {viewers(item.followers) && <span>{viewers(item.followers)} подписчиков</span>}
      </span>
    </article>
  );

  const card = (item: CinemaItem) =>
    item.kind === 'playlist'
      ? playlistTile(item)
      : item.kind === 'category'
        ? categoryTile(item)
        : item.kind === 'channel' && item.provider === 'youtube'
          ? channelTile(item)
          : tile(item);

  const grid = (items: CinemaItem[], kind: 'wide' | 'boxes' | 'faces' = 'wide') => (
    <div className={kind === 'wide' ? 'cinema-grid' : `cinema-grid cinema-grid-${kind}`}>
      {items.map(card)}
    </div>
  );
  const head = (person: CinemaChannel) => (
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

  const failure = (problem: unknown) => (
    <p className="form-error" role="alert">
      {(problem as Error).message}
    </p>
  );
  const loading = (
    <p className="cinema-waiting" role="status">
      <LoaderCircle size={22} /> Спрашиваем площадку…
    </p>
  );
  const empty = (text: string) => <p className="muted">{text}</p>;

  return (
    <section className="cinema-browser" aria-label="Кинотеатр">
      <header className="cinema-bar">
        {stack.length > 1 ? (
          <IconButton label="Назад" onClick={back}>
            <ArrowLeft size={19} />
          </IconButton>
        ) : (
          <span className="cinema-mark" aria-hidden="true">
            <Clapperboard size={19} />
          </span>
        )}
        <div className="cinema-services" role="tablist" aria-label="Площадка">
          {SERVICES.map((service) => (
            <button
              key={service.id}
              role="tab"
              aria-selected={provider === service.id}
              className="cinema-service"
              data-id={service.id}
              title={service.hint}
              // Цвет выбранной вкладки — из реестра площадок, той же карточки, что красит и
              // плитку в панели интеграций: CSS больше не хранит вторую копию этих hex-ов.
              style={{ '--accent': PROVIDERS[service.id].accent } as CSSProperties}
              onClick={() => onProvider(service.id)}
            >
              {service.id === 'twitch' ? <Radio size={15} /> : <Tv size={15} />}
              {service.name}
            </button>
          ))}
        </div>
        <label className="cinema-search">
          <Search size={16} />
          <input
            value={query}
            autoFocus
            placeholder={provider === 'youtube' ? 'Ролик, канал или плейлист' : 'Канал или игра на Twitch'}
            onChange={(event) => {
              setQuery(event.target.value);
              if (view.at !== 'home') setStack([{ at: 'home' }]);
            }}
          />
          {query && (
            <button className="icon-button" aria-label="Очистить поиск" onClick={() => setQuery('')}>
              <X size={15} />
            </button>
          )}
        </label>
        <IconButton label={watching ? 'Вернуться к просмотру' : 'Закрыть кинотеатр'} onClick={onClose}>
          <X size={19} />
        </IconButton>
      </header>

      <div className="cinema-body">
        {!canUse && (
          <p className="cinema-notice">
            Ведущий разрешил интеграции только себе — смотреть можно, включать нет.
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

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
                {categories.isError && failure(categories.error)}
                {categories.data &&
                  grid(
                    categories.data.pages.flatMap((page) => page.items),
                    'boxes',
                  )}
                {categories.isFetching && !categories.isFetchingNextPage && loading}
                <More
                  shown={!!categories.hasNextPage}
                  busy={categories.isFetchingNextPage}
                  onMore={() => void categories.fetchNextPage()}
                />
                {categories.data?.pages[0]?.items.length === 0 &&
                  !categories.isFetching &&
                  empty('Таких разделов на Twitch нет.')}
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
                    {grid(results.data.pages[0].channels, 'faces')}
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
                      {grid(results.data.pages[0].categories.slice(0, 6), 'boxes')}
                    </div>
                    <h4 className="cinema-heading">Каналы</h4>
                  </>
                )}
                {results.isError && failure(results.error)}
                {results.data && grid(results.data.pages.flatMap((page) => page.items))}
                {results.isFetching && !results.isFetchingNextPage && loading}
                <More
                  shown={!!results.hasNextPage}
                  busy={results.isFetchingNextPage}
                  onMore={() => void results.fetchNextPage()}
                />
                {results.data?.pages[0]?.items.length === 0 &&
                  !results.data?.pages[0]?.channels.length &&
                  !results.data?.pages[0]?.categories.length &&
                  !results.isFetching &&
                  empty('Ничего не нашлось. Попробуйте другие слова.')}
              </>
            )}
          </>
        )}

        {view.at === 'channel' && (
          <>
            {person && head(person)}
            <nav className="cinema-tabs" role="tablist" aria-label="Разделы канала">
              {TABS[provider].map((tab) => (
                <button
                  key={tab.id}
                  role="tab"
                  aria-selected={channelTab === tab.id}
                  className="cinema-tab"
                  onClick={() => switchTab(tab.id)}
                >
                  {tab.name}
                </button>
              ))}
            </nav>
            {opened.isError && failure(opened.error)}
            {channelTab === 'about' ? (
              person && (
                <div className="cinema-story">
                  {person.description ? (
                    <p className="cinema-about cinema-about-full">{person.description}</p>
                  ) : (
                    empty('Канал ничего о себе не написал.')
                  )}
                  <p className="cinema-detail-meta">
                    {viewers(person.followers) && <span>{viewers(person.followers)} подписчиков</span>}
                    {person.handle && <span>{person.handle}</span>}
                  </p>
                </div>
              )
            ) : (
              <>
                {grid(list)}
                {opened.isFetching && !opened.isFetchingNextPage && loading}
                <More
                  shown={!!opened.hasNextPage}
                  busy={opened.isFetchingNextPage}
                  onMore={() => void opened.fetchNextPage()}
                />
                {!opened.isFetching &&
                  list.length === 0 &&
                  empty(
                    channelTab === 'playlists'
                      ? 'У канала нет плейлистов.'
                      : channelTab === 'streams'
                        ? 'Канал не ведёт трансляций.'
                        : channelTab === 'shorts'
                          ? 'Коротких роликов у канала нет.'
                          : 'Здесь пока нечего смотреть.',
                  )}
              </>
            )}
          </>
        )}

        {view.at === 'playlist' && (
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
                      <button className="cinema-author" onClick={() => toChannel(String(playlist.channelId))}>
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
            {opened.isError && failure(opened.error)}
            {grid(list)}
            {opened.isFetching && !opened.isFetchingNextPage && loading}
            <More
              shown={!!opened.hasNextPage}
              busy={opened.isFetchingNextPage}
              onMore={() => void opened.fetchNextPage()}
            />
            {!opened.isFetching && list.length === 0 && empty('Плейлист пуст.')}
          </>
        )}

        {view.at === 'category' && (
          <>
            <header className="cinema-category-head">
              {category?.poster ? (
                <img className="cinema-box-art" src={category.poster} alt="" />
              ) : (
                <span className="cinema-box-art cinema-avatar-blank">
                  <Gamepad2 size={22} />
                </span>
              )}
              <div>
                <h3>{category?.title || view.title}</h3>
                <small>
                  {viewers(category?.viewers)
                    ? `${viewers(category?.viewers)} смотрят прямо сейчас`
                    : 'Раздел Twitch'}
                </small>
              </div>
            </header>
            {opened.isError && failure(opened.error)}
            {grid(list)}
            {opened.isFetching && !opened.isFetchingNextPage && loading}
            <More
              shown={!!opened.hasNextPage}
              busy={opened.isFetchingNextPage}
              onMore={() => void opened.fetchNextPage()}
            />
            {!opened.isFetching && list.length === 0 && empty('В этом разделе сейчас никто не в эфире.')}
          </>
        )}

        {shown && item && (
          <div className="cinema-detail">
            <div className="cinema-detail-art">
              {shown.poster ? <img src={shown.poster} alt="" /> : <Tv size={34} />}
              {shown.live && <span className="cinema-live">В эфире</span>}
            </div>
            <div className="cinema-detail-body">
              <h3>{shown.title}</h3>
              <p className="cinema-detail-meta">
                <span>{shown.author}</span>
                {viewers(shown.followers) && <span>{viewers(shown.followers)} подписчиков</span>}
                {viewers(shown.viewers) && (
                  <span>
                    <Users size={12} /> {viewers(shown.viewers)} смотрят
                  </span>
                )}
                {viewers(shown.views) && (
                  <span>
                    <Eye size={12} /> {viewers(shown.views)} просмотров
                  </span>
                )}
                {clock(shown.duration) !== '—' && <span>{clock(shown.duration)}</span>}
                {published(shown.published) && <span>{published(shown.published)}</span>}
                {shown.category && <span className="cinema-chip">{shown.category}</span>}
              </p>
              <div className="cinema-detail-actions">
                <button
                  className="button primary"
                  disabled={!canUse || !!busy}
                  onClick={() => void open(item)}
                >
                  <Play size={18} /> Смотреть вместе
                </button>
                {shown.channelId && (
                  <button className="button secondary" onClick={() => toChannel(String(shown.channelId))}>
                    <Tv size={17} /> Открыть канал
                  </button>
                )}
              </div>
              {details.isLoading && loading}
              {details.isError && failure(details.error)}
              {shown.description && <p className="cinema-about">{shown.description}</p>}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

export default CinemaBrowser;
