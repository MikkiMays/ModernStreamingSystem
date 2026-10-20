import { useEffect, useRef } from 'react';
import { TrackEvent } from 'livekit-client';
import { useTranslation } from 'react-i18next';
import type { Meeting } from '../core/meeting';
import type { MediaTile } from '../media/session';
import { Avatar, useStore } from './primitives';
import { ParticipantMenu } from './ParticipantMenu';
import { FaceZoomButton, useFaceZoom } from './FaceZoom';
import { useVoiceTier } from './useVoice';
import type { GameKind } from '../core/preferences';
import '../game-people.css';

function GameCamera({ tile }: { tile: MediaTile }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    tile.track.attach(video);
    video.muted = true;
    const mirror = () => {
      video.style.transform =
        tile.local && tile.track.mediaStreamTrack?.getSettings().facingMode !== 'environment'
          ? 'scaleX(-1)'
          : 'none';
    };
    mirror();
    tile.track.on(TrackEvent.Restarted, mirror);
    return () => {
      tile.track.off(TrackEvent.Restarted, mirror);
      tile.track.detach(video);
    };
  }, [tile.track, tile.local]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      aria-label={t(($) => $.games.people.camera, { name: tile.name })}
    />
  );
}

export function GamePerson({
  meeting,
  memberId,
  label,
  fallbackName,
  interactive = true,
  game,
}: {
  meeting: Meeting;
  memberId?: string | null;
  label?: string;
  /** Recorded game identity remains readable after the member leaves the meeting. */
  fallbackName?: string;
  interactive?: boolean;
  /** За каким столом лицо: его размер у каждого зрителя свой и помнится по игре (T11). */
  game?: GameKind;
}) {
  const { t } = useTranslation();
  const snapshot = useStore(meeting.snapshot);
  const tracks = useStore(meeting.media.tracks);
  // Голос — свой замер у каждого зрителя (T23): лицо загорается вместе со звуком, а не после SFU.
  const voice = useVoiceTier(meeting, memberId);
  const person = snapshot.participants.find((participant) => participant.id === memberId);
  const camera = tracks.find(
    (track) => track.participantId === memberId && track.source === 'camera' && !track.muted,
  );
  const speaking = voice > 0;
  const name = person?.name ?? fallbackName ?? label ?? t(($) => $.games.people.freeSeat);
  const zoom = useFaceZoom(game ?? 'chess', game ? memberId : null);
  const content = (
    <>
      <span className="game-person-avatar" style={zoom.style}>
        <span className="game-person-face">
          {camera ? <GameCamera tile={camera} /> : <Avatar name={name} src={person?.avatar} />}
        </span>
        {game && memberId && <FaceZoomButton zoom={zoom.zoom} name={name} onCycle={zoom.cycle} />}
      </span>
      <span className="game-person-copy">
        <b title={name}>{name}</b>
        {label ? (
          <small>{label}</small>
        ) : (
          speaking && <small className="game-person-speaking">{t(($) => $.games.people.speaking)}</small>
        )}
      </span>
    </>
  );
  return person && interactive ? (
    <ParticipantMenu
      meeting={meeting}
      person={person}
      className="game-person"
      data-speaking={speaking ? 'true' : undefined}
      data-voice={voice || undefined}
      data-away={['LEFT', 'EXPIRED', 'REMOVED'].includes(person.status) ? 'true' : undefined}
    >
      {content}
    </ParticipantMenu>
  ) : (
    <div
      className="game-person"
      data-speaking={speaking ? 'true' : undefined}
      data-voice={voice || undefined}
    >
      {content}
    </div>
  );
}

export function GamePeople({
  meeting,
  memberIds,
  game,
}: {
  meeting: Meeting;
  memberIds?: string[];
  game?: GameKind;
}) {
  const { t } = useTranslation();
  const snapshot = useStore(meeting.snapshot);
  const people =
    memberIds ??
    snapshot.participants
      .filter((person) => !person.service && ['JOINING', 'CONNECTED', 'RECOVERING'].includes(person.status))
      .map((person) => person.id);
  return (
    <div className="game-people" aria-label={t(($) => $.games.people.list)}>
      {people.map((id) => (
        <GamePerson key={id} meeting={meeting} memberId={id} game={game} />
      ))}
    </div>
  );
}
