import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Music2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Meeting } from '../core/meeting';
import { MusicApi, musicSourceName } from '../core/services';
import { ParticipantMenu } from './ParticipantMenu';
import { useStore } from './primitives';

export function ServiceRoster({ meeting, onOpen }: { meeting: Meeting; onOpen: () => void }) {
  const { t } = useTranslation();
  const snapshot = useStore(meeting.snapshot);
  const ended = useStore(meeting.ended);
  const api = useMemo(() => new MusicApi(meeting.admission), [meeting]);
  const member = snapshot.participants.find((p) => p.id === meeting.admission.participantId);
  const music = useQuery({
    queryKey: ['music', meeting.admission.roomId, meeting.admission.participantId],
    queryFn: api.state,
    enabled: !ended && !!member && member.status !== 'WAITING',
    refetchInterval: ended ? false : 2000,
  });
  const bot = snapshot.participants.find(
    (p) => p.service === 'music' && ['JOINING', 'CONNECTED', 'RECOVERING'].includes(p.status),
  );
  const state = music.data;
  const current = state?.enabled ? state.queue[0] : undefined;
  const status =
    music.isError || state?.error
      ? t(($) => $.services.roster.check)
      : !bot
        ? t(($) => $.services.roster.add)
        : state?.status === 'connecting'
          ? t(($) => $.services.roster.connecting)
          : state?.paused
            ? t(($) => $.services.roster.paused)
            : state?.status === 'playing'
              ? t(($) => $.services.roster.playing)
              : t(($) => $.services.roster.empty);
  const card = (
    <button className="integration-entry" onClick={onOpen} aria-label={t(($) => $.services.roster.open)}>
      <Music2 size={22} className="integration-symbol" />
      <span className="integration-summary">
        <strong>{t(($) => $.services.roster.music)}</strong>
        <small>{status}</small>
        {current && (
          <>
            <span className="integration-track">{current.title}</span>
            {current.artist && <small>{current.artist}</small>}
            <span className="music-source">{musicSourceName(t, current.source)}</span>
          </>
        )}
      </span>
      <ChevronRight size={16} aria-hidden="true" />
    </button>
  );
  return (
    <section className="integration-roster" aria-label={t(($) => $.services.roster.label)}>
      <h2>{t(($) => $.services.roster.label)}</h2>
      {bot ? (
        <ParticipantMenu meeting={meeting} person={bot} className="integration-participant">
          {card}
        </ParticipantMenu>
      ) : (
        card
      )}
    </section>
  );
}
