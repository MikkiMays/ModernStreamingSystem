import { useMemo, useState, type CSSProperties } from 'react';
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AudioLines,
  Captions,
  ClipboardPaste,
  Globe,
  History,
  Link2,
  LoaderCircle,
  MonitorPlay,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  CinemaApi,
  PROVIDER_IDS,
  PROVIDERS,
  providerName,
  type CinemaAt,
  type CinemaItem,
  type CinemaLinkAnswer,
  type CinemaLinkItem,
  type CinemaLinkTrack,
  type CinemaPageKind,
} from '../../../core/cinema';
import { atOf, forgetLink, knownProvider, linkOf, linkParts } from '../../../core/cinema/link';
import { locale, type Translate } from '../../../i18n';
import { useStore } from '../../primitives';
import { cardsOf } from '../catalog/cards';
import { Empty, Failure } from '../catalog/notes';
import { ItemPage } from '../catalog/pages/ItemPage';
import { SeriesPage } from '../catalog/pages/SeriesPage';
import { Shell } from '../catalog/Shell';
import { Tile } from '../catalog/tiles';
import { LINK_TTL, linkQuery, useLink } from '../catalog/useLink';
import { usePage } from '../catalog/usePage';
import { useStack } from '../catalog/useStack';
import { useTogether } from '../catalog/useTogether';
import { languageName } from '../theater/watch-tracks';
import type { SceneProps } from '.';

/** Страницы у карточки по ссылке нет: всё, что о ней известно, пришло в самом ответе службы. */
const NO_DETAILS = { data: null, isLoading: false, isError: false, error: null };

/** Смотрится ли карточка вместе прямо отсюда: ролик или идущий эфир. Остальное — двери. */
function playable(item: CinemaItem): boolean {
  return item.kind === 'video' || (item.kind === 'channel' && item.live);
}

/** Страница сцены своей площадки для карточки из плейлиста по ссылке. */
function pageOf(item: CinemaItem): CinemaPageKind {
  if (playable(item)) return 'item';
  return item.kind === 'channel' ? 'channel' : item.kind === 'playlist' ? 'playlist' : 'series';
}

/** Площадки, чьи ссылки открываются в их же каталоге. */
const KNOWN = PROVIDER_IDS.filter((id) => PROVIDERS[id].scene !== 'link');

/** Те же площадки словами, списком по правилам языка: «YouTube, Twitch и VK Видео». */
function listed(t: Translate): string {
  return new Intl.ListFormat(locale(t), { type: 'conjunction' }).format(
    KNOWN.map((id) => providerName(t, id)),
  );
}

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
 *
 * КОГДА СПРАШИВАЮТ. Вставленную в поле ссылку — сразу; набранную руками — только по Enter или кнопке
 * «Открыть ссылку»: каждая пауза в наборе была бы разбором недописанной страницы, а их у комнаты
 * десять в минуту. Новая ссылка сменяет прежнюю — и в браузере (вопрос в пути обрывается), и на
 * сервере (её разбор отменяется).
 */
export default function LinkScene({ provider, at, meeting, onClose }: SceneProps) {
  const { t } = useTranslation();
  const spec = PROVIDERS[provider];
  /*
    Своего цвета у ссылки нет: `PROVIDERS.link.accent` — цвет приложения (`--blue`), а на сцене это
    светлый синий текста, и белая подпись плашки на нём — 2,6:1. Под подписью — заливка кнопок.
  */
  const accent = { '--accent': 'var(--accent-fill)' } as CSSProperties;
  const api = useMemo(() => new CinemaApi(meeting.admission), [meeting]);
  const watching = !!useStore(meeting.snapshot).watch;
  const recent = useStore(meeting.media.preferences).cinemaLinks;
  const { canUse, busy, error, open } = useTogether(meeting);
  const link = useLink(meeting, api);
  /** Стопка страниц: ответ о ссылке — главная, серия плейлиста — страница над ней. */
  const { stack, view, go, back, home } = useStack(provider);
  const page = usePage(api, provider, view);
  const [query, setQuery] = useState('');
  /** О каком тексте поля спросили (вставили, Enter, кнопка); набранное после — ещё не вопрос. */
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
  /** Спросить о том, что в поле: его вставили, нажали Enter или «Открыть ссылку». */
  const ask = (text: string) => {
    setSettled(text.trim());
    const url = linkOf(text, true);
    if (!url) return;
    // Ответ, который оставляет здесь (ссылка без своей площадки), уже в памяти — её передала другая
    // сцена или её только что выбрали: второй раз не спрашивают. Ссылка своей площадки ведёт в её
    // сцену всегда — и когда её набрали здесь во второй раз.
    const known = client.getQueryData<CinemaLinkAnswer>(linkQuery(url));
    if (!known || known.route) void link.follow(url);
  };

  const typed = query.trim();
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
  /**
   * Серии плейлиста по ссылке — страницей сериала службы (`series`), тем же запросом, что открыл бы
   * сериал в стопке: вернувшись с серии, лента уже в памяти.
   */
  const seriesId = item?.kind === 'series' ? item.id : '';
  /**
   * Открытый сезон (T17): пусто — тот, что выберет служба (первый). Сезоны у плейлиста по ссылке есть,
   * когда сайт назвал их у серий; другой плейлист — снова «как выберет служба».
   */
  const [season, setSeason] = useState('');
  const [seasonOf, setSeasonOf] = useState('');
  if (seasonOf !== seriesId) {
    setSeasonOf(seriesId);
    setSeason('');
  }
  const episodes = useInfiniteQuery({
    queryKey: ['cinema', 'page', provider, `series:${seriesId}:${season}`],
    queryFn: ({ pageParam, signal }) => api.series(provider, seriesId, season, pageParam, signal),
    initialPageParam: '',
    getNextPageParam: (last) => last.next ?? undefined,
    enabled: !!seriesId,
    staleTime: 60000,
    // Пока едет другой сезон, шапка с вкладками остаётся прежней, а не пропадает на время запроса.
    placeholderData: keepPreviousData,
  });
  /** Куда ведёт карточка серии: своя площадка — её сцена, серия по ссылке — страница серии здесь. */
  const enter = (entry: CinemaItem) => {
    if (entry.provider !== provider) {
      if (knownProvider(entry.provider))
        meeting.openCinema(entry.provider, { page: pageOf(entry), kind: entry.kind, id: entry.id });
      return;
    }
    go({ at: 'item', item: entry });
  };
  const card = (entry: CinemaItem) => (
    <Tile
      key={`${entry.provider}:${entry.kind}:${entry.id}`}
      item={entry}
      playable={playable(entry)}
      canUse={canUse}
      busy={busy}
      onWatch={open}
      onEnter={enter}
      onChannel={() => {}}
    />
  );

  /**
   * Недавние — на этом устройстве (T17): убрать одну или все. Сразу, без вопроса: это свои десять
   * ссылок, а не данные комнаты; серверный кэш разбора (`cinema_links`) общий и здесь не трогается.
   */
  const forget = (url: string) => meeting.media.saveSettings({ cinemaLinks: forgetLink(recent, url) });
  const clearRecent = () => meeting.media.saveSettings({ cinemaLinks: [] });

  /** Ссылка из буфера или из недавних — сразу, без паузы на набор. */
  const choose = (url: string) => {
    setQuery(url);
    setSettled(url);
    home();
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
        refused ? t(($) => $.cinema.linkScene.clipboardRefused) : t(($) => $.cinema.linkScene.clipboardEmpty),
      );
  };

  return (
    <Shell
      onBack={stack.length > 1 ? back : undefined}
      tabs={
        <span className="cinema-platform" style={accent}>
          <spec.icon size={15} />
          {providerName(t, provider)}
        </span>
      }
      query={query}
      placeholder={t(($) => $.cinema.providers[provider].search)}
      onSearch={(value, whole) => {
        setQuery(value);
        link.cancel();
        if (view.at !== 'home') home();
        if (whole) ask(value);
      }}
      onSubmit={(value) => {
        if (view.at !== 'home') home();
        ask(value);
      }}
      onClear={() => {
        setQuery('');
        setSettled('');
        link.cancel();
      }}
      watching={watching}
      onClose={onClose}
      locked={!canUse}
      error={error}
    >
      {view.at === 'item' ? (
        // Серия плейлиста по ссылке: её страница из того, что служба помнит о ней, и «Все серии» — назад.
        <ItemPage
          item={view.item}
          details={page.details}
          canUse={canUse}
          busy={busy}
          onWatch={open}
          onChannel={() => {}}
          onSeries={() => back()}
        />
      ) : !typed ? (
        <>
          <div className="cinema-empty">
            <Link2 size={40} />
            <b>{t(($) => $.cinema.linkScene.title)}</b>
            <small>{t(($) => $.cinema.linkScene.intro, { providers: listed(t) })}</small>
            <button className="button secondary" onClick={() => void paste()}>
              <ClipboardPaste size={17} /> {t(($) => $.cinema.linkScene.paste)}
            </button>
            {clipboard ? <small role="alert">{clipboard}</small> : null}
          </div>
          {recent.length ? (
            <section className="cinema-link-recent" aria-label={t(($) => $.cinema.linkScene.recent)}>
              <header className="cinema-link-recent-head">
                <h4 className="cinema-heading">
                  <History size={13} /> {t(($) => $.cinema.linkScene.recent)}
                </h4>
                <button
                  className="text-button"
                  aria-label={t(($) => $.cinema.linkScene.clearLabel)}
                  onClick={clearRecent}
                >
                  {t(($) => $.cinema.linkScene.clear)}
                </button>
              </header>
              <ul>
                {recent.map((url) => {
                  const { host, rest } = linkParts(url);
                  return (
                    <li key={url}>
                      <button className="cinema-link-open" title={url} onClick={() => choose(url)}>
                        <Link2 size={15} />
                        <b>{host}</b>
                        <span>{rest}</span>
                      </button>
                      <button
                        className="cinema-link-forget"
                        aria-label={t(($) => $.cinema.linkScene.forget, { address: `${host}${rest}` })}
                        title={t(($) => $.cinema.linkScene.forget, { address: host })}
                        onClick={() => forget(url)}
                      >
                        <X size={15} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
        </>
      ) : typed !== settled && linkOf(typed, true) ? (
        // Набрана руками и ещё не спрошена: спрашивают по Enter или кнопкой, а не на паузу в наборе.
        <div className="cinema-empty">
          <Link2 size={40} />
          <b>{t(($) => $.cinema.linkScene.confirmTitle)}</b>
          <small>{t(($) => $.cinema.linkScene.confirmText)}</small>
          <button className="button primary" onClick={() => ask(query)}>
            <Link2 size={17} /> {t(($) => $.cinema.linkScene.open)}
          </button>
        </div>
      ) : !linkOf(typed, true) ? (
        <Empty text={t(($) => $.cinema.linkScene.notLink)} />
      ) : !current ? null : link.checking === current ? (
        <p className="cinema-waiting" role="status">
          <LoaderCircle size={22} /> {t(($) => $.cinema.linkScene.searching)}
        </p>
      ) : link.problem ? (
        <Failure problem={link.problem} onRetry={() => ask(current)} />
      ) : route && knownProvider(route.provider) ? (
        // Сюда ссылка своей площадки попадает, только если переход не состоялся: дверь — руками.
        <div className="cinema-empty">
          <Link2 size={40} />
          <b>{t(($) => $.cinema.linkScene.providerLink, { name: providerName(t, route.provider) })}</b>
          <button className="button primary" onClick={() => meeting.openCinema(route.provider, atOf(route))}>
            {t(($) => $.cinema.linkScene.openIn, { name: providerName(t, route.provider) })}
          </button>
        </div>
      ) : route ? (
        <Empty text={t(($) => $.cinema.linkScene.unknownProvider)} />
      ) : item?.kind === 'series' ? (
        <>
          <SeriesPage
            series={episodes.data?.pages[0]?.series ?? null}
            title={item.title}
            poster={item.poster}
            season={season || (episodes.data?.pages[0]?.season ?? null)}
            onSeason={setSeason}
            feed={episodes}
            items={cardsOf(episodes.data?.pages)}
            card={card}
            empty={t(($) => $.cinema.linkScene.playlistEmpty)}
          />
          <Facts item={item} />
        </>
      ) : item ? (
        <Result item={item} canUse={canUse} busy={busy} onWatch={(chosen) => void open(chosen)} />
      ) : answer ? (
        <div className="cinema-empty" role="status">
          <Link2 size={40} />
          <b>{answer.reason || t(($) => $.cinema.linkScene.cannotOpen)}</b>
          <small className="cinema-link-address">{current}</small>
        </div>
      ) : null}
    </Shell>
  );
}

/**
 * Что нашлось по ссылке: та же страница ролика, что у площадок из каталога, и под ней — то, по чему
 * решают, включать ли: сайт, ступени качества, дорожки звука и субтитры.
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
      <Facts item={item} />
    </>
  );
}

/** Дорожка словами: как её назвал сайт, а если никак — язык на языке интерфейса (`ru` — «Русский»). */
function trackName(t: Translate, track: CinemaLinkTrack): string {
  return track.label || languageName(t, track.lang) || t(($) => $.cinema.linkScene.untitled);
}

/** Сайт, качество, звук и субтитры — строками «что — какое»; чего сайт не назвал, того и нет. */
function Facts({ item }: { item: CinemaLinkItem }) {
  const { t } = useTranslation();
  const qualities = item.qualities ?? [];
  const audio = item.audio ?? [];
  const captions = item.captions ?? [];
  return (
    <dl className="cinema-link-facts">
      {item.site ? (
        <div>
          <dt>
            <Globe size={14} /> {t(($) => $.cinema.linkScene.site)}
          </dt>
          <dd>{item.site}</dd>
        </div>
      ) : null}
      {qualities.length ? (
        <div>
          <dt>
            <MonitorPlay size={14} /> {t(($) => $.cinema.linkScene.quality)}
          </dt>
          <dd className="cinema-link-qualities">
            {qualities.map((quality) => (
              <span key={quality} className="cinema-chip">
                {quality}
              </span>
            ))}
          </dd>
        </div>
      ) : null}
      {audio.length ? (
        <div>
          <dt>
            <AudioLines size={14} /> {t(($) => $.cinema.linkScene.audio)}
          </dt>
          <dd>{audio.map((track) => trackName(t, track)).join(', ')}</dd>
        </div>
      ) : null}
      {captions.length ? (
        <div>
          <dt>
            <Captions size={14} /> {t(($) => $.cinema.linkScene.captions)}
          </dt>
          <dd>
            {captions
              .map((track) =>
                track.auto
                  ? t(($) => $.cinema.linkScene.recognised, { name: trackName(t, track) })
                  : trackName(t, track),
              )
              .join(', ')}
          </dd>
        </div>
      ) : null}
    </dl>
  );
}
