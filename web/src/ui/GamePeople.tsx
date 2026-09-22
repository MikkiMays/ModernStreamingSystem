import { useEffect, useRef } from 'react';
import { TrackEvent } from 'livekit-client';
import type { Meeting } from '../core/meeting';
import type { MediaTile } from '../media/session';
import { Avatar, useStore } from './primitives';
import { ParticipantMenu } from './ParticipantMenu';
import '../game-people.css';

function GameCamera({ tile }: { tile: MediaTile }) {
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
  return <video ref={ref} autoPlay playsInline muted aria-label={`Камера: ${tile.name}`} />;
}

export function GamePerson({
  meeting,
  memberId,
  label,
  fallbackName,
  interactive = true,
}: {
  meeting: Meeting;
  memberId?: string | null;
  label?: string;
  /** Recorded game identity remains readable after the member leaves the meeting. */
  fallbackName?: string;
  interactive?: boolean;
}) {
  const snapshot = useStore(meeting.snapshot);
  const tracks = useStore(meeting.media.tracks);
  const speakers = useStore(meeting.media.speaking);
  const person = snapshot.participants.find((participant) => participant.id === memberId);
  const camera = tracks.find(
    (track) => track.participantId === memberId && track.source === 'camera' && !track.muted,
  );
  const speaking = !!memberId && speakers.includes(memberId);
  const name = person?.name ?? fallbackName ?? label ?? 'Свободное место';
  const content = (
    <>
      <span className="game-person-face">
        {camera ? <GameCamera tile={camera} /> : <Avatar name={name} src={person?.avatar} />}
      </span>
      <span className="game-person-copy">
        <b title={name}>{name}</b>
        {label ? <small>{label}</small> : speaking && <small className="game-person-speaking">Говорит</small>}
      </span>
    </>
  );
  return person && interactive ? (
    <ParticipantMenu
      meeting={meeting}
      person={person}
      className="game-person"
      data-speaking={speaking ? 'true' : undefined}
      data-away={['LEFT', 'EXPIRED', 'REMOVED'].includes(person.status) ? 'true' : undefined}
    >
      {content}
    </ParticipantMenu>
  ) : (
    <div className="game-person" data-speaking={speaking ? 'true' : undefined}>
      {content}
    </div>
  );
}

export function GamePeople({ meeting, memberIds }: { meeting: Meeting; memberIds?: string[] }) {
  const snapshot = useStore(meeting.snapshot);
  const people =
    memberIds ??
    snapshot.participants
      .filter((person) => !person.service && ['JOINING', 'CONNECTED', 'RECOVERING'].includes(person.status))
      .map((person) => person.id);
  return (
    <div className="game-people" aria-label="Участники встречи">
      {people.map((id) => (
        <GamePerson key={id} meeting={meeting} memberId={id} />
      ))}
    </div>
  );
}
