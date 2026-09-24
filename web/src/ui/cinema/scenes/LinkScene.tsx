import { useEffect, useEffectEvent, useMemo, useState, type CSSProperties } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AudioLines,
  Captions,
  ClipboardPaste,
  Globe,
  History,
  Link2,
  LoaderCircle,
  MonitorPlay,
  Play,
} from 'lucide-react';
import {
  CinemaApi,
  PROVIDER_IDS,
  PROVIDERS,
  clock,
  type CinemaAt,
  type CinemaItem,
  type CinemaLinkAnswer,
  type CinemaLinkItem,
} from '../../../core/cinema';
import { atOf, knownProvider, linkOf, linkParts } from '../../../core/cinema/link';
import { useStore } from '../../primitives';
import { Empty, Failure } from '../catalog/notes';
import { ItemPage } from '../catalog/pages/ItemPage';
import { Shell } from '../catalog/Shell';
import { LINK_TTL, linkQuery, useLink } from '../catalog/useLink';
import { useTogether } from '../catalog/useTogether';
import type { SceneProps } from '.';

/** Страницы у карточки по ссылке нет: всё, что о ней известно, пришло в самом ответе службы. */
const NO_DETAILS = { data: null, isLoading: false, isError: false, error: null };

/** Площадки, чьи ссылки открываются в их же каталоге, — словами: «YouTube, Twitch и VK Видео». */
const KNOWN = PROVIDER_IDS.filter((id) => PROVIDERS[id].scene !== 'link').map((id) => PROVIDERS[id].name);
const LISTED = KNOWN.length > 1 ? `${KNOWN.slice(0, -1).join(', ')} и ${KNOWN.at(-1)}` : (KNOWN[0] ?? '');

/**
 * Сцена «По ссылке»: вставить ссылку — и смотреть вместе.
 *
 * ЧЬЯ ССЫЛКА, РЕШАЕТ СЛУЖБА. Поле здесь то же, что поиск в каждой сцене, и ссылка из него идёт тем же
 * путём (`useLink`): ролик, эфир, канал или сериал площадки из каталога открывается в сцене этой
 * площадки сразу на своей странице — там, где у него есть канал, серии и соседи. Здесь остаётся
 * только то, чему своей площадки нет: что нашлось по ссылке (постер, имя, длительность, качество,
 * дорожки звука, субтитры, серии плейлиста) — или почему это не открыть, словами службы.
 *
 * ОТКУДА ССЫЛКА. Из буфера обмена одной кнопкой, из поля руками, из недавних (профиль помнит десять
 * последних, что куда-то привели) — или из поиска другой сцены: ссылку без своей площадки та
 * передаёт сюда (`at`), и ответ службы к этому времени уже у неё в памяти — второй раз не спрашивают.
 */
export default function LinkScene({ provider, at, meeting, onClose }: SceneProps) {
  const spec = PROVIDERS[provider];
  const accent = { '--accent': spec.accent } as CSSProperties;
  const api = useMemo(() => new CinemaApi(meeting.admission), [meeting]);
  const watching = !!useStore(meeting.snapshot).watch;
  const recent = useStore(meeting.media.preferences).cinemaLinks;
  const { canUse, busy, error, open } = useTogether(meeting);
  const link = useLink(meeting, api);
  const [query, setQuery] = useState('');
  /** Ссылку спрашивают не на каждую букву: поле успокоилось — значит, её вставили или дописали. */
  const [settled, setSettled] = useState('');
  /** Почему кнопка буфера не вставила ссылку. */
  const [clipboard, setClipboard] = useState('');
  /** Ссылка из поиска другой сцены: в поле — она, ответ — тот, что служба уже дала. */
  const [seen, setSeen] = useState<CinemaAt | null>(null);
  const handed = at ?? null;
  if (handed !== seen) {
    setSeen(handed);
    if (handed?.page === 'link') {
      setQuery(handed.url);
      setSettled(handed.url);
    }
  }
  const client = useQueryClient();
  const follow = useEffectEvent((url: string) => {
    // Ответ, который оставляет здесь (ссылка без своей площадки), уже в памяти — её передала другая
    // сцена или её только что выбрали: второй раз не спрашивают. Ссылка своей площадки ведёт в её
    // сцену всегда — и когда её набрали здесь во второй раз.
    const known = client.getQueryData<CinemaLinkAnswer>(linkQuery(url));
    if (!known || known.route) void link.follow(url);
  });
  useEffect(() => {
    const timer = setTimeout(() => {
      const url = linkOf(query, true);
      if (url) follow(url);
      setSettled(query.trim());
    }, 420);
    return () => clearTimeout(timer);
  }, [query]);

  const current = linkOf(settled, true);
  // Ответ о ссылке — из общей памяти ответов (`useLink` кладёт его туда сам); сюда он не спрашивается
  // второй раз, а только читается.
  const answer = useQuery({
    queryKey: linkQuery(current ?? ''),
    queryFn: ({ signal }) => api.link(current ?? '', signal),
    enabled: false,
    staleTime: LINK_TTL,
  }).data;
  const route = answer?.route;
  const item = answer && !answer.route ? answer.item : null;

  /** Ссылка из буфера или из недавних — сразу, без паузы на набор. */
  const choose = (url: string) => {
    setQuery(url);
    setSettled(url);
    void link.follow(url);
  };
  const paste = async () => {
    let text = '';
    let refused = false;
    // В `try` — только само чтение: условное выражение внутри `try` React Compiler не берёт.
    try {
      text = await navigator.clipboard.readText();
    } catch {
      refused = true;
    }
    const url = linkOf(text, true);
    if (url) {
      setClipboard('');
      choose(url);
    } else
      setClipboard(
        refused
          ? 'Браузер не дал прочитать буфер обмена — вставьте ссылку в поле сами.'
          : 'В буфере обмена нет ссылки.',
      );
  };

  return (
    <Shell
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
        link.cancel();
      }}
      onClear={() => setQuery('')}
      watching={watching}
      onClose={onClose}
      locked={!canUse}
      error={error}
    >
      {!settled ? (
        <>
          <div className="cinema-empty">
            <Link2 size={40} />
            <b>Вставьте ссылку на видео</b>
            <small>
              Ролик, эфир, канал или плейлист {LISTED} откроется в их каталоге — сразу на своей странице.
            </small>
            <button className="button secondary" onClick={() => void paste()}>
              <ClipboardPaste size={17} /> Вставить из буфера
            </button>
            {clipboard ? <small role="alert">{clipboard}</small> : null}
          </div>
          {recent.length ? (
            <section className="cinema-link-recent" aria-label="Недавние ссылки">
              <h4 className="cinema-heading">
                <History size={13} /> Недавние ссылки
              </h4>
              <ul>
                {recent.map((url) => {
                  const { host, rest } = linkParts(url);
                  return (
                    <li key={url}>
                      <button title={url} onClick={() => choose(url)}>
                        <Link2 size={15} />
                        <b>{host}</b>
                        <span>{rest}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
        </>
      ) : !current ? (
        <Empty text="Это не похоже на ссылку: нужен адрес страницы с видео — например, https://rutube.ru/video/…" />
      ) : link.checking === current ? (
        <p className="cinema-waiting" role="status">
          <LoaderCircle size={22} /> Ищем видео…
        </p>
      ) : link.problem ? (
        <Failure problem={link.problem} />
      ) : route && knownProvider(route.provider) ? (
        // Сюда ссылка своей площадки попадает, только если переход не состоялся: дверь — руками.
        <div className="cinema-empty">
          <Link2 size={40} />
          <b>Это ссылка на {PROVIDERS[route.provider].name}</b>
          <button className="button primary" onClick={() => meeting.openCinema(route.provider, atOf(route))}>
            Открыть в {PROVIDERS[route.provider].name}
          </button>
        </div>
      ) : route ? (
        <Empty text="Эту площадку знает сервер, но ещё не эта версия кинозала — обновите страницу." />
      ) : item ? (
        <Result item={item} canUse={canUse} busy={busy} onWatch={(chosen) => void open(chosen)} />
      ) : answer ? (
        <div className="cinema-empty" role="status">
          <Link2 size={40} />
          <b>{answer.reason || 'Эту ссылку пока не открыть'}</b>
          <small className="cinema-link-address">{current}</small>
        </div>
      ) : null}
    </Shell>
  );
}

/**
 * Что нашлось по ссылке: та же страница ролика, что у площадок из каталога, и под ней — то, по чему
 * решают, включать ли: сайт, качество, звук, субтитры, а у плейлиста — его серии, каждую отдельно.
 */
function Result({
  item,
  canUse,
  busy,
  onWatch,
}: {
  item: CinemaLinkItem;
  canUse: boolean;
  busy: string;
  onWatch: (item: CinemaItem) => void;
}) {
  const audio = item.audio ?? [];
  const captions = item.captions ?? [];
  const episodes = item.episodes ?? [];
  return (
    <>
      <ItemPage
        item={item}
        details={NO_DETAILS}
        canUse={canUse}
        busy={busy}
        onWatch={onWatch}
        onChannel={() => {}}
      />
      <dl className="cinema-link-facts">
        {item.site ? (
          <div>
            <dt>
              <Globe size={14} /> Сайт
            </dt>
            <dd>{item.site}</dd>
          </div>
        ) : null}
        {item.quality ? (
          <div>
            <dt>
              <MonitorPlay size={14} /> Качество
            </dt>
            <dd>до {item.quality}</dd>
          </div>
        ) : null}
        {audio.length ? (
          <div>
            <dt>
              <AudioLines size={14} /> Звук
            </dt>
            <dd>{audio.map((track) => track.label || track.lang).join(', ')}</dd>
          </div>
        ) : null}
        {captions.length ? (
          <div>
            <dt>
              <Captions size={14} /> Субтитры
            </dt>
            <dd>
              {captions
                .map((track) => `${track.label || track.lang}${track.auto ? ' (распознаны)' : ''}`)
                .join(', ')}
            </dd>
          </div>
        ) : null}
      </dl>
      {episodes.length ? (
        <section className="cinema-link-episodes" aria-label="Серии">
          <h4 className="cinema-heading">Серии · {episodes.length}</h4>
          <ol>
            {episodes.map((episode) => (
              <li key={episode.id}>
                <span className="cinema-link-episode-title">{episode.title}</span>
                {clock(episode.duration) !== '—' ? <span>{clock(episode.duration)}</span> : null}
                <button
                  className="icon-button"
                  disabled={!canUse || !!busy}
                  aria-label={`Смотреть вместе: ${episode.title}`}
                  onClick={() => onWatch(episode)}
                >
                  {busy === episode.id ? <LoaderCircle size={17} /> : <Play size={17} />}
                </button>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </>
  );
}
