import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, LoaderCircle, Plus, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { musicSourceName, type MusicState, type PlatformTrack, type YandexTrack } from '../core/services';
import { unreachableRefusal } from '../core/cinema/reach';
import { problemText } from './cinema/catalog/notes';
import { Button, IconButton } from './kit';
import { classifyQuery, formatDuration } from './music-playback';
import { routeQuery, type MusicPlatform, type SearchPlatform } from './music-platforms';

type Searchable = SearchPlatform;

interface Found {
  key: string;
  title: string;
  artist: string;
  duration: number;
  /** Почему не добавить, если нельзя: эфир, фрагмент, недоступно аккаунту. */
  refusal: string | null;
  add: () => Promise<MusicState>;
}

interface Group {
  source: Searchable;
  status: 'loading' | 'done' | 'error';
  found: Found[];
  error?: string;
}

/** Что панель умеет искать и добавлять — уже с учётом прав (`you.can`) и того, что включено. */
export interface MusicSearchAbilities {
  /** Площадка поля (T59): поиск и ссылки — только её. */
  platform: SearchPlatform;
  /** Площадки, включённые на этом сервере (`catalog.sources`): ссылка другой из них зовёт туда. */
  offered: readonly MusicPlatform[];
  /** Можно ли искать на YouTube и SoundCloud (`music.search`). */
  canSearch: boolean;
  searchPlatform: (source: PlatformTrack['source'], query: string) => Promise<PlatformTrack[]>;
  /** Добавить по ссылке или из найденного (`music.link`); `null` — нельзя. */
  addLink: ((url: string) => Promise<MusicState>) | null;
  /** Яндекс Музыка: `null` — выключена на сервере или нельзя искать. */
  yandex: {
    connected: boolean;
    search: (query: string) => Promise<YandexTrack[]>;
    add: ((trackId: string) => Promise<MusicState>) | null;
  } | null;
}

/**
 * Поле площадки (T59; прежде — одно поле на все источники, T18): название — поиск на этой площадке,
 * её ссылка — сразу в очередь.
 *
 * Ссылку YouTube и SoundCloud служба скачивает и ставит в очередь без лишнего шага; ссылка Яндекс
 * Музыки идёт в его поиск — трек там проверяется на доступность аккаунту, и человек видит его до
 * добавления. Ссылка другой включённой площадки молча не добавляется: под полем — «Перейти» туда,
 * и ссылка переезжает в поле той площадки (`onSwitch`).
 */
export function MusicSearch({
  abilities,
  onAdded,
  onSwitch,
  onUnreachable,
  initialQuery = '',
  children,
}: {
  abilities: MusicSearchAbilities;
  onAdded: (state: MusicState) => void;
  /** Перейти на другую площадку с этим текстом в её поле. */
  onSwitch?: (platform: MusicPlatform, text: string) => void;
  /** Служба отказала: площадка недоступна с этого сервера (`MUSIC_UNREACHABLE`, R112). */
  onUnreachable?: (platform: SearchPlatform) => void;
  /** С чем поле открывается: ссылка, принесённая с другой площадки. */
  initialQuery?: string;
  /** Под полем. */
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [query, setQuery] = useState(initialQuery);
  const [groups, setGroups] = useState<Group[]>([]);
  const [adding, setAdding] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  /** Ссылка другой площадки — и куда с ней перейти. */
  const [elsewhere, setElsewhere] = useState<{ platform: SearchPlatform; url: string } | null>(null);
  const asked = useRef(0);
  const { platform, offered, canSearch, searchPlatform, addLink, yandex } = abilities;
  const canFind = platform === 'yandex' ? !!yandex?.connected : canSearch;

  const reset = () => {
    asked.current += 1;
    setGroups([]);
    setError('');
    setElsewhere(null);
  };
  const added = (state: MusicState, title?: string) => {
    onAdded(state);
    setNotice(
      t(($) => $.music.search.added, {
        title: title ?? state.queue.at(-1)?.title ?? t(($) => $.music.search.track),
      }),
    );
  };
  const platformFound = (track: PlatformTrack): Found => ({
    key: track.url,
    title: track.title,
    artist: track.artist,
    duration: track.duration,
    refusal: !track.available
      ? track.source === 'soundcloud' && track.duration === 30
        ? t(($) => $.music.search.refusals.preview)
        : t(($) => $.music.search.refusals.unavailable)
      : addLink
        ? null
        : t(($) => $.music.search.refusals.denied),
    add: () => addLink!(track.url),
  });
  const yandexFound = (track: YandexTrack): Found => ({
    key: track.id,
    title: track.title,
    artist: track.artist,
    duration: track.duration,
    refusal: !track.available
      ? t(($) => $.music.search.refusals.unavailableYandex)
      : yandex?.add
        ? null
        : t(($) => $.music.search.refusals.denied),
    add: () => yandex!.add!(track.id),
  });
  const run = (sources: Searchable[], text: string) => {
    const ticket = ++asked.current;
    setGroups(sources.map((source) => ({ source, status: 'loading', found: [] })));
    for (const source of sources) {
      const work: Promise<Found[]> =
        source === 'yandex'
          ? yandex!.search(text).then((tracks) => tracks.map(yandexFound))
          : searchPlatform(source, text).then((tracks) => tracks.map(platformFound));
      void work
        .then((found) => ({ status: 'done' as const, found }))
        .catch((e: unknown) => {
          // Площадка недоступна отсюда — это знание о площадке, а не об одном вопросе: её вкладка
          // помечается, и вместо поиска встаёт «недоступна с этого сервера» с «Повторить».
          if (unreachableRefusal(e)) onUnreachable?.(source);
          return { status: 'error' as const, found: [], error: problemText(t, e) };
        })
        .then((result) => {
          if (asked.current !== ticket) return;
          setGroups((current) =>
            current.map((group) => (group.source === source ? { ...group, ...result } : group)),
          );
        });
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    // Пока трек скачивается, второй Enter — не вторая просьба: та же ссылка встала бы в очередь дважды.
    if (linking || adding) return;
    setNotice('');
    reset();
    const what = routeQuery(classifyQuery(query), platform, offered);
    switch (what.kind) {
      case 'empty':
        return;
      case 'foreign':
        return setError(t(($) => $.music.search.notOurs));
      case 'off':
        return setError(t(($) => $.music.search.sourceOff, { name: musicSourceName(t, what.platform) }));
      case 'elsewhere':
        return setElsewhere({ platform: what.platform, url: what.url });
      case 'search':
        if (platform === 'yandex') {
          if (!yandex?.connected) return setError(t(($) => $.music.search.connectToSearch));
        } else if (!canSearch) return setError(t(($) => $.music.search.locked));
        return run([platform], what.text);
      case 'link':
        if (platform === 'yandex') {
          if (!yandex?.connected) return setError(t(($) => $.music.search.yandexConnect));
          return run(['yandex'], what.url);
        }
        if (!addLink) return setError(t(($) => $.music.search.locked));
        setLinking(true);
        try {
          added(await addLink(what.url));
          setQuery('');
        } catch (e) {
          if (unreachableRefusal(e)) onUnreachable?.(platform);
          setError(problemText(t, e));
        } finally {
          setLinking(false);
        }
    }
  };

  const add = async (item: Found) => {
    if (linking || adding) return;
    setAdding(item.key);
    setError('');
    setNotice('');
    try {
      added(await item.add(), item.title);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAdding(null);
    }
  };

  return (
    <div className="music-search">
      <form className="music-search__form" role="search" onSubmit={submit}>
        <label className="music-search__label" htmlFor={`${id}-query`}>
          {canFind ? t(($) => $.music.platforms[platform].find) : t(($) => $.music.search.labelLink)}
        </label>
        <div className="music-search__field">
          <Search size={16} className="music-search__icon" aria-hidden="true" />
          <input
            id={`${id}-query`}
            className="music-search__input"
            type="search"
            enterKeyHint="search"
            autoComplete="off"
            maxLength={300}
            value={query}
            // Ссылку, принесённую с другой площадки, добавляют одним Enter: поле ждёт в фокусе.
            autoFocus={!!initialQuery}
            placeholder={
              canFind ? t(($) => $.music.search.placeholderFind) : t(($) => $.music.platforms[platform].link)
            }
            onChange={(e) => {
              setQuery(e.target.value);
              if (!e.target.value) reset();
            }}
          />
          {query && !linking && (
            <IconButton
              size="sm"
              label={t(($) => $.music.search.clear)}
              className="music-search__clear"
              onClick={() => {
                setQuery('');
                reset();
                setNotice('');
              }}
            >
              <X size={14} />
            </IconButton>
          )}
          {linking && (
            <LoaderCircle
              size={16}
              className="spin music-search__busy"
              aria-label={t(($) => $.music.search.adding)}
            />
          )}
        </div>
      </form>
      {children}
      {notice && (
        <p className="music-search__notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="music-search__error" role="alert">
          {error}
        </p>
      )}
      {elsewhere && (
        <div className="music-search__elsewhere" role="status">
          <p>{t(($) => $.music.search.elsewhere, { name: musicSourceName(t, elsewhere.platform) })}</p>
          {onSwitch && (
            <Button
              size="sm"
              icon={<ArrowRight />}
              onClick={() => onSwitch(elsewhere.platform, elsewhere.url)}
            >
              {t(($) => $.music.search.switchTo, { name: musicSourceName(t, elsewhere.platform) })}
            </Button>
          )}
        </div>
      )}
      {groups.map((group) => (
        <section
          key={group.source}
          className="music-results"
          aria-label={t(($) => $.music.search.found, { name: musicSourceName(t, group.source) })}
        >
          <h5 className="music-results__source">
            {musicSourceName(t, group.source)}
            {group.status === 'loading' && (
              <LoaderCircle size={12} className="spin" aria-label={t(($) => $.music.search.searching)} />
            )}
          </h5>
          {group.status === 'error' ? (
            <p className="music-results__empty">{group.error || t(($) => $.music.search.noAnswer)}</p>
          ) : group.status === 'done' && !group.found.length ? (
            <p className="music-results__empty">{t(($) => $.music.search.nothing)}</p>
          ) : (
            <ol className="music-results__list">
              {group.found.map((item) => (
                <li key={item.key} className="music-results__row">
                  <div className="music-results__text">
                    <strong>{item.title}</strong>
                    <small>{item.artist}</small>
                  </div>
                  <span className="music-results__time">
                    {item.duration ? formatDuration(item.duration) : ''}
                  </span>
                  {item.refusal ? (
                    <span className="music-results__refusal">{item.refusal}</span>
                  ) : (
                    <IconButton
                      size="sm"
                      className="music-results__add"
                      label={t(($) => $.music.search.add, { title: item.title })}
                      disabled={!!adding || linking}
                      onClick={() => void add(item)}
                    >
                      {adding === item.key ? <LoaderCircle size={16} className="spin" /> : <Plus size={16} />}
                    </IconButton>
                  )}
                </li>
              ))}
            </ol>
          )}
        </section>
      ))}
    </div>
  );
}
