import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LoaderCircle, Play, SkipForward } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Watch } from '../../../api/types';
import type { Meeting } from '../../../core/meeting';
import { CinemaApi } from '../../../core/cinema';
import { useFullscreen } from '../../../core/fullscreen';
import { t as translate } from '../../../i18n';
import { targetPosition, VISIBLE_DRIFT } from '../../../core/watch';
import { useStore } from '../../primitives';
import { useStageExit } from '../../stage-context';
import { adAt, skipRank, SKIP_STEP_MS } from './ad-breaks';
import { Chrome } from './Chrome';
import type { QualityPage } from './menus/QualityMenu';
import { useCaptions } from './useCaptions';
import { allowed } from '../../../core/permissions';
import { usePlayback } from './usePlayback';
import { nextDue, useNextEpisode } from './useNextEpisode';
import { useEcho, useRoomSync } from './useRoomSync';
import { useWatchKeys } from './useWatchKeys';
import { controlsShown, framePress, playToggle } from './watch-controls';
import { KEY_TEXT, muteToggle, volumeAfter, type WatchAction } from './watch-keys';

/** Сколько пульт висит без движения мыши, прежде чем уйти с кадра вместе с курсором (T19). */
const IDLE_MS = 2500;

/** Сколько висит на кадре отклик клавиши («+10 с») или подсказка, почему она не сработала. */
const HINT_MS = 1800;

/**
 * Кинозал: то, что комната смотрит вместе, своим плеером.
 *
 * ПОЧЕМУ СВОИМ. Раньше здесь стояла рамка YouTube. С машины сервера она работала, у человека —
 * нет: из его сети площадки недоступны, а рамка ходит из браузера, и поделать с этим нельзя
 * ничего. Теперь поток берёт сервер и отдаёт его со своего адреса (`core/cinema/api.ts`), а здесь
 * обычный `<video>` с hls.js. Побочные выгоды оказались крупнее самой починки: настоящий выбор
 * качества (уровни HLS, а не «шестерёнка внутри чужой рамки»), свои элементы управления, ни
 * одного чужого скрипта на странице и строгий CSP обратно.
 *
 * ЧТО ОБЩЕЕ, А ЧТО СВОЁ. Общее — это **что** открыто, идёт ли это и с какой секунды: пауза
 * одна на комнату, и нажать её может каждый, кому комната разрешает трогать интеграции. Своё —
 * то, о чём договариваться не с кем: громкость, качество приёма, полный экран и место в живом
 * эфире. Комната о них не знает и знать не должна.
 *
 * ГДЕ ЛЕЖИТ УПРАВЛЕНИЕ. Поверх кадра, а не полосой под ним, и с автоскрытием. Полоса под
 * кадром выглядела опрятнее, но в полноэкранном режиме разворачивался **только кадр** — и
 * пульт вместе с паузой и громкостью оставался за краем экрана. Поверх кадра эта разница
 * исчезает: разворачивается весь плеер целиком, и в окне, и во весь экран он один и тот же.
 *
 * ИЗ ЧЕГО СОБРАН. Здесь — только сборка: адрес потока и движок (`usePlayback`, `useSource`,
 * `engines/`), субтитры (`useCaptions`), комната (`useRoomSync`) и пульт (`Chrome`). Состояние
 * у каждой части своё, а общее у них одно — окно тишины после своих команд плееру (`useEcho`).
 */
export function WatchTheater({
  meeting,
  watch,
  onBrowse,
}: {
  meeting: Meeting;
  watch: Watch;
  /** Открыть каталог, не закрывая просмотр. */
  onBrowse?: () => void;
}) {
  const { t } = useTranslation();
  const snapshot = useStore(meeting.snapshot);
  const preferences = useStore(meeting.media.preferences);
  /** Зритель ушёл к участникам (R121): плеер спрятан, но идёт — и звучит. */
  const { away } = useStageExit();
  const api = useMemo(() => new CinemaApi(meeting.admission), [meeting]);
  const self = snapshot.participants.find((p) => p.id === meeting.admission.participantId);
  const owner = snapshot.participants.find((p) => p.id === watch.openedBy);
  /**
   * Пауза общая. Право на неё — то же самое право трогать во встрече постороннее: ведущему
   * всегда, остальным пока комната разрешает интеграции. Решает ядро (`watch.control` в
   * `you.can`); здесь оно только показывается кнопками.
   */
  const canControl = allowed(snapshot, meeting.admission.participantId, 'watch.control');
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [idle, setIdle] = useState(false);
  const [menu, setMenu] = useState(false);
  /** Какая страница открыта в шестерёнке: сам список разделов, качество или язык звука. */
  const [menuPage, setMenuPage] = useState<QualityPage>('root');
  const [captionMenu, setCaptionMenu] = useState(false);
  /**
   * Пальцем или мышью.
   *
   * Разница здесь не в удобстве, а в том, что означает нажатие по кадру. Мышь наводится
   * заранее, и пульт под ней уже виден — клик по кадру осмысленно ставит паузу. Палец
   * наводиться не умеет: первое касание в спящем плеере — это «покажи, что тут есть», и
   * принимать его за паузу значит останавливать кино каждый раз, когда до него дотронулись.
   */
  const coarse = useMemo(() => window.matchMedia?.('(pointer: coarse)').matches ?? false, []);
  const screen = useRef<HTMLDivElement>(null);
  /*
    КУДА КЛАДУТСЯ ПОПАПЫ ПЛЕЕРА, И ПОЧЕМУ ЭТО НЕ МЕЛОЧЬ.

    Меню качества и субтитров Base UI по умолчанию уезжают порталом в `body`. В полном экране
    браузер рисует **только поддерево развёрнутого элемента** — и меню открывалось в
    невидимости: нажатие срабатывало, попап существовал, а на экране не менялось ничего.
    Выглядело это как «в полном экране качество не переключается».

    Поэтому портал направлен в сам плеер (`container={screen}`): там он и в обычном режиме, и в
    полном экране лежит внутри того, что видно. Ссылка та же, что у полного экрана, — второй
    якорь развёл бы их однажды по разным элементам.
  */
  // На телефоне полноэкранного режима для чужих элементов нет, и кнопка там раскладывает
  // плеер на всё окно сама — см. {@link useFullscreen}.
  const { full: fullscreen, targetFull, toggle: toggleFullscreen } = useFullscreen(screen);
  const video = useRef<HTMLVideoElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const echo = useEcho();
  const player = usePlayback({ meeting, api, watch, video, echo, preferences });
  const { source, status, setStatus, error } = player;
  const live = watch.kind === 'channel' || !!source?.live;
  const captions = useCaptions({
    meeting,
    watch,
    video,
    playback: player.playback,
    source,
    texts: player.texts,
    preferences,
  });

  /** Пульт живёт, пока в плеере что-то происходит; потом уходит с кадра вместе с курсором. */
  const wake = useCallback(() => {
    setIdle(false);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setIdle(true), IDLE_MS);
  }, []);
  useEffect(() => {
    wake();
    return () => clearTimeout(hideTimer.current);
  }, [wake]);

  const sync = useRoomSync({
    meeting,
    watch,
    live,
    canControl,
    video,
    playback: player.playback,
    echo,
    wake,
    setStatus,
  });
  const { command } = sync;

  /** Громкость до «без звука» — общая у клавиши M и кнопки пульта: туда звук и возвращается. */
  const loudness = useRef(Math.max(8, preferences.watchVolume || 70));
  const [hint, setHint] = useState<{ text: string; at: number } | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const say = useCallback((text: string) => {
    setHint({ text, at: Date.now() });
    clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(null), HINT_MS);
  }, []);
  useEffect(() => () => clearTimeout(hintTimer.current), []);
  const saveVolume = (value: number) => {
    if (value > 0) loudness.current = value;
    meeting.media.saveSettings({ watchVolume: value });
    say(KEY_TEXT.volume(value));
  };
  /** Клавиши плеера (T20): решает `watch-keys.ts`, здесь — только исполнение. */
  const act = (action: WatchAction) => {
    if (action.type === 'toggle') {
      const toggle = playToggle(t, { paused: watch.paused, over: sync.over, playing });
      command(toggle.command);
      say(toggle.label);
    } else if (action.type === 'seek') {
      sync.skip(action.deltaMs);
      say(KEY_TEXT.seek(action.deltaMs));
    } else if (action.type === 'volume') {
      saveVolume(volumeAfter(preferences.watchVolume, action.delta));
    } else if (action.type === 'mute') {
      const next = muteToggle(preferences.watchVolume, loudness.current);
      loudness.current = next.loudness;
      meeting.media.saveSettings({ watchVolume: next.volume });
      say(KEY_TEXT.volume(next.volume));
    } else toggleFullscreen();
  };
  useWatchKeys({
    screen,
    context: { live, canControl, seekable: sync.duration > 0, menuOpen: menu || captionMenu },
    micHotkey: preferences.micHotkey,
    onAction: act,
    onHint: say,
    wake,
    disabled: away,
  });

  /*
    Реклама, которую пометил сам поток (T17, `ad-breaks.ts`). Комната в ней — её пропускает за всех
    первый в очереди (`skipRank`): открывший, потом остальные через полторы секунды каждый, если
    комната всё ещё в рекламе. Без права на пульт не шлют — у таких только подпись.
  */
  const ad = live ? null : adAt(player.breaks, sync.position / 1000);
  const adStart = ad?.start ?? null;
  const adEnd = ad?.end ?? null;
  const rank = skipRank(meeting.admission.participantId, watch.openedBy, snapshot.participants);
  const roomNow = useRef({ watch, command, say });
  useEffect(() => {
    roomNow.current = { watch, command, say };
  });
  useEffect(() => {
    if (adStart === null || adEnd === null || !canControl || watch.paused) return;
    const timer = setTimeout(() => {
      const now = roomNow.current;
      const room = targetPosition(now.watch, meeting.serverNow()) / 1000;
      // Комнату уже увёл кто-то раньше в очереди — второй раз не шлём.
      if (room < adStart || room >= adEnd - 0.5) return;
      now.command('watch.seek', Math.round(adEnd * 1000));
      // Текст рождается по таймеру, вне отрисовки, — глобальным переводом.
      now.say(translate(($) => $.cinema.theater.adSkipped));
    }, rank * SKIP_STEP_MS);
    return () => clearTimeout(timer);
  }, [adStart, adEnd, canControl, watch.paused, rank, meeting]);

  /** Следующая серия (T17): под конец серии и после неё — у площадок, которые её знают. */
  const due = nextDue({ live, over: sync.over, positionMs: sync.position, durationMs: sync.duration });
  const next = useNextEpisode({ api, watch, due });
  const canOpen = allowed(snapshot, meeting.admission.participantId, 'watch.open');
  const openNext = () => {
    if (!next || !canOpen) return;
    void meeting
      .command('watch.open', next.title, undefined, {
        provider: next.provider,
        kind: next.kind === 'channel' ? 'channel' : 'video',
        contentId: next.id,
      })
      .catch((e) => meeting.media.report(e));
  };

  const behind = !live && Math.abs(sync.drift) > VISIBLE_DRIFT;
  // Когда пульт виден — правило в `watch-controls.ts`: по бездействию он уходит и на паузе.
  const showControls = controlsShown({
    idle,
    menuOpen: menu || captionMenu,
    ready: status === 'ready',
  });
  /** Большая кнопка посередине есть только у записи: эфир не останавливают и не мотают. */
  const showCenter = showControls && !live && status === 'ready';
  const { caption, lines } = captions;
  return (
    <section
      className="watch-theater"
      aria-label={t(($) => $.cinema.theater.label)}
      ref={screen}
      data-idle={showControls ? undefined : 'true'}
      data-full={targetFull ? 'true' : undefined}
      onPointerMove={wake}
      onPointerDown={wake}
      onFocusCapture={wake}
    >
      <div className="watch-screen">
        <video
          ref={video}
          className="watch-video"
          playsInline
          poster={source?.poster ?? undefined}
          onClick={() => {
            // Что значит нажатие по кадру — решает `watch-controls.ts`: пальцем и во весь
            // экран это «покажи пульт», мышью в окне — привычная пауза.
            const press = framePress({ coarse, fullscreen, live, canControl });
            if (press === 'wake') wake();
            // Как кнопка «играть/пауза»: досмотренный ролик кадр включает заново, а не «ставит на паузу».
            if (press === 'toggle')
              command(playToggle(t, { paused: watch.paused, over: sync.over, playing }).command);
          }}
          onPlay={() => {
            setPlaying(true);
            setWaiting(false);
            setStatus((current) => (current === 'blocked' ? 'ready' : current));
            sync.played();
          }}
          onPause={() => {
            setPlaying(false);
            sync.paused();
          }}
          onWaiting={() => setWaiting(true)}
          onPlaying={() => setWaiting(false)}
          onLoadedMetadata={() => {
            setStatus('ready');
            sync.loaded();
          }}
          onError={player.mediaError}
        >
          {/*
            Субтитры, которых нет в плейлисте, приезжают отдельным файлом.

            `metadata` — чтобы браузер разобрал дорожку, но не рисовал её сам и чтобы плеер
            не принял её за свою: он держит список своих дорожек и гасит в нём чужие.
            Рисуем мы, из `activeCues`; «спрятана» здесь значит «работает молча».
          */}
          {caption?.url && (
            <track
              key={caption.id}
              kind="metadata"
              src={caption.url}
              label={caption.label}
              ref={(node) => {
                if (node?.track) node.track.mode = 'hidden';
              }}
            />
          )}
        </video>
        {!!lines.length && (
          <div className="watch-captions" aria-live="polite">
            {/* Ключ по месту, а не по тексту: у бегущей строки распознанной речи соседние
                реплики бывают дословно одинаковыми, и текст ключом быть не может. */}
            {lines.map((line, index) => (
              <span key={index}>{line}</span>
            ))}
          </div>
        )}
        {status === 'ready' && waiting && playing && (
          <div className="watch-buffering" role="status" aria-label={t(($) => $.cinema.theater.buffering)}>
            <LoaderCircle size={32} />
          </div>
        )}
        {next && due && (
          <div className="watch-next">
            <small>{t(($) => $.cinema.theater.next)}</small>
            <b>{next.title}</b>
            {canOpen ? (
              <button className="button primary" onClick={openNext}>
                <SkipForward size={16} /> {t(($) => $.cinema.theater.nextPlay)}
              </button>
            ) : (
              <small>{t(($) => $.cinema.theater.nextLocked)}</small>
            )}
          </div>
        )}
        {hint && (
          <div key={hint.at} className="watch-hint" role="status">
            {hint.text}
          </div>
        )}
        {status !== 'ready' && (
          <div className="watch-overlay" role="status">
            {status === 'loading' && (
              <span className="watch-loading">
                <LoaderCircle size={32} />
                {t(($) => $.cinema.theater.opening)}
              </span>
            )}
            {status === 'blocked' && (
              <button
                className="button primary"
                onClick={() => {
                  echo.suppress();
                  void video.current?.play();
                  setStatus('ready');
                }}
              >
                <Play size={20} /> {t(($) => $.cinema.theater.start)}
              </button>
            )}
            {status === 'failed' && <span className="watch-error">{error}</span>}
          </div>
        )}
        <Chrome
          meeting={meeting}
          watch={watch}
          source={source}
          live={live}
          canControl={canControl}
          owner={owner}
          self={self}
          onBrowse={onBrowse}
          shown={showControls}
          center={showCenter}
          playing={playing}
          behind={behind}
          volume={preferences.watchVolume}
          loudness={loudness}
          sync={sync}
          ad={ad}
          player={player}
          captions={captions}
          menu={menu}
          onMenu={setMenu}
          menuPage={menuPage}
          onMenuPage={setMenuPage}
          captionMenu={captionMenu}
          onCaptionMenu={setCaptionMenu}
          screen={screen}
          fullscreen={fullscreen}
          onFullscreen={toggleFullscreen}
        />
      </div>
    </section>
  );
}

/*
  Ленивая загрузка: hls.js весит больше всего остального интерфейса вместе взятого, а нужен
  только тем, у кого во встрече открыт кинозал. Грузить его каждому, кто просто зашёл
  поговорить, — это лишние сотни килобайт на первом экране.
*/
export default WatchTheater;
