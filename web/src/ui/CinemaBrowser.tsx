import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Clapperboard, Eye, LoaderCircle, Play, Radio, Search, Tv, Users, X } from 'lucide-react';
import type { Meeting } from '../core/meeting';
import {
  CinemaApi,
  clock,
  published,
  viewers,
  type CinemaChannel,
  type CinemaDetails,
  type CinemaItem,
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

type View = { at: 'home' } | { at: 'channel'; id: string } | { at: 'item'; item: CinemaItem };

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
  return { description: '', ...item, ...filled };
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
  // Что именно открыто, вынуто из разбора один раз: внутри обработчиков нажатий разбор
  // размеченного типа уже не виден, и каждая кнопка иначе просила бы его заново.
  const channelId = view.at === 'channel' ? view.id : '';
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
    setStack([{ at: 'home' }]);
  }, [provider]);

  const results = useQuery({
    queryKey: ['cinema', 'search', provider, settled],
    queryFn: ({ signal }) => api.search(provider, settled, signal),
    enabled: view.at === 'home' && (provider === 'twitch' || settled.length > 1),
    staleTime: 60000,
  });
  const channel = useQuery({
    queryKey: ['cinema', 'channel', provider, channelId],
    queryFn: ({ signal }) => api.channel(provider, channelId, signal),
    enabled: !!channelId,
    staleTime: 120000,
  });
  const details = useQuery({
    queryKey: ['cinema', 'item', provider, item ? `${item.kind}:${item.id}` : ''],
    queryFn: ({ signal }) => (item ? api.details(provider, item.id, item.kind, signal) : null),
    enabled: !!item,
    staleTime: 300000,
  });

  const shown = item ? merge(item, details.data) : null;

  const open = async (item: CinemaItem) => {
    if (!canUse) return;
    setBusy(item.id);
    setError('');
    try {
      await meeting.command('watch.open', item.title, undefined, {
        provider: item.provider,
        kind: item.kind,
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

  const tile = (item: CinemaItem) => (
    <article className="cinema-tile" key={`${item.kind}:${item.id}`}>
      <span className="cinema-poster">
        {item.poster ? <img src={item.poster} alt="" loading="lazy" /> : <Tv size={26} />}
        {item.live ? (
          <span className="cinema-live">В эфире</span>
        ) : (
          item.duration && <span className="cinema-duration">{clock(item.duration)}</span>
        )}
        <button
          className="cinema-start"
          disabled={!canUse || !!busy}
          aria-label={`Смотреть вместе: ${item.title}`}
          onClick={() => void open(item)}
        >
          {busy === item.id ? <LoaderCircle size={20} /> : <Play size={20} />}
        </button>
      </span>
      {/* Растянутая кнопка вместо обёртки всей плитки: внутрь плитки нужны ещё две кнопки, а
          кнопка в кнопке — это ни разметка, ни клавиатура. */}
      <button
        className="cinema-open"
        aria-label={`Подробнее: ${item.title}`}
        onClick={() => go({ at: 'item', item })}
      />
      <b className="cinema-tile-title">{item.title}</b>
      <span className="cinema-tile-meta">
        {item.channelId ? (
          <button className="cinema-author" onClick={() => go({ at: 'channel', id: String(item.channelId) })}>
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

  const grid = (items: CinemaItem[]) => <div className="cinema-grid">{items.map(tile)}</div>;
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
            {viewers(person.followers) ? `${viewers(person.followers)} подписчиков` : 'Канал'}
            {person.live && person.viewers ? ` · в эфире, ${viewers(person.viewers)} смотрят` : ''}
            {person.category ? ` · ${person.category}` : ''}
          </small>
        </div>
      </div>
      {person.description && <p className="cinema-about">{person.description}</p>}
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
            placeholder={provider === 'youtube' ? 'Что посмотрим?' : 'Канал или игра на Twitch'}
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

        {view.at === 'home' && (
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
            {results.isFetching && loading}
            {results.isError && failure(results.error)}
            {results.data && grid(results.data)}
            {results.data?.length === 0 && !results.isFetching && (
              <p className="muted">Ничего не нашлось. Попробуйте другие слова.</p>
            )}
          </>
        )}

        {view.at === 'channel' && (
          <>
            {channel.isLoading && loading}
            {channel.isError && failure(channel.error)}
            {channel.data && (
              <>
                {head(channel.data.channel)}
                {channel.data.channel.live && channel.data.items[0]?.live && (
                  <>
                    <h4 className="cinema-heading">Идёт прямо сейчас</h4>
                    {grid([channel.data.items[0]])}
                    <h4 className="cinema-heading">Прошлые трансляции</h4>
                    {grid(channel.data.items.slice(1))}
                  </>
                )}
                {!(channel.data.channel.live && channel.data.items[0]?.live) && (
                  <>
                    <h4 className="cinema-heading">Видео</h4>
                    {grid(channel.data.items)}
                  </>
                )}
                {channel.data.items.length === 0 && <p className="muted">Здесь пока нечего смотреть.</p>}
              </>
            )}
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
                  <button
                    className="button secondary"
                    onClick={() => go({ at: 'channel', id: String(shown.channelId) })}
                  >
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
