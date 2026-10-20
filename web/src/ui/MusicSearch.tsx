import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { LoaderCircle, Plus, Search, X } from 'lucide-react';
import { musicSourceName, type MusicState, type PlatformTrack, type YandexTrack } from '../core/services';
import { IconButton } from './kit';
import { classifyQuery, formatDuration } from './music-playback';

type Searchable = 'yandex' | 'youtube' | 'soundcloud';

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
  /** Площадки без аккаунта, включённые на этом сервере (`catalog.sources`). */
  platforms: PlatformTrack['source'][];
  /** Можно ли искать на них (`music.search`). */
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

const NOT_OURS = 'Такие ссылки музыка не открывает. Подойдут YouTube, SoundCloud и Яндекс Музыка';

/**
 * Одно поле на все источники (T18): название — поиск сразу везде, ссылка — сразу в очередь.
 *
 * Каждая площадка отвечает своим запросом и своей группой: медленный SoundCloud не держит готовый
 * YouTube, а отказ одной площадки не прячет ответы остальных. Ссылку YouTube и SoundCloud служба
 * скачивает и ставит в очередь без лишнего шага; ссылка Яндекс Музыки идёт в его поиск — трек там
 * проверяется на доступность аккаунту, и человек видит его до добавления.
 */
export function MusicSearch({
  abilities,
  onAdded,
  children,
}: {
  abilities: MusicSearchAbilities;
  onAdded: (state: MusicState) => void;
  /** Под полем: загрузка файлов. */
  children?: ReactNode;
}) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [groups, setGroups] = useState<Group[]>([]);
  const [adding, setAdding] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const asked = useRef(0);
  const { platforms, canSearch, searchPlatform, addLink, yandex } = abilities;
  const searchable = canSearch ? platforms : [];
  const canFind = searchable.length > 0 || !!yandex;

  const reset = () => {
    asked.current += 1;
    setGroups([]);
    setError('');
  };
  const added = (state: MusicState, title?: string) => {
    onAdded(state);
    setNotice(`Добавлено: ${title ?? state.queue.at(-1)?.title ?? 'трек'}`);
  };
  const platformFound = (track: PlatformTrack): Found => ({
    key: track.url,
    title: track.title,
    artist: track.artist,
    duration: track.duration,
    refusal: !track.available
      ? track.source === 'soundcloud' && track.duration === 30
        ? 'Только фрагмент'
        : 'Не добавить'
      : addLink
        ? null
        : 'Нет прав',
    add: () => addLink!(track.url),
  });
  const yandexFound = (track: YandexTrack): Found => ({
    key: track.id,
    title: track.title,
    artist: track.artist,
    duration: track.duration,
    refusal: !track.available ? 'Недоступен' : yandex?.add ? null : 'Нет прав',
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
        .catch((e: Error) => ({ status: 'error' as const, found: [], error: e.message }))
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
    setNotice('');
    setError('');
    const what = classifyQuery(query);
    if (what.kind === 'empty') return reset();
    if (what.kind === 'foreign') {
      reset();
      setError(NOT_OURS);
      return;
    }
    if (what.kind === 'link') {
      const source = what.source;
      if (source === 'yandex') {
        if (!yandex) return setError('Яндекс Музыка на этом сервере выключена');
        if (!yandex.connected)
          return setError('Чтобы добавить трек Яндекс Музыки, подключите аккаунт комнаты ниже');
        return run(['yandex'], what.url);
      }
      reset();
      if (!addLink) return setError('Добавлять треки организатор разрешил только себе');
      if (!platforms.includes(source))
        return setError(`Ссылки ${musicSourceName(source)} на этом сервере выключены`);
      setLinking(true);
      try {
        added(await addLink(what.url));
        setQuery('');
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLinking(false);
      }
      return;
    }
    const sources: Searchable[] = [...(yandex?.connected ? (['yandex'] as const) : []), ...searchable];
    if (!sources.length) {
      setError(
        yandex ? 'Подключите Яндекс Музыку ниже, чтобы искать треки' : 'Поиск на этом сервере выключен',
      );
      return;
    }
    run(sources, what.text);
  };

  const add = async (item: Found) => {
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
          {canFind ? 'Найти трек или вставить ссылку' : 'Вставить ссылку на трек'}
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
            placeholder={canFind ? 'Название, исполнитель или ссылка' : 'Ссылка YouTube или SoundCloud'}
            onChange={(e) => {
              setQuery(e.target.value);
              if (!e.target.value) reset();
            }}
          />
          {query && !linking && (
            <IconButton
              size="sm"
              label="Очистить поиск"
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
            <LoaderCircle size={16} className="spin music-search__busy" aria-label="Добавляем трек" />
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
      {groups.map((group) => (
        <section
          key={group.source}
          className="music-results"
          aria-label={`Найдено: ${musicSourceName(group.source)}`}
        >
          <h5 className="music-results__source">
            {musicSourceName(group.source)}
            {group.status === 'loading' && <LoaderCircle size={12} className="spin" aria-label="Ищем" />}
          </h5>
          {group.status === 'error' ? (
            <p className="music-results__empty">{group.error || 'Площадка не ответила'}</p>
          ) : group.status === 'done' && !group.found.length ? (
            <p className="music-results__empty">Ничего не нашлось</p>
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
                      label={`Добавить в очередь: ${item.title}`}
                      disabled={!!adding}
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
