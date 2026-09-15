import { useEffect, useRef, useState } from 'react';
import { MicOff, MonitorUp, ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';
import { Track, TrackEvent, RemoteAudioTrack } from 'livekit-client';
import type { MediaTile } from '../media/session';
import type { Meeting } from '../core/meeting';
import { ServiceRoster } from './ServiceRoster';
import { ParticipantMenu } from './ParticipantMenu';
import { Avatar, IconButton, useStore } from './primitives';

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
      element.style.transform = tile.local && !screen ? 'scaleX(-1)' : 'none';
    };
    mirror();
    tile.track.on(TrackEvent.Restarted, mirror);
    return () => {
      tile.track.off(TrackEvent.Restarted, mirror);
      tile.track.detach(element);
    };
  }, [tile.track, tile.local, screen]);
  return (
    <video
      ref={ref}
      onPlaying={onPlaying}
      autoPlay
      playsInline
      muted
      className={screen ? 'screen-video' : `camera-video ${tile.local ? 'mirrored' : ''}`}
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
  const people = participants.filter(
    (p) => !p.service && p.status !== 'WAITING' && (!pinned || p.id === pinned),
  );
  const showRoster =
    showServices &&
    !pinned &&
    participants.some(
      (participant) =>
        participant.service && ['JOINING', 'CONNECTED', 'RECOVERING'].includes(participant.status),
    );
  return (
    <div className={`stage conversation-stage ${showRoster ? 'with-integrations' : 'camera-stage'}`}>
      <div className="people-grid" data-count={people.length}>
        {people.map((person) => {
          const camera = tracks.find(
            (t) => t.participantId === person.id && t.source === Track.Source.Camera && !t.muted,
          );
          const mic = tracks.find(
            (t) => t.participantId === person.id && t.source === Track.Source.Microphone && !t.muted,
          );
          return (
            <ParticipantMenu meeting={meeting} person={person} key={person.id} className="person-tile">
              {camera ? (
                <VideoTrack tile={camera} />
              ) : (
                <div className="person-placeholder">
                  <Avatar name={person.name} large />
                </div>
              )}
              <div className="person-caption">
                <span>
                  {person.name}
                  {person.id === meeting.admission.participantId ? ' (Вы)' : ''}
                </span>
                {!mic && <MicOff size={15} aria-label="Микрофон выключен" />}
              </div>
              {person.screen && person.screenId && person.screenStarted && (
                <button className="watch-stream" onClick={() => meeting.openStream(person.id)}>
                  <MonitorUp size={16} /> Смотреть стрим <span className="live-badge">LIVE</span>
                </button>
              )}
              {person.status === 'RECOVERING' && <div className="tile-recovery">Восстанавливаем связь…</div>}
            </ParticipantMenu>
          );
        })}
      </div>
      {showRoster && <ServiceRoster meeting={meeting} onOpen={onOpenServices} />}
    </div>
  );
}
