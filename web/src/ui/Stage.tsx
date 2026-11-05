import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  HeadphoneOff,
  ImageOff,
  Maximize2,
  MicOff,
  Minimize2,
  MonitorUp,
  PinOff,
  RotateCcw,
  Users,
  WifiLow,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { Track, TrackEvent, RemoteAudioTrack } from 'livekit-client';
import { useTranslation } from 'react-i18next';
import type { MediaTile } from '../media/session';
import type { PauseCause } from '../media/video-pause';
import { videoPool } from '../media/video-pool';
import type { Meeting } from '../core/meeting';
import { PROVIDERS } from '../core/cinema';
import { knownProvider } from '../core/cinema/link';
import { stageOccupant, stageView } from '../core/stage-view';
import { presentations, type Presentation } from '../core/presentation';
import { ParticipantMenu } from './ParticipantMenu';
import { Avatar, useStore } from './primitives';
import { IconButton } from './kit';
import { LensSwitch } from './CameraMenu';
import { OwnCameraChip } from './OwnCameraChip';
import { useVoiceTier } from './useVoice';
import { focusedParticipant } from './focus';
import { gridPlan } from './grid';
import { applyVolumeNow } from '../media/volume';
import { SCENES } from './cinema/scenes';
import { integrationName } from './notch-state';
import { leaveToPeople, StageExitContext } from './stage-context';
import { BoardBoundary } from './board/BoardBoundary';
import './video-paused.css';

const WatchTheater = lazy(() => import('./cinema/theater/WatchTheater'));
const PokerTable = lazy(() => import('./PokerTable'));
const DurakTable = lazy(() => import('./DurakTable'));
const ChessTable = lazy(() => import('./ChessTable'));
const GarticTable = lazy(() => import('./GarticTable'));
/** Доска (R159) — Excalidraw, около мегабайта: грузится, только когда её открыли. */
const BoardStage = lazy(() => import('./board/BoardStage'));

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

/**
 * Экран в кадре. Камера живёт иначе (`CameraVideo`): показ крупно один, переносить его некуда, а своя
 * плитка показа и он сам видны по очереди.
 */
function ScreenVideo({ tile, onPlaying }: { tile: MediaTile; onPlaying?: () => void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    tile.track.attach(element);
    element.muted = true;
    return () => {
      tile.track.detach(element);
    };
  }, [tile.track]);
  return (
    <video
      ref={ref}
      onPlaying={onPlaying}
      autoPlay
      playsInline
      muted
      className="screen-video"
      aria-label={t(($) => $.stage.screenOf, { name: tile.name })}
    />
  );
}
/**
 * Камера в плитке (R189, И5). Сам `<video>` принадлежит дорожке (`media/video-pool.ts`), а не плитке: при
 * переносе между сеткой, крупным местом и лентой он едет с кадром и потоком, и плитка не стоит пустой. Эффект
 * — `useLayoutEffect`: cleanup старой плитки идёт, пока её узлы ещё в документе, установка в новую — до
 * отрисовки.
 */
function CameraVideo({ tile }: { tile: MediaTile }) {
  const { t } = useTranslation();
  const slot = useRef<HTMLDivElement>(null);
  const label = t(($) => $.stage.cameraOf, { name: tile.name });
  useLayoutEffect(() => {
    const host = slot.current;
    if (!host) return;
    const view = videoPool.mount(tile.id, tile.track, host);
    const mirror = () => {
      view.video.style.transform = mirrored(tile) ? 'scaleX(-1)' : 'none';
    };
    mirror();
    /*
      Пропорции плитки — по кадру, а не по вкусу вёрстки.

      Телефон отдаёт вертикальный кадр, плитка была ландшафтной, и `object-fit: contain`
      честно вписывал портрет в середину, оставляя по бокам две трети черноты. Обрезать
      вместо этого нельзя: у вертикального кадра срежется голова. Поэтому плитка принимает
      пропорции источника — тогда вписывать уже нечего.

      Размер известен только после метаданных и меняется на смену камеры, поэтому не
      считается один раз. Перенесённый `<video>` размер уже знает: новая плитка сразу той же формы.

      События медиа не всплывают, поэтому слушаем на перехвате: элемент может смениться (`replace`).
    */
    const owner = host.closest<HTMLElement>('.person-tile');
    const fit = () => {
      const { videoWidth, videoHeight } = view.video;
      if (!owner || !videoWidth || !videoHeight) return;
      owner.style.setProperty('--tile-aspect', `${videoWidth} / ${videoHeight}`);
    };
    fit();
    host.addEventListener('loadedmetadata', fit, true);
    host.addEventListener('resize', fit, true);
    // Переворот камеры пересобирает дорожку, а не создаёт новую плитку, поэтому решение о
    // зеркале нужно принимать заново здесь: `Restarted` — единственное место, где об этом
    // вообще становится известно.
    tile.track.on(TrackEvent.Restarted, mirror);
    return () => {
      host.removeEventListener('loadedmetadata', fit, true);
      host.removeEventListener('resize', fit, true);
      tile.track.off(TrackEvent.Restarted, mirror);
      view.unmount();
      // Дорожка ушла — пропорции вместе с ней: иначе аватар унаследует форму чужого кадра.
      owner?.style.removeProperty('--tile-aspect');
    };
  }, [tile.id, tile.track, tile.local]);
  useLayoutEffect(() => {
    slot.current?.querySelector('video')?.setAttribute('aria-label', label);
  }, [label, tile.id, tile.track, tile.local]);
  return <div ref={slot} className="video-slot" />;
}
/**
 * Почему картинка стоит — значком в углу, сам кадр остаётся как был (R117, R189). Тон спокойный: делать
 * человеку нечего. «Слабая связь» — только когда так сказал SFU (`sfu`: он перестал слать нам картинку, чтобы
 * сберечь речь и музыку). Кадров нет, а SFU молчит (`silent`) — причина неизвестна, камера могла встать и у
 * отправителя, поэтому и слова другие. Задержку против мигания уже выдержала сессия
 * (`media/video-pause.ts`), здесь только слова.
 */
function VideoPausedNote({ cause, announce = false }: { cause: PauseCause; announce?: boolean }) {
  const { t } = useTranslation();
  const text = cause === 'sfu' ? t(($) => $.stage.videoPaused) : t(($) => $.stage.videoStalled);
  const Icon = cause === 'sfu' ? WifiLow : ImageOff;
  return (
    // Объявляет только показ: плиток на паузе бывает несколько разом, и читать надпись каждой —
    // шум. На плитке её видно, а полностью — подсказкой, когда подпись обрезана.
    <span className="video-paused" role={announce ? 'status' : undefined} title={text}>
      <Icon size={16} aria-hidden="true" />
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

/**
 * Полный экран встречи (R187): у показа — своя кнопка «На весь экран» и двойной щелчок по кадру. Цель та же,
 * что у кнопки пульта, — документ целиком (`MeetingView.tsx`): так в полном экране работают меню, панели и пульт.
 */
export interface StageFullscreen {
  /** Встреча развёрнута на весь экран. */
  full: boolean;
  toggle: () => void;
}

export function Stage({ meeting, fullscreen }: { meeting: Meeting; fullscreen?: StageFullscreen }) {
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
    Лента участников в полном экране (R187). Развернули — значит, хотят показ целиком: экран на всю ширину, лента
    спрятана, как «развернуть демонстрацию» у Телемоста и «В центре внимания» у Meet. Вернуть лицо рядом — кнопкой
    «Показать участников»; выбор живёт до конца встречи.
  */
  const [stripInFull, setStripInFull] = useState(false);
  // Сцена сменила размер — сдвиг увеличенного кадра считался по прежней и может увести кадр за край.
  useEffect(() => setPan({ x: 0, y: 0 }), [fullscreen?.full]);
  /*
    Кто показан крупно — считается здесь, до всех выходов из компонента.

    Просмотр чужого экрана возвращает другую сцену раньше, и хук, поставленный после этого
    возврата, перестал бы вызываться ровно в тот момент, когда просмотр открывают. React
    считает хуки по порядку, а не по имени: это не «лишний рендер», а падение всего экрана
    встречи. Стоило одного зелёного прогона e2e, чтобы это стало видно.
  */
  const people = participants.filter((p) => !p.service && p.status !== 'WAITING');
  const self = meeting.admission.participantId;
  /*
    Показы экрана — отдельными плитками, «отдельными участниками», как в Meet (R183). Свой готов, как только
    своя дорожка опубликована: её видно в дорожках сессии — без сети и без снимка ядра.
  */
  const ownScreen = tracks.find((t) => t.local && t.source === Track.Source.ScreenShare && !t.muted);
  const shows = presentations(participants, self, !!ownScreen);
  const focused = focusedParticipant({
    pinned,
    speaking,
    current: focus,
    people: people.map((p) => p.id),
  });
  useEffect(() => {
    if (focused !== focus) setFocus(focused);
  }, [focused, focus]);
  /* Показ — плитка сетки наравне с людьми, и первой: так у Meet, и так его находят глазами. */
  const plan = useMemo(() => gridPlan(shows.length + people.length, box), [shows.length, people.length, box]);
  /*
    Кто крупно над лентой остальных (R83, R84): закреплённый руками — в любой раскладке, а в
    «Говорящем» — тот, кто держит слово. Раньше в сетке закрепление ставило только рамку `inset`,
    которую кадр камеры закрывал целиком, — снаружи не менялось ничего. Одному крупно не с кем
    делиться сценой: он и так во всю сцену.
  */
  const pinnedHere = pinned && people.some((p) => p.id === pinned) ? pinned : null;
  const spotlight = people.length > 1 ? (pinnedHere ?? (layout === 'speaker' ? focused : null)) : null;
  /** Место плитки в сетке (`ui/grid.ts`): две доли колонки, чтобы неполный ряд вставал посередине. */
  const cell = (index: number, placed: boolean): CSSProperties | undefined =>
    placed && plan.cells[index]
      ? { gridRow: plan.cells[index].row, gridColumn: `${plan.cells[index].column} / span 2` }
      : undefined;
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
    const mine = person.id === self;
    /*
      Пауза камеры от SFU (R117) — надпись сверху плитки, на месте «Восстанавливаем связь…», и одна
      из двух по старшинству:
      1. камера выключена или ещё не пришла — паузы нет: приглушать нечего, на плитке аватар;
      2. участник переподключается — «Восстанавливаем связь…»: кадр стоит из-за него, а не из-за
         нашего канала, и «слабая связь» на его плитке указала бы не туда;
      3. иначе — надпись по причине: «слабая связь», только если так сказал SFU, иначе «картинка не обновляется».
      Показ экрана живёт своей плиткой (R183), а не поверх плитки человека. Своё переподключение и зависание кадра решает сессия: надписи гаснут, пока нет
      связи, а сторож зависаний не трогает дорожку на паузе.
    */
    const recovering = person.status === 'RECOVERING';
    const pause = camera && !recovering ? pausedVideo[camera.id] : undefined;
    return (
      <ParticipantMenu
        meeting={meeting}
        person={person}
        key={person.id}
        className="person-tile"
        data-paused={pause}
        data-pinned={pinned === person.id ? 'true' : undefined}
        // Крупно над лентой — закреплённый или говорящий. Смена говорящего переносит две плитки
        // между крупным местом и лентой; выбор залипает (`ui/focus.ts`), так что это редкость.
        data-focused={spotlight === person.id ? 'true' : undefined}
        style={cell(index, placed)}
      >
        {/* Аватар есть всегда: под видео он ждёт первого кадра (R189, И5), и пустой плитки не бывает. */}
        <div
          className="person-placeholder"
          data-under={camera ? 'true' : undefined}
          aria-hidden={camera ? true : undefined}
        >
          <Avatar name={person.name} src={person.avatar} large />
        </div>
        {camera && <CameraVideo tile={camera} />}
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
            {mine ? t(($) => $.stage.you) : ''}
          </span>
        </div>
        {mine && camera && <LensSwitch meeting={meeting} tile={camera} />}
        {/* Своя камера лечится или идёт без фона (R189, И6) — метка только у себя. */}
        {mine && <OwnCameraChip meeting={meeting} />}
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
        {recovering && <div className="tile-recovery">{t(($) => $.stage.recovering)}</div>}
        {pause && <VideoPausedNote cause={pause} />}
      </ParticipantMenu>
    );
  };
  /** Подпись показа: «Экран: Аня» — как «Аня (презентация)» у Meet; свой — «Ваш экран». */
  const showName = (show: Presentation) =>
    show.own ? t(($) => $.stage.presentation.own) : t(($) => $.stage.screenOf, { name: show.name });
  /**
   * Плитка показа — «отдельный участник» (R183). Нажатие — показ крупно. Свой — живой своей дорожкой (без
   * сети); чужой — размытым превью раз в несколько секунд и «Смотреть стрим», пока его не открыли: подписка
   * на чужой экран держалась бы у каждого в комнате, даже у тех, кто его открепил (`media/screen-preview.ts`).
   */
  const presentationTile = (show: Presentation, index: number, placed: boolean) => {
    const name = showName(show);
    return (
      <div
        key={`screen:${show.screenId}`}
        className="person-tile presentation-tile"
        data-own={show.own ? 'true' : undefined}
        data-preparing={show.ready ? undefined : 'true'}
        style={cell(index, placed)}
      >
        {show.own && ownScreen ? (
          <ScreenVideo tile={ownScreen} />
        ) : (
          <div
            className="screen-preview"
            aria-hidden="true"
            style={
              previews[show.participantId]
                ? { backgroundImage: `url(${previews[show.participantId]})` }
                : undefined
            }
          />
        )}
        {show.ready ? (
          <button
            type="button"
            className="presentation-open"
            aria-label={
              show.own
                ? t(($) => $.stage.presentation.pinOwn)
                : t(($) => $.stage.presentation.pin, { name: show.name })
            }
            title={
              show.own
                ? t(($) => $.stage.presentation.pinOwn)
                : t(($) => $.stage.presentation.pin, { name: show.name })
            }
            onClick={() => meeting.openStream(show.participantId)}
          >
            {!show.own && (
              <span className="watch-stream" aria-hidden="true">
                <MonitorUp size={16} />
                <span>{t(($) => $.stage.watch)}</span>
                <span className="live-badge">LIVE</span>
              </span>
            )}
          </button>
        ) : (
          // Слот взят, а кадра целевого качества ещё нет: показ открывается зрителям после него (T48).
          <span className="watch-stream is-preparing" role="status">
            <MonitorUp size={16} />
            <span>{t(($) => $.stage.preparing)}</span>
          </span>
        )}
        <div className="person-caption">
          <MonitorUp size={16} aria-hidden="true" />
          <span>{name}</span>
        </div>
      </div>
    );
  };
  /** Своя плитка в ленте — первой: её ищут глазами чаще прочих (Discord, Телемост). */
  const selfFirst = (list: typeof people) =>
    [...list].sort((a, b) => Number(b.id === self) - Number(a.id === self));
  /**
   * Показ крупно (R183, как у Meet): экран — главным, все участники — лентой справа (на узком и вертикальном
   * — снизу), камера показывающего тоже. Другие показы — плитками в начале ленты. Чужой экран — с лупой и
   * перетаскиванием увеличенного кадра; свой — своей дорожкой, без сети.
   */
  const presentationView = (viewing: { screenId: string; participantId: string }) => {
    const own = viewing.participantId === self;
    const screen = tracks.find(
      (t) => t.participantId === viewing.participantId && t.source === Track.Source.ScreenShare && !t.muted,
    );
    // Пауза показа (R117) — только поверх кадра, который уже есть («Подключаемся к стриму…» старше),
    // и не у переподключающегося показывающего: тогда кадр стоит из-за него, а не из-за нашего канала.
    const sharer = participants.find((p) => p.id === viewing.participantId);
    const pause = !own && screen && sharer?.status !== 'RECOVERING' ? pausedVideo[screen.id] : undefined;
    const show = shows.find((item) => item.screenId === viewing.screenId);
    const name = show ? showName(show) : t(($) => $.stage.screenOf, { name: sharer?.name ?? '' });
    const others = shows.filter((item) => item.screenId !== viewing.screenId);
    const strip = selfFirst(people);
    return (
      <div
        className="stage watch-stage presentation-stage media-stage"
        data-paused={pause}
        data-own={own ? 'true' : undefined}
        data-strip={fullscreen?.full && stripInFull ? 'shown' : undefined}
      >
        <div className="presentation-main">
          <div
            className="screen-viewport"
            style={{ touchAction: zoom > 1 ? 'none' : 'auto' }}
            // Двойной щелчок по кадру — на весь экран и обратно, как у плеера (R187). Увеличенный кадр двигают
            // перетаскиванием, и два быстрых сдвига — тоже двойной щелчок: тогда он не разворачивает.
            onDoubleClick={zoom > 1 ? undefined : fullscreen?.toggle}
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
                <ScreenVideo
                  tile={screen}
                  onPlaying={own ? undefined : () => meeting.screenPlaying(viewing.screenId)}
                />
              </div>
            ) : (
              <div className="stream-loading" role="status">
                {t(($) => $.stage.streamConnecting)}
              </div>
            )}
            {pause && <VideoPausedNote cause={pause} announce />}
          </div>
          {/* «Открепить» — как у закреплённой камеры (R83): показ уходит плиткой в сетку, нажатие по ней
              возвращает его крупно. */}
          <button
            type="button"
            className="tile-unpin"
            aria-label={t(($) => $.stage.presentation.unpin)}
            title={t(($) => $.stage.presentation.unpin)}
            onClick={() => meeting.returnToConversation()}
          >
            <PinOff aria-hidden="true" />
            <span>{t(($) => $.stage.unpin)}</span>
          </button>
          <div className="person-caption presentation-caption">
            <MonitorUp size={16} aria-hidden="true" />
            <span>{name}</span>
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
            {fullscreen?.full && (others.length > 0 || strip.length > 0) && (
              <IconButton
                tone="stage"
                label={t(($) => $.stage.presentation.people)}
                pressed={stripInFull}
                onClick={() => setStripInFull((shown) => !shown)}
              >
                <Users size={20} />
              </IconButton>
            )}
            {fullscreen && (
              <IconButton
                tone="stage"
                label={fullscreen.full ? t(($) => $.dock.windowed) : t(($) => $.dock.fullscreen)}
                onClick={fullscreen.toggle}
              >
                {fullscreen.full ? <Minimize2 size={20} /> : <Maximize2 size={20} />}
              </IconButton>
            )}
          </div>
        </div>
        {others.length + strip.length > 0 && (
          <div
            className="people-strip presentation-strip media-stage"
            data-count={others.length + strip.length}
          >
            {others.map((item, index) => presentationTile(item, index, false))}
            {strip.map((person, index) => tile(person, others.length + index, false))}
          </div>
        )}
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
  } else if (occupant?.kind === 'board' && snapshot.board) {
    /*
      Доска (R159) занимает сцену целиком, как шахматы: холст во всю ширину, лица — у участников (R121).
      Ключ слоя — `board`, и доска не размонтируется у ушедшего: сокет, своя история отмены и вид
      холста остаются, а вернувшийся видит всё, что нарисовали без него.
    */
    integration = layer(
      'board',
      'board-stage',
      <BoardBoundary>
        <Suspense
          fallback={
            <div role="status" className="board-loading">
              {t(($) => $.board.loading)}
            </div>
          }
        >
          <BoardStage meeting={meeting} />
        </Suspense>
      </BoardBoundary>,
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
        <GameBarHeight />
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
        <GameBarHeight />
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
    if (viewing) peopleView = presentationView(viewing);
    else if (spotlight) {
      const big = people.find((person) => person.id === spotlight)!;
      // В ленте показы — первыми (R183), за ними своя плитка: её ищут глазами чаще прочих.
      const rest = selfFirst(people.filter((person) => person.id !== spotlight));
      peopleView = (
        <div
          className="stage conversation-stage camera-stage media-stage"
          data-layout={layout}
          data-spotlight="true"
        >
          <div className="spotlight-main">{tile(big, 0, false)}</div>
          <div className="people-strip spotlight-strip media-stage" data-count={shows.length + rest.length}>
            {shows.map((show, index) => presentationTile(show, index, false))}
            {rest.map((person, index) => tile(person, shows.length + index, false))}
          </div>
        </div>
      );
    } else
      peopleView = (
        <div className="stage conversation-stage camera-stage media-stage" data-layout={layout}>
          <div
            className="people-grid"
            data-count={shows.length + people.length}
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
            {shows.map((show, index) => presentationTile(show, index, layout === 'grid'))}
            {people.map((person, index) => tile(person, shows.length + index, layout === 'grid'))}
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

/**
 * Высота шапки стола (`--game-bar-h` на слое сцены) — колонке зрителей справа (R181): шапка идёт во всю
 * ширину сцены, а колонка встаёт под ней (`stage.css`). Шапка переносится в две строки на узком окне,
 * поэтому высота мерится, а не задаётся. Стол грузится лениво — шапку ищем, пока она не появится.
 */
function GameBarHeight() {
  const mark = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const stage = mark.current?.closest<HTMLElement>('.stage');
    // Без `ResizeObserver` (старый браузер, тесты) колонка встаёт по высоте шапки по умолчанию.
    if (!stage || typeof ResizeObserver === 'undefined') return;
    let bar: Element | null = null;
    const measure = () => {
      if (!bar?.isConnected) return find();
      const height = bar.getBoundingClientRect().bottom - stage.getBoundingClientRect().top;
      if (height > 0) stage.style.setProperty('--game-bar-h', `${Math.round(height)}px`);
    };
    const sizes = new ResizeObserver(measure);
    const appear = new MutationObserver(() => find());
    function find() {
      const next = stage!.querySelector(':scope > .poker-main :is(.durak-bar, .poker-bar)');
      if (next === bar) return;
      if (bar) sizes.unobserve(bar);
      bar = next;
      if (bar) {
        appear.disconnect();
        sizes.observe(bar);
        measure();
      } else appear.observe(stage!, { childList: true, subtree: true });
    }
    find();
    return () => {
      sizes.disconnect();
      appear.disconnect();
      stage.style.removeProperty('--game-bar-h');
    };
  }, []);
  return <span ref={mark} hidden />;
}
