import { useEffect, useRef, useState } from 'react';
import { MicOff, MonitorUp, ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';
import { Track, TrackEvent, RemoteAudioTrack } from 'livekit-client';
import type { MediaTile } from '../media/session';
import type { Meeting } from '../core/meeting';
import { ServiceRoster } from './ServiceRoster';
import { ParticipantMenu } from './ParticipantMenu';
import { Avatar, IconButton, useStore } from './primitives';
import { focusedParticipant } from './focus';

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
  const participants = useStore(meeting.snapshot).participants;
  const tracks = useStore(meeting.media.tracks);
  const viewing = useStore(meeting.viewing);
  const pinned = useStore(meeting.pinnedCamera);
  const speaking = useStore(meeting.media.speaking);
  const previews = useStore(meeting.media.screenPreviews);
  const layout = useStore(meeting.media.preferences).layout;
  /** Кто показан крупно сейчас: нужен, чтобы выбор залипал, а не прыгал на каждом слоге. */
  const [focus, setFocus] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [viewing?.screenId]);
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
  const people = participants.filter((p) => !p.service && p.status !== 'WAITING');
  // Крупная плитка нужна только в «Говорящем»; в остальных раскладках считать её незачем,
  // но хук обязан вызываться всегда, поэтому решение принимается здесь, а применяется ниже.
  const focused = focusedParticipant({
    pinned,
    speaking,
    current: focus,
    people: people.map((p) => p.id),
  });
  useEffect(() => {
    if (focused !== focus) setFocus(focused);
  }, [focused, focus]);
  const showRoster =
    showServices &&
    layout === 'grid' &&
    participants.some(
      (participant) =>
        participant.service && ['JOINING', 'CONNECTED', 'RECOVERING'].includes(participant.status),
    );
  return (
    <div
      className={`stage conversation-stage ${showRoster ? 'with-integrations' : 'camera-stage'}`}
      data-layout={layout}
    >
      <div className="people-grid" data-count={people.length}>
        {people.map((person) => {
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
            >
              {camera ? (
                <VideoTrack tile={camera} />
              ) : (
                <div className="person-placeholder">
                  {sharing && (
                    <div
                      className="screen-preview"
                      aria-hidden="true"
                      style={
                        previews[person.id] ? { backgroundImage: `url(${previews[person.id]})` } : undefined
                      }
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
        })}
      </div>
      {showRoster && <ServiceRoster meeting={meeting} onOpen={onOpenServices} />}
    </div>
  );
}
