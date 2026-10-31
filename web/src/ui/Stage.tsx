import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  HeadphoneOff,
  MicOff,
  MonitorUp,
  MonitorX,
  PinOff,
  WifiLow,
  ZoomIn,
  ZoomOut,
  RotateCcw,
} from 'lucide-react';
import { Track, TrackEvent, RemoteAudioTrack } from 'livekit-client';
import { useTranslation } from 'react-i18next';
import type { MediaTile } from '../media/session';
import type { Meeting } from '../core/meeting';
import { PROVIDERS } from '../core/cinema';
import { knownProvider } from '../core/cinema/link';
import { stageOccupant, stageView } from '../core/stage-view';
import { ParticipantMenu } from './ParticipantMenu';
import { Avatar, useMediaQuery, useStore } from './primitives';
import { IconButton } from './kit';
import { LensSwitch } from './CameraMenu';
import { useVoiceTier } from './useVoice';
import { focusedParticipant } from './focus';
import { gridPlan } from './grid';
import { applyVolumeNow } from '../media/volume';
import { SCENES } from './cinema/scenes';
import { integrationName } from './notch-state';
import { leaveToPeople, StageExitContext } from './stage-context';
import './video-paused.css';

const WatchTheater = lazy(() => import('./cinema/theater/WatchTheater'));
const PokerTable = lazy(() => import('./PokerTable'));
const DurakTable = lazy(() => import('./DurakTable'));
const ChessTable = lazy(() => import('./ChessTable'));
const GarticTable = lazy(() => import('./GarticTable'));

/**
 * Показывать ли себя зеркально.
 *
 * Зеркалят себя, а не камеру: человек привык к отражению и по нему поправляет причёску.
 * Но у задней камеры отражения нет — там вы смотрите **на** мир, а не на себя, и зеркало
 * означает, что рука уезжает влево, когда её ведут вправо. Поэтому признак — не «моя
 * дорожка», как было, а куда камера смотрит.
 *
 * `environment` — единственное, что отменяет зеркало. Настольные камеры не сообщают
 * `facingMode` вовсе, и отсутствие ответа обязано означать «зеркалить»: они фронтальные.
 */
export function mirrored(tile: Pick<MediaTile, 'local' | 'source' | 'track'>) {
  if (!tile.local || tile.source !== Track.Source.Camera) return false;
  return tile.track.mediaStreamTrack?.getSettings().facingMode !== 'environment';
}

function VideoTrack({
  tile,
  screen = false,
  onPlaying,
}: {
  tile: MediaTile;
  screen?: boolean;
  onPlaying?: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    tile.track.attach(element);
    element.muted = true;
    const mirror = () => {
      element.style.transform = mirrored(tile) ? 'scaleX(-1)' : 'none';
    };
    mirror();
    /*
      Пропорции плитки — по кадру, а не по вкусу вёрстки.

      Телефон отдаёт вертикальный кадр, плитка была ландшафтной, и `object-fit: contain`
      честно вписывал портрет в середину, оставляя по бокам две трети черноты. Обрезать
      вместо этого нельзя: у вертикального кадра срежется голова. Поэтому плитка принимает
      пропорции источника — тогда вписывать уже нечего.

      Размер известен только после метаданных и меняется на смену камеры, поэтому не
      считается один раз.

      Плитку находим сейчас, пока `<video>` в ней: уборка этого эффекта идёт уже после того,
      как React вынул видео из документа, и `closest` оттуда не находит ничего — портрет
      оставался на аватаре выключившего камеру.
    */
    const owner = screen ? null : element.closest<HTMLElement>('.person-tile');
    const fit = () => {
      if (!owner || !element.videoWidth || !element.videoHeight) return;
      owner.style.setProperty('--tile-aspect', `${element.videoWidth} / ${element.videoHeight}`);
    };
    fit();
    element.addEventListener('loadedmetadata', fit);
    element.addEventListener('resize', fit);
    // Переворот камеры пересобирает дорожку, а не создаёт новую плитку, поэтому решение о
    // зеркале нужно принимать заново здесь: `Restarted` — единственное место, где об этом
    // вообще становится известно.
    tile.track.on(TrackEvent.Restarted, mirror);
    return () => {
      element.removeEventListener('loadedmetadata', fit);
      element.removeEventListener('resize', fit);
      tile.track.off(TrackEvent.Restarted, mirror);
      tile.track.detach(element);
      // Дорожка ушла — пропорции вместе с ней: иначе аватар унаследует форму чужого кадра.
      owner?.style.removeProperty('--tile-aspect');
    };
  }, [tile.track, tile.local, screen]);
  return (
    <video
      ref={ref}
      onPlaying={onPlaying}
      autoPlay
      playsInline
      muted
      className={screen ? 'screen-video' : 'camera-video'}
      aria-label={
        screen
          ? t(($) => $.stage.screenOf, { name: tile.name })
          : t(($) => $.stage.cameraOf, { name: tile.name })
      }
    />
  );
}
/**
 * «Видео приостановлено: слабая связь» (R117) — SFU перестал слать нам эту картинку, чтобы сберечь
 * речь и музыку. Тон спокойный, не тревога: делать человеку нечего, видео вернётся само. Задержку
 * против мигания уже выдержала сессия (`media/video-pause.ts`), здесь только слова.
 */
function VideoPausedNote({ announce = false }: { announce?: boolean }) {
  const { t } = useTranslation();
  const text = t(($) => $.stage.videoPaused);
  return (
    // Объявляет только показ: плиток на паузе бывает несколько разом, и читать надпись каждой —
    // шум. На плитке её видно, а полностью — подсказкой, когда подпись обрезана.
    <span className="video-paused" role={announce ? 'status' : undefined} title={text}>
      <WifiLow size={16} aria-hidden="true" />
      <span>{text}</span>
    </span>
  );
}
function AudioTrack({ tile, onBlocked, volume }: { tile: MediaTile; onBlocked: () => void; volume: number }) {
  const ref = useRef<HTMLAudioElement>(null);
  // Громкость на момент подключения читается из ref, а не из зависимостей: менять её не значит
  // переподключать дорожку.
  const level = useRef(volume);
  level.current = volume;
  useEffect(() => {
    const audio = ref.current;
    if (!audio) return;
    tile.track.attach(audio);
    // Узел усиления только что родился на 1: убавленная до нуля музыка не должна прозвучать ни
    // одного отсчёта, пока LiveKit плавно ведёт громкость к выбранной (T49, `media/volume.ts`).
    if (tile.track instanceof RemoteAudioTrack)
      applyVolumeNow(tile.track as unknown as Parameters<typeof applyVolumeNow>[0], level.current);
    void audio.play().catch(onBlocked);
    return () => {
      tile.track.detach(audio);
    };
  }, [tile.track, onBlocked]);
  useEffect(() => {
    if (tile.track instanceof RemoteAudioTrack) tile.track.setVolume(volume);
  }, [tile.track, volume]);
  return <audio ref={ref} autoPlay />;
}
export function AudioLayer({
  tracks,
  onBlocked,
  volumes,
  deafened,
  master = 1,
}: {
  tracks: MediaTile[];
  onBlocked: () => void;
  volumes: Record<string, number>;
  deafened: boolean;
  /** Громкость собеседников из настроек, 0–1: поверх громкости каждого, не вместо неё. */
  master?: number;
}) {
  return (
    <div className="audio-layer">
      {tracks
        .filter((t) => !t.local && t.track.kind === Track.Kind.Audio)
        .map((t) => (
          <AudioTrack
            key={t.id}
            tile={t}
            onBlocked={onBlocked}
            volume={deafened ? 0 : (volumes[t.participantId] ?? 1) * master}
          />
        ))}
    </div>
  );
}
/**
 * Обводка говорящего — внутрь плитки, четырьмя оттенками зелёного по громкости (T23).
 *
 * Отдельный компонент, чтобы ступень перерисовывала только эту рамку, а не всю сцену: уровень
 * меняется до 30 раз в секунду (`media/levels.ts`), и сетка с видео от этого вздрагивать не
 * должна. Порядок плиток от громкости не зависит.
 */
function VoiceRing({ meeting, id }: { meeting: Meeting; id: string }) {
  const tier = useVoiceTier(meeting, id);
  return <span className="person-voice" data-voice={tier || undefined} aria-hidden="true" />;
}

export function Stage({ meeting }: { meeting: Meeting }) {
  const { t } = useTranslation();
  const snapshot = useStore(meeting.snapshot);
  const participants = snapshot.participants;
  const tracks = useStore(meeting.media.tracks);
  const viewing = useStore(meeting.viewing);
  const pinned = useStore(meeting.pinnedCamera);
  // SFU, а не свой замер: крупный план «Говорящего» должен залипать, а не прыгать на каждом слоге.
  const speaking = useStore(meeting.media.speaking);
  const previews = useStore(meeting.media.screenPreviews);
  const pausedVideo = useStore(meeting.media.videoPaused);
  const cinema = useStore(meeting.cinema);
  const cinemaAt = useStore(meeting.cinemaAt);
  const layout = useStore(meeting.media.preferences).layout;
  /** От какой интеграции этот зритель ушёл к участникам (R121) — у себя, комната об этом не знает. */
  const away = useStore(meeting.stageAway);
  /** Касание: показ в пульте не кнопкой, а пунктом «ещё» — останавливают его со своей плитки. */
  const coarse = useMediaQuery('(pointer: coarse)');
  /** Кто показан крупно сейчас: нужен, чтобы выбор залипал, а не прыгал на каждом слоге. */
  const [focus, setFocus] = useState<string | null>(null);
  /*
    Настоящий размер сцены. Раскладка считается по нему, а не по числу людей: одна и та же
    четвёрка на мониторе просит два ряда по двое, а в узком окне с открытой панелью — колонку,
    и подобрать это заранее в CSS нечем. Элемент приходит колбэком, а не ref: сцена исчезает
    на время просмотра чужого экрана и рождается заново, и наблюдатель обязан переехать вместе
    с ней.
  */
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!stage || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const { width, height } = stage.getBoundingClientRect();
      // Дробные доли пикселя приходят десятками в секунду при любом движении панели, а
      // раскладку не меняют: пересчитывать на них — это перерисовывать сцену впустую.
      setBox((current) =>
        Math.abs(current.width - width) < 1 && Math.abs(current.height - height) < 1
          ? current
          : { width, height },
      );
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, [stage]);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [viewing?.screenId]);
  /*
    Кто показан крупно — считается здесь, до всех выходов из компонента.

    Просмотр чужого экрана возвращает другую сцену раньше, и хук, поставленный после этого
    возврата, перестал бы вызываться ровно в тот момент, когда просмотр открывают. React
    считает хуки по порядку, а не по имени: это не «лишний рендер», а падение всего экрана
    встречи. Стоило одного зелёного прогона e2e, чтобы это стало видно.
  */
  const people = participants.filter((p) => !p.service && p.status !== 'WAITING');
  const focused = focusedParticipant({
    pinned,
    speaking,
    current: focus,
    people: people.map((p) => p.id),
  });
  useEffect(() => {
    if (focused !== focus) setFocus(focused);
  }, [focused, focus]);
  const plan = useMemo(() => gridPlan(people.length, box), [people.length, box]);
  /*
    Кто крупно над лентой остальных (R83, R84): закреплённый руками — в любой раскладке, а в
    «Говорящем» — тот, кто держит слово. Раньше в сетке закрепление ставило только рамку `inset`,
    которую кадр камеры закрывал целиком, — снаружи не менялось ничего. Одному крупно не с кем
    делиться сценой: он и так во всю сцену.
  */
  const pinnedHere = pinned && people.some((p) => p.id === pinned) ? pinned : null;
  const spotlight = people.length > 1 ? (pinnedHere ?? (layout === 'speaker' ? focused : null)) : null;
  /**
   * Одна и та же плитка и в сетке, и в ленте под общим плеером: в кинозале у неё отбирают
   * только место в сетке. Разводить это на два похожих куска разметки значило бы чинить
   * подписи, обводку говорящего и меню участника дважды.
   */
  const tile = (person: (typeof people)[number], index: number, placed: boolean) => {
    const camera = tracks.find(
      (t) => t.participantId === person.id && t.source === Track.Source.Camera && !t.muted,
    );
    const mic = tracks.find(
      (t) => t.participantId === person.id && t.source === Track.Source.Microphone && !t.muted,
    );
    const self = person.id === meeting.admission.participantId;
    const sharing = !!(person.screen && person.screenId && person.screenStarted);
    // Слот взят, а кадра целевого качества ещё нет: показ открывается зрителям после него (T48).
    const preparing = !!(person.screen && person.screenId && !person.screenStarted);
    /*
      Пауза камеры от SFU (R117) — надпись сверху плитки, на месте «Восстанавливаем связь…», и одна
      из двух по старшинству:
      1. камера выключена или ещё не пришла — паузы нет: приглушать нечего, на плитке аватар;
      2. участник переподключается — «Восстанавливаем связь…»: кадр стоит из-за него, а не из-за
         нашего канала, и «слабая связь» на его плитке указала бы не туда;
      3. иначе — «Видео приостановлено: слабая связь».
      «Готовится показ…» и «Смотреть стрим» — про экран и живут в середине плитки: с паузой камеры
      они не спорят. Своё переподключение и зависание кадра решает сессия: надписи гаснут, пока нет
      связи, а сторож зависаний не трогает дорожку на паузе.
    */
    const recovering = person.status === 'RECOVERING';
    const paused = !!camera && !recovering && !!pausedVideo[camera.id];
    return (
      <ParticipantMenu
        meeting={meeting}
        person={person}
        key={person.id}
        className="person-tile"
        data-sharing={sharing ? 'true' : undefined}
        data-paused={paused ? 'true' : undefined}
        data-pinned={pinned === person.id ? 'true' : undefined}
        // Крупно над лентой — закреплённый или говорящий. Смена говорящего переносит две плитки
        // между крупным местом и лентой; выбор залипает (`ui/focus.ts`), так что это редкость.
        data-focused={spotlight === person.id ? 'true' : undefined}
        style={
          placed && plan.cells[index]
            ? ({
                gridRow: plan.cells[index].row,
                gridColumn: `${plan.cells[index].column} / span 2`,
              } as CSSProperties)
            : undefined
        }
      >
        {camera ? (
          <VideoTrack tile={camera} />
        ) : (
          <div className="person-placeholder">
            {sharing && (
              <div
                className="screen-preview"
                aria-hidden="true"
                style={previews[person.id] ? { backgroundImage: `url(${previews[person.id]})` } : undefined}
              />
            )}
            <Avatar name={person.name} src={person.avatar} large />
          </div>
        )}
        {/* Обводка вместо надписи: кто говорит, узнаётся боковым зрением. Заглушённый микрофон
            рядом остаётся отдельным знаком — на цвет полагаться нельзя. */}
        <VoiceRing meeting={meeting} id={person.id} />
        <div className="person-caption">
          {/* Наушники (R156): человек выключил у себя звук встречи и сейчас никого не слышит. */}
          {person.deafened ? (
            <HeadphoneOff size={16} aria-label={t(($) => $.stage.deafened)} />
          ) : (
            !mic && <MicOff size={16} aria-label={t(($) => $.stage.micOff)} />
          )}
          <span>
            {person.name}
            {self ? t(($) => $.stage.you) : ''}
          </span>
        </div>
        {self && camera && <LensSwitch meeting={meeting} tile={camera} />}
        {/* Закреплённая — с кнопкой «Открепить» на самой плитке: меню «…» не единственный путь назад. */}
        {pinned === person.id && (
          <button
            type="button"
            className="tile-unpin"
            aria-label={t(($) => $.stage.unpinOf, { name: person.name })}
            title={t(($) => $.stage.unpinOf, { name: person.name })}
            onClick={() => meeting.unpinCamera()}
          >
            <PinOff aria-hidden="true" />
            <span>{t(($) => $.stage.unpin)}</span>
          </button>
        )}
        {preparing && (
          <span className="watch-stream is-preparing" role="status">
            <MonitorUp size={16} />
            <span>{t(($) => $.stage.preparing)}</span>
          </span>
        )}
        {sharing &&
          (self ? (
            coarse ? (
              /* На телефоне кнопки показа в пульте нет (там переворот камеры) — остановить показ
                 можно прямо со своей плитки, красной кнопкой с крестиком (R77). Она же и говорит,
                 что показ идёт: длинная подпись «Вы показываете экран» здесь лишняя (R27). */
              <button
                type="button"
                className="watch-stream is-stop"
                onClick={() => void meeting.media.stopScreen()}
              >
                <MonitorX size={16} aria-hidden="true" />
                <span>{t(($) => $.dock.unshare)}</span>
              </button>
            ) : (
              <span className="watch-stream is-own">
                <MonitorUp size={16} />
                <span>{t(($) => $.stage.sharing)}</span>
                <span className="live-badge">LIVE</span>
              </span>
            )
          ) : (
            <button className="watch-stream" onClick={() => meeting.openStream(person.id)}>
              <MonitorUp size={16} />
              <span>{t(($) => $.stage.watch)}</span>
              <span className="live-badge">LIVE</span>
            </button>
          ))}
        {recovering && <div className="tile-recovery">{t(($) => $.stage.recovering)}</div>}
        {paused && <VideoPausedNote />}
      </ParticipantMenu>
    );
  };
  /** Чужой экран во всю сцену — с лупой и перетаскиванием увеличенного кадра. */
  const screenView = (viewing: { screenId: string; participantId: string }) => {
    const screen = tracks.find(
      (t) => t.participantId === viewing.participantId && t.source === Track.Source.ScreenShare && !t.muted,
    );
    // Пауза показа (R117) — только поверх кадра, который уже есть («Подключаемся к стриму…» старше),
    // и не у переподключающегося показывающего: тогда кадр стоит из-за него, а не из-за нашего канала.
    const sharer = participants.find((p) => p.id === viewing.participantId);
    const paused = !!screen && sharer?.status !== 'RECOVERING' && !!pausedVideo[screen.id];
    return (
      <div className="stage watch-stage media-stage" data-paused={paused ? 'true' : undefined}>
        <div
          className="screen-viewport"
          style={{ touchAction: zoom > 1 ? 'none' : 'auto' }}
          onPointerDown={(e) => {
            if (zoom <= 1) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
          }}
          onPointerMove={(e) => {
            if (!drag.current) return;
            const b = e.currentTarget.getBoundingClientRect();
            setPan({
              x: Math.max(
                (-b.width * (zoom - 1)) / 2,
                Math.min((b.width * (zoom - 1)) / 2, drag.current.px + e.clientX - drag.current.x),
              ),
              y: Math.max(
                (-b.height * (zoom - 1)) / 2,
                Math.min((b.height * (zoom - 1)) / 2, drag.current.py + e.clientY - drag.current.y),
              ),
            });
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
        >
          {screen ? (
            <div
              className="screen-transform"
              style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
            >
              <VideoTrack tile={screen} screen onPlaying={() => meeting.screenPlaying(viewing.screenId)} />
            </div>
          ) : (
            <div className="stream-loading" role="status">
              {t(($) => $.stage.streamConnecting)}
            </div>
          )}
          {paused && <VideoPausedNote announce />}
        </div>
        <div className="screen-tools">
          <IconButton
            tone="stage"
            label={t(($) => $.stage.zoomOut)}
            disabled={zoom <= 1}
            onClick={() => {
              setZoom((z) => Math.max(1, z - 0.5));
              setPan({ x: 0, y: 0 });
            }}
          >
            <ZoomOut size={20} />
          </IconButton>
          <span>{Math.round(zoom * 100)}%</span>
          <IconButton
            tone="stage"
            label={t(($) => $.stage.zoomIn)}
            disabled={zoom >= 4}
            onClick={() => setZoom((z) => Math.min(4, z + 0.5))}
          >
            <ZoomIn size={20} />
          </IconButton>
          <IconButton
            tone="stage"
            label={t(($) => $.stage.fit)}
            onClick={() => {
              setZoom(1);
              setPan({ x: 0, y: 0 });
            }}
          >
            <RotateCcw size={20} />
          </IconButton>
        </div>
      </div>
    );
  };
  /*
    Каталог — сцена площадки из реестра. Ключ — сама сцена, а не площадка: вкладки внутри
    одной сцены (YouTube ↔ Twitch) переключаются без пересоздания, а другая сцена — это
    другой каталог и начинается заново.

    Площадку называет и комната («Каталог» на плеере открывает ту, что смотрят), а комната знает
    столько площадок, сколько её ядро, а не эта сборка: вкладка, открытая до выкатки новой площадки,
    или имя, которое ядро ещё пропускает. У незнакомой площадки нет ни сцены, ни «Каталога»:
    `PROVIDERS[…]` без проверки дал бы `undefined`, отрисовка упала бы, а с ней — вся встреча
    (границы ошибок у приложения нет). Плеер при этом остаётся и говорит отказ службы сам.
  */
  const scene = cinema && knownProvider(cinema) ? PROVIDERS[cinema].scene : null;
  const Scene = scene ? SCENES[scene] : null;
  const watch = snapshot.watch;
  /*
    Что занимает сцену и что из этого видит этот зритель (R121, `core/stage-view.ts`): интеграцию, людей
    (ушёл от неё или смотрит чужой экран) или обычную встречу, когда сцена свободна.
  */
  const occupant = stageOccupant(snapshot, !!Scene);
  const view = stageView(occupant, away, !!viewing);
  const hidden = view === 'people';
  const exit = useMemo(() => ({ away: hidden, leave: () => leaveToPeople(meeting) }), [hidden, meeting]);
  /*
    Слой интеграции (R121). Ушедшему к участникам он не размонтируется, а прячется в том же узле
    (`data-away`, `inert`, `stage.css`): кинозал — это `<video>` с буфером и синхронностью, и рождённый
    заново он грузился бы с нуля; столы держат звук хода, открытый лист, выбранную карту и ползунок
    ставки. Ключ — вид интеграции: на её месте в дереве другой слой не встанет. Лента лиц под столом и
    плеером у ушедшего пуста — люди и так во всю сцену, — но её место остаётся, чтобы плеер не менял
    размер (hls.js выбирает качество по размеру кадра).
  */
  const layer = (
    kind: string,
    className: string,
    children: ReactNode,
    attributes: Record<string, string> = {},
  ) => (
    <div
      key={kind}
      className={`stage ${className} media-stage`}
      data-stage-layer={kind}
      data-away={hidden ? 'true' : undefined}
      aria-hidden={hidden || undefined}
      inert={hidden}
      {...attributes}
    >
      <StageExitContext.Provider value={exit}>{children}</StageExitContext.Provider>
    </div>
  );
  /** Лента лиц под столом и плеером; у ушедшего — пустое место той же высоты. */
  const strip = (list: typeof people) =>
    hidden ? (
      <div className="people-strip media-stage" aria-hidden="true" data-count={0} />
    ) : (
      <div className="people-strip media-stage" data-count={list.length}>
        {list.map((person, index) => tile(person, index, false))}
      </div>
    );
  /** Кто смотрит стол, а не сидит за ним, — их лица лентой под столом. */
  const watchersOf = (seats: readonly { memberId?: string | null }[]) =>
    people.filter((person) => !seats.some((seat) => seat.memberId === person.id));

  let integration: ReactNode = null;
  /*
    Карточный стол. В отличие от кинозала, лента под ним — не все, а **только зрители**: лица
    играющих уже на столе, в кружках их мест, и показывать их вторым рядом значило бы отобрать
    у стола половину сцены ради повторения.

    Столы и кинозал — медиасцена (E16): `.media-stage` на обёртке делает смысловые токены внутри
    сценными в обеих темах, как у разговорной сцены. Шахматы и рисование раньше нарочно жили в
    теме человека (E04-3); визуальная волна перевела их CSS на токены, и сцена у всех одна.
  */
  if (occupant?.kind === 'chess' || occupant?.kind === 'gartic') {
    integration = layer(
      occupant.kind,
      'room-game-stage',
      <Suspense
        fallback={
          <div role="status" className="poker-loading">
            {t(($) => $.stage.gameLoading)}
          </div>
        }
      >
        {occupant.kind === 'chess' ? <ChessTable meeting={meeting} /> : <GarticTable meeting={meeting} />}
      </Suspense>,
    );
  } else if (occupant?.kind === 'poker' && snapshot.poker) {
    const table = snapshot.poker;
    const watchers = watchersOf(table.seats);
    integration = layer(
      'poker',
      'poker-stage',
      <>
        <div className="poker-main">
          <Suspense fallback={<div className="poker-loading" />}>
            <PokerTable meeting={meeting} table={table} />
          </Suspense>
        </div>
        {watchers.length > 0 && strip(watchers)}
      </>,
    );
  } else if (occupant?.kind === 'durak' && snapshot.durak) {
    // Стол дурака живёт на сцене по тем же правилам, что покерный: лица играющих — в кружках их
    // мест, а лента под столом остаётся зрителям.
    const table = snapshot.durak;
    const watchers = watchersOf(table.seats);
    integration = layer(
      'durak',
      'poker-stage',
      <>
        <div className="poker-main">
          <Suspense fallback={<div className="durak-loading" />}>
            <DurakTable meeting={meeting} table={table} />
          </Suspense>
        </div>
        {watchers.length > 0 && strip(watchers)}
      </>,
    );
  } else if (occupant?.kind === 'cinema') {
    /*
      Кинозал. Комната смотрит одно на всех, поэтому сцена перестраивается у каждого: плеер
      занимает середину, а люди сжимаются в ленту под ним — их по-прежнему видно и слышно, но
      главное на экране теперь не они.

      Каталог живёт здесь же и **поверх** плеера, а не вместо него: пока один выбирает, чем
      продолжить, комната продолжает смотреть — и разбирать плеер ради чужого выбора значило бы
      остановить фильм всем.

      `data-film` — комната смотрит фильм: на телефоне с открытым листом панели плеер встаёт
      полосой над листом, а лист опускается под неё (R120, `cinema/cinema.css`).
    */
    integration = layer(
      'cinema',
      'watch-together-stage',
      <>
        <div className="watch-main">
          {watch && (
            <Suspense fallback={<div className="watch-screen" />}>
              <WatchTheater
                meeting={meeting}
                watch={watch}
                onBrowse={
                  knownProvider(watch.provider) ? () => meeting.openCinema(watch.provider) : undefined
                }
              />
            </Suspense>
          )}
          {cinema && Scene && (
            <Suspense fallback={<div className="cinema-browser" />}>
              <Scene
                key={scene}
                meeting={meeting}
                provider={cinema}
                at={cinemaAt}
                onProvider={(next) => meeting.openCinema(next)}
                onClose={() => meeting.openCinema(null)}
              />
            </Suspense>
          )}
        </div>
        {strip(people)}
      </>,
      watch ? { 'data-film': 'true' } : {},
    );
  }

  let peopleView: ReactNode = null;
  if (view !== 'integration') {
    if (viewing) peopleView = screenView(viewing);
    else if (spotlight) {
      const big = people.find((person) => person.id === spotlight)!;
      // В ленте своя плитка первой — её ищут глазами чаще прочих (Discord, Телемост).
      const self = meeting.admission.participantId;
      const rest = people
        .filter((person) => person.id !== spotlight)
        .sort((a, b) => Number(b.id === self) - Number(a.id === self));
      peopleView = (
        <div
          className="stage conversation-stage camera-stage media-stage"
          data-layout={layout}
          data-spotlight="true"
        >
          <div className="spotlight-main">{tile(big, 0, false)}</div>
          <div className="people-strip spotlight-strip media-stage" data-count={rest.length}>
            {rest.map((person, index) => tile(person, index, false))}
          </div>
        </div>
      );
    } else
      peopleView = (
        <div className="stage conversation-stage camera-stage media-stage" data-layout={layout}>
          <div
            className="people-grid"
            data-count={people.length}
            ref={setStage}
            /*
              Колонок объявляется вдвое больше, чем плиток в ряду, и каждая плитка занимает две
              доли. Это единственный способ поставить неполный ряд ровно посередине: «половины
              колонки» в grid нет, и трое под четырьмя всегда прижимались бы к левому краю.
            */
            style={
              layout === 'grid'
                ? {
                    gridTemplateColumns: `repeat(${plan.columns * 2}, minmax(0, 1fr))`,
                    gridTemplateRows: `repeat(${plan.rows}, minmax(0, 1fr))`,
                  }
                : undefined
            }
          >
            {people.map((person, index) => tile(person, index, layout === 'grid'))}
          </div>
        </div>
      );
  }
  /*
    Слой интеграции — всегда первым, вид людей — вторым: так смена вида не двигает интеграцию по дереву,
    и React её не пересоздаёт. Строка для диктора говорит, куда человек попал (R121).
  */
  return (
    <>
      {integration}
      {peopleView}
      {/* Пока сцена свободна, говорить не о чем: строка появляется вместе с интеграцией. */}
      {occupant && (
        <span className="stage-announce" role="status">
          {hidden
            ? t(($) => $.stage.exit.announcePeople)
            : t(($) => $.stage.exit.announceIntegration, { name: integrationName(t, occupant.kind) })}
        </span>
      )}
    </>
  );
}
