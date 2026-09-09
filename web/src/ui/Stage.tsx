import { useEffect, useRef, useState } from 'react';
import {
  Maximize2,
  MicOff,
  Minimize2,
  MonitorUp,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Pin,
  PinOff,
  PanelsTopLeft,
} from 'lucide-react';
import { Track } from 'livekit-client';
import type { MediaTile } from '../media/session';
import type { Participant } from '../api/types';
import { Avatar, IconButton } from './primitives';

function VideoTrack({ tile, screen = false }: { tile: MediaTile; screen?: boolean }) {
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
      autoPlay
      playsInline
      muted
      className={screen ? 'screen-video' : `camera-video ${tile.local ? 'mirrored' : ''}`}
      aria-label={screen ? `Экран: ${tile.name}` : `Камера: ${tile.name}`}
    />
  );
}
function AudioTrack({ tile, onBlocked }: { tile: MediaTile; onBlocked: () => void }) {
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
  return <audio ref={ref} autoPlay />;
}
export function AudioLayer({ tracks, onBlocked }: { tracks: MediaTile[]; onBlocked: () => void }) {
  return (
    <div className="audio-layer">
      {tracks
        .filter((t) => !t.local && t.track.kind === Track.Kind.Audio)
        .map((t) => (
          <AudioTrack key={t.id} tile={t} onBlocked={onBlocked} />
        ))}
    </div>
  );
}
function ScreenTile({
  tile,
  focused,
  onFocus,
  camera,
  faceLayout,
  onFaceLayout,
  onPinPerson,
}: {
  tile: MediaTile;
  focused: boolean;
  onFocus: () => void;
  camera?: MediaTile;
  faceLayout: 'inset' | 'side';
  onFaceLayout: () => void;
  onPinPerson: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const pointer = useRef<{ x: number; y: number; originX: number; originY: number } | null>(null);
  const reset = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };
  return (
    <div
      className="screen-tile"
      ref={root}
      data-focused={focused}
      data-face-layout={camera ? faceLayout : undefined}
    >
      <div className="screen-top">
        <span>
          <MonitorUp size={16} />
          {tile.name}
          {tile.local ? ' · ваш экран' : ' · демонстрация'}
        </span>
        <span className="live-badge">
          <i /> LIVE
        </span>
      </div>
      <div
        className="screen-viewport"
        style={{ cursor: zoom > 1 ? 'grab' : 'default', touchAction: zoom > 1 ? 'none' : 'auto' }}
        onPointerDown={(e) => {
          if (zoom <= 1) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          pointer.current = { x: e.clientX, y: e.clientY, originX: pan.x, originY: pan.y };
        }}
        onPointerMove={(e) => {
          if (!pointer.current) return;
          const bounds = e.currentTarget.getBoundingClientRect();
          setPan({
            x: Math.max(
              (-bounds.width * (zoom - 1)) / 2,
              Math.min(
                (bounds.width * (zoom - 1)) / 2,
                pointer.current.originX + e.clientX - pointer.current.x,
              ),
            ),
            y: Math.max(
              (-bounds.height * (zoom - 1)) / 2,
              Math.min(
                (bounds.height * (zoom - 1)) / 2,
                pointer.current.originY + e.clientY - pointer.current.y,
              ),
            ),
          });
        }}
        onPointerUp={() => {
          pointer.current = null;
        }}
        onPointerCancel={() => {
          pointer.current = null;
        }}
      >
        <div
          className="screen-transform"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
        >
          <VideoTrack tile={tile} screen />
        </div>
      </div>
      {camera && (
        <div className="presenter-face" aria-label={`Лицо ведущего: ${tile.name}`}>
          <VideoTrack tile={camera} />
          <span>{tile.name}</span>
          <IconButton label={`Закрепить участника: ${tile.name}`} onClick={onPinPerson}>
            <Pin size={16} />
          </IconButton>
        </div>
      )}
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
        <IconButton label="Вписать весь экран" onClick={reset}>
          <RotateCcw size={17} />
        </IconButton>
        <IconButton
          label={focused ? 'Сравнить экраны' : `Закрепить экран: ${tile.name}`}
          aria-pressed={focused}
          onClick={onFocus}
        >
          {focused ? <Minimize2 size={17} /> : <Pin size={17} />}
        </IconButton>
        {camera && (
          <IconButton
            label={faceLayout === 'inset' ? 'Показывать лицо рядом с экраном' : 'Показывать лицо в углу'}
            onClick={onFaceLayout}
          >
            <PanelsTopLeft size={17} />
          </IconButton>
        )}
        <IconButton
          label="Полноэкранный режим"
          onClick={() => {
            if (document.fullscreenElement) void document.exitFullscreen();
            else void root.current?.requestFullscreen().catch(() => {});
          }}
        >
          <Maximize2 size={17} />
        </IconButton>
      </div>
    </div>
  );
}
export function Stage({
  participants,
  tracks,
  selfId,
}: {
  participants: Participant[];
  tracks: MediaTile[];
  selfId: string;
}) {
  const screens = tracks.filter((t) => t.source === Track.Source.ScreenShare && !t.muted);
  const [focused, setFocused] = useState<string | null>(null);
  const [pinnedPerson, setPinnedPerson] = useState<string | null>(null);
  const [faceLayout, setFaceLayout] = useState<'inset' | 'side'>(() =>
    localStorage.getItem('cord:face-layout') === 'side' ? 'side' : 'inset',
  );
  const changeFaceLayout = () =>
    setFaceLayout((previous) => {
      const next = previous === 'inset' ? 'side' : 'inset';
      localStorage.setItem('cord:face-layout', next);
      return next;
    });
  const focusExists = screens.some((s) => s.participantId === focused);
  const personPinExists = participants.some((p) => p.id === pinnedPerson);
  return (
    <div
      className={`stage ${screens.length ? 'has-screens' : ''} ${personPinExists ? 'has-person-pin' : ''}`}
    >
      {!!screens.length && (
        <div className={`screens-grid ${focusExists ? 'focused' : ''}`} data-count={screens.length}>
          {screens.map((tile) => (
            <ScreenTile
              key={tile.id}
              tile={tile}
              focused={tile.participantId === focused}
              onFocus={() => setFocused((f) => (f === tile.participantId ? null : tile.participantId))}
              camera={
                pinnedPerson !== tile.participantId
                  ? tracks.find(
                      (t) =>
                        t.participantId === tile.participantId &&
                        t.source === Track.Source.Camera &&
                        !t.muted,
                    )
                  : undefined
              }
              faceLayout={faceLayout}
              onFaceLayout={changeFaceLayout}
              onPinPerson={() => setPinnedPerson(tile.participantId)}
            />
          ))}
        </div>
      )}
      <div
        className="people-grid"
        data-count={participants.length}
        style={{
          gridTemplateRows:
            personPinExists && !screens.length
              ? `repeat(${Math.max(1, participants.length - 1)}, minmax(0, 1fr))`
              : undefined,
        }}
      >
        {participants
          .filter((p) => p.status !== 'WAITING')
          .map((person) => {
            const camera = tracks.find(
              (t) => t.participantId === person.id && t.source === Track.Source.Camera && !t.muted,
            );
            const mic = tracks.find(
              (t) => t.participantId === person.id && t.source === Track.Source.Microphone && !t.muted,
            );
            return (
              <div
                className="person-tile"
                key={person.id}
                data-pinned={pinnedPerson === person.id}
                data-recovering={person.status === 'RECOVERING'}
              >
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
                    {person.id === selfId ? ' (Вы)' : ''}
                  </span>
                  {!mic && <MicOff size={15} aria-label="Микрофон выключен" />}
                </div>
                <IconButton
                  className="person-pin"
                  label={
                    pinnedPerson === person.id
                      ? `Открепить участника: ${person.name}`
                      : `Закрепить участника: ${person.name}`
                  }
                  aria-pressed={pinnedPerson === person.id}
                  onClick={() => setPinnedPerson((p) => (p === person.id ? null : person.id))}
                >
                  {pinnedPerson === person.id ? <PinOff size={17} /> : <Pin size={17} />}
                </IconButton>
                {person.status === 'RECOVERING' && (
                  <div className="tile-recovery">Восстанавливаем связь…</div>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}
