import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LoaderCircle, Play } from 'lucide-react';
import type { Watch } from '../../../api/types';
import type { Meeting } from '../../../core/meeting';
import { CinemaApi } from '../../../core/cinema';
import { useFullscreen } from '../../../core/fullscreen';
import { VISIBLE_DRIFT } from '../../../core/watch';
import { useStore } from '../../primitives';
import { Chrome } from './Chrome';
import type { QualityPage } from './menus/QualityMenu';
import { useCaptions } from './useCaptions';
import { usePlayback } from './usePlayback';
import { useEcho, useRoomSync } from './useRoomSync';
import { controlsShown, framePress } from './watch-controls';

/** Сколько пульт висит без движения мыши, прежде чем уйти с кадра вместе с курсором. */
const IDLE_MS = 2800;

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
  const snapshot = useStore(meeting.snapshot);
  const preferences = useStore(meeting.media.preferences);
  const api = useMemo(() => new CinemaApi(meeting.admission), [meeting]);
  const self = snapshot.participants.find((p) => p.id === meeting.admission.participantId);
  const owner = snapshot.participants.find((p) => p.id === watch.openedBy);
  /**
   * Пауза общая. Право на неё — то же самое право трогать во встрече постороннее: ведущему
   * всегда, остальным пока комната разрешает интеграции. Ядро проверяет это же правило;
   * здесь оно только показывается кнопками.
   */
  const canControl = !!self && (self.owner || snapshot.integrationsAllowed !== false);
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
      aria-label="Совместный просмотр"
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
            if (press === 'toggle') command(watch.paused ? 'watch.play' : 'watch.pause');
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
          <div className="watch-buffering" role="status" aria-label="Загружаем">
            <LoaderCircle size={34} />
          </div>
        )}
        {status !== 'ready' && (
          <div className="watch-overlay" role="status">
            {status === 'loading' && (
              <span className="watch-loading">
                <LoaderCircle size={30} />
                Открываем…
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
                <Play size={18} /> Смотреть вместе
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
          sync={sync}
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
