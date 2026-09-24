import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { MicOff, MonitorUp, ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';
import { Track, TrackEvent, RemoteAudioTrack } from 'livekit-client';
import type { MediaTile } from '../media/session';
import type { Meeting } from '../core/meeting';
import { PROVIDERS } from '../core/cinema';
import { ServiceRoster } from './ServiceRoster';
import { ParticipantMenu } from './ParticipantMenu';
import { Avatar, IconButton, useStore } from './primitives';
import { focusedParticipant } from './focus';
import { gridPlan } from './grid';
import { SCENES } from './cinema/scenes';

const WatchTheater = lazy(() => import('./WatchTheater'));
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
    */
    const fit = () => {
      if (screen || !element.videoWidth || !element.videoHeight) return;
      element
        .closest<HTMLElement>('.person-tile')
        ?.style.setProperty('--tile-aspect', `${element.videoWidth} / ${element.videoHeight}`);
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
      element.closest<HTMLElement>('.person-tile')?.style.removeProperty('--tile-aspect');
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
      aria-label={screen ? `Экран: ${tile.name}` : `Камера: ${tile.name}`}
    />
  );
}
function AudioTrack({ tile, onBlocked, volume }: { tile: MediaTile; onBlocked: () => void; volume: number }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const audio = ref.current;
    if (!audio) return;
    tile.track.attach(audio);
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
}: {
  tracks: MediaTile[];
  onBlocked: () => void;
  volumes: Record<string, number>;
  deafened: boolean;
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
            volume={deafened ? 0 : (volumes[t.participantId] ?? 1)}
          />
        ))}
    </div>
  );
}
export function Stage({
  meeting,
  onOpenServices,
  showServices,
}: {
  meeting: Meeting;
  onOpenServices: () => void;
  showServices: boolean;
}) {
  const snapshot = useStore(meeting.snapshot);
  const participants = snapshot.participants;
  const tracks = useStore(meeting.media.tracks);
  const viewing = useStore(meeting.viewing);
  const pinned = useStore(meeting.pinnedCamera);
  const speaking = useStore(meeting.media.speaking);
  const previews = useStore(meeting.media.screenPreviews);
  const cinema = useStore(meeting.cinema);
  const layout = useStore(meeting.media.preferences).layout;
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
  if (viewing) {
    const screen = tracks.find(
      (t) => t.participantId === viewing.participantId && t.source === Track.Source.ScreenShare && !t.muted,
    );
    return (
      <div className="stage watch-stage">
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
              Подключаемся к стриму…
            </div>
          )}
        </div>
        <div className="screen-tools">
          <IconButton
            label="Уменьшить"
            disabled={zoom <= 1}
            onClick={() => {
              setZoom((z) => Math.max(1, z - 0.5));
              setPan({ x: 0, y: 0 });
            }}
          >
            <ZoomOut size={17} />
          </IconButton>
          <span>{Math.round(zoom * 100)}%</span>
          <IconButton
            label="Увеличить"
            disabled={zoom >= 4}
            onClick={() => setZoom((z) => Math.min(4, z + 0.5))}
          >
            <ZoomIn size={17} />
          </IconButton>
          <IconButton
            label="Вписать весь экран"
            onClick={() => {
              setZoom(1);
              setPan({ x: 0, y: 0 });
            }}
          >
            <RotateCcw size={17} />
          </IconButton>
        </div>
      </div>
    );
  }
  const showRoster =
    showServices &&
    layout === 'grid' &&
    participants.some(
      (participant) =>
        participant.service && ['JOINING', 'CONNECTED', 'RECOVERING'].includes(participant.status),
    );
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
    return (
      <ParticipantMenu
        meeting={meeting}
        person={person}
        key={person.id}
        className="person-tile"
        // Обводка вместо надписи: кто говорит, узнаётся боковым зрением, и читать для
        // этого ничего не нужно. Заглушённый микрофон рядом остаётся отдельным знаком —
        // на цвет полагаться нельзя.
        data-speaking={mic && speaking.includes(person.id) ? 'true' : undefined}
        data-sharing={sharing ? 'true' : undefined}
        data-pinned={pinned === person.id ? 'true' : undefined}
        // Крупная плитка в «Говорящем» — это порядок в раскладке, а не отдельный узел:
        // так видео не пересоздаётся при смене говорящего и не моргает.
        data-focused={layout === 'speaker' && focused === person.id ? 'true' : undefined}
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
        <div className="person-caption">
          <span>
            {person.name}
            {self ? ' (Вы)' : ''}
          </span>
          {!mic && <MicOff size={15} aria-label="Микрофон выключен" />}
        </div>
        {sharing &&
          (self ? (
            <span className="watch-stream is-own">
              <MonitorUp size={16} />
              <span>Вы показываете экран</span>
              <span className="live-badge">LIVE</span>
            </span>
          ) : (
            <button className="watch-stream" onClick={() => meeting.openStream(person.id)}>
              <MonitorUp size={16} />
              <span>Смотреть стрим</span>
              <span className="live-badge">LIVE</span>
            </button>
          ))}
        {person.status === 'RECOVERING' && <div className="tile-recovery">Восстанавливаем связь…</div>}
      </ParticipantMenu>
    );
  };
  /*
    Карточный стол. В отличие от кинозала, лента под ним — не все, а **только зрители**: лица
    играющих уже на столе, в кружках их мест, и показывать их вторым рядом значило бы отобрать
    у стола половину сцены ради повторения.
  */
  if (snapshot.chess || snapshot.gartic) {
    return (
      <div className="stage room-game-stage">
        <Suspense
          fallback={
            <div role="status" className="poker-loading">
              Открываем игру…
            </div>
          }
        >
          {snapshot.chess ? <ChessTable meeting={meeting} /> : <GarticTable meeting={meeting} />}
        </Suspense>
      </div>
    );
  }
  if (snapshot.poker) {
    const table = snapshot.poker;
    const watchers = people.filter((person) => !table.seats.some((seat) => seat.memberId === person.id));
    return (
      <div className="stage poker-stage">
        <div className="poker-main">
          <Suspense fallback={<div className="poker-loading" />}>
            <PokerTable meeting={meeting} table={table} />
          </Suspense>
        </div>
        {watchers.length > 0 && (
          <div className="people-strip" data-count={watchers.length}>
            {watchers.map((person, index) => tile(person, index, false))}
          </div>
        )}
      </div>
    );
  }
  // Стол дурака живёт на сцене по тем же правилам, что покерный: лица играющих — в кружках их
  // мест, а лента под столом остаётся зрителям.
  if (snapshot.durak) {
    const table = snapshot.durak;
    const watchers = people.filter((person) => !table.seats.some((seat) => seat.memberId === person.id));
    return (
      <div className="stage poker-stage">
        <div className="poker-main">
          <Suspense fallback={<div className="durak-loading" />}>
            <DurakTable meeting={meeting} table={table} />
          </Suspense>
        </div>
        {watchers.length > 0 && (
          <div className="people-strip" data-count={watchers.length}>
            {watchers.map((person, index) => tile(person, index, false))}
          </div>
        )}
      </div>
    );
  }
  /*
    Кинозал. Комната смотрит одно на всех, поэтому сцена перестраивается у каждого: плеер
    занимает середину, а люди сжимаются в ленту под ним — их по-прежнему видно и слышно, но
    главное на экране теперь не они.

    Каталог живёт здесь же и **поверх** плеера, а не вместо него: пока один выбирает, чем
    продолжить, комната продолжает смотреть — и разбирать плеер ради чужого выбора значило бы
    остановить фильм всем.
  */
  if (snapshot.watch || cinema) {
    /*
      Каталог — сцена площадки из реестра. Ключ — сама сцена, а не площадка: вкладки внутри
      одной сцены (YouTube ↔ Twitch) переключаются без пересоздания, а другая сцена — это
      другой каталог и начинается заново.
    */
    const scene = cinema ? PROVIDERS[cinema].scene : null;
    const Scene = scene ? SCENES[scene] : null;
    return (
      <div className="stage watch-together-stage">
        <div className="watch-main">
          {snapshot.watch && (
            <Suspense fallback={<div className="watch-screen" />}>
              <WatchTheater
                meeting={meeting}
                watch={snapshot.watch}
                onBrowse={() => meeting.openCinema(snapshot.watch!.provider)}
              />
            </Suspense>
          )}
          {cinema && Scene && (
            <Suspense fallback={<div className="cinema-browser" />}>
              <Scene
                key={scene}
                meeting={meeting}
                provider={cinema}
                onProvider={(next) => meeting.openCinema(next)}
                onClose={() => meeting.openCinema(null)}
              />
            </Suspense>
          )}
        </div>
        <div className="people-strip" data-count={people.length}>
          {people.map((person, index) => tile(person, index, false))}
        </div>
      </div>
    );
  }
  return (
    <div
      className={`stage conversation-stage ${showRoster ? 'with-integrations' : 'camera-stage'}`}
      data-layout={layout}
    >
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
      {showRoster && <ServiceRoster meeting={meeting} onOpen={onOpenServices} />}
    </div>
  );
}
