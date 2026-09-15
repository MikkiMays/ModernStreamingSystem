import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Music2 } from 'lucide-react';
import type { Meeting } from '../core/meeting';
import { MusicApi, musicSourceName } from '../core/services';
import { ParticipantMenu } from './ParticipantMenu';
import { useStore } from './primitives';

export function ServiceRoster({ meeting, onOpen }: { meeting: Meeting; onOpen: () => void }) {
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
      ? 'Нужна проверка подключения'
      : !bot
        ? 'Добавить во встречу'
        : state?.status === 'connecting'
          ? 'Подключаемся…'
          : state?.paused
            ? 'На паузе'
            : state?.status === 'playing'
              ? 'Сейчас играет'
              : 'Очередь пуста';
  const card = (
    <button className="integration-entry" onClick={onOpen} aria-label="Открыть плеер музыки">
      <Music2 size={22} className="integration-symbol" />
      <span className="integration-summary">
        <strong>Музыка</strong>
        <small>{status}</small>
        {current && (
          <>
            <span className="integration-track">{current.title}</span>
            {current.artist && <small>{current.artist}</small>}
            <span className="music-source">{musicSourceName(current.source)}</span>
          </>
        )}
      </span>
      <ChevronRight size={16} aria-hidden="true" />
    </button>
  );
  return (
    <section className="integration-roster" aria-label="Боты и интеграции">
      <h2>Боты и интеграции</h2>
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
