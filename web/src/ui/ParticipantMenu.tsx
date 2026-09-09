import { Menu } from '@base-ui/react/menu';
import { MoreHorizontal } from 'lucide-react';
import { useRef, type ReactNode } from 'react';
import type { Participant } from '../api/types';
import type { Meeting } from '../core/meeting';
import { useStore } from './primitives';
/** The same menu and keyboard behavior are used on tiles and in the participant list. */
export function ParticipantMenu({
  meeting,
  person,
  children,
  className = '',
}: {
  meeting: Meeting;
  person: Participant;
  children: ReactNode;
  className?: string;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const snapshot = useStore(meeting.snapshot);
  const volumes = useStore(meeting.media.volumes);
  const self = snapshot.participants.find((p) => p.id === meeting.admission.participantId);
  const remote = person.id !== self?.id;
  const volume = volumes[person.id] ?? 1;
  const active = person.status !== 'WAITING';
  return (
    <Menu.Root>
      <div
        className={className}
        tabIndex={0}
        onContextMenu={(e) => {
          e.preventDefault();
          trigger.current?.click();
        }}
        onKeyDown={(e) => {
          if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
            e.preventDefault();
            trigger.current?.click();
          }
        }}
      >
        {children}
        <Menu.Trigger
          ref={trigger}
          className="icon-button participant-more"
          aria-label={`Действия: ${person.name}`}
        >
          <MoreHorizontal size={19} />
        </Menu.Trigger>
      </div>
      <Menu.Portal>
        <Menu.Positioner sideOffset={6}>
          <Menu.Popup className="action-menu participant-menu">
            <strong>{person.name}</strong>
            {remote && active && (
              <>
                <label className="participant-volume">
                  Громкость у вас · {Math.round(volume * 100)}%
                  <input
                    type="range"
                    min={0}
                    max={200}
                    step={5}
                    value={volume * 100}
                    aria-label={`Громкость: ${person.name}`}
                    onChange={(e) => meeting.media.setVolume(person.id, Number(e.target.value) / 100)}
                  />
                </label>
                <Menu.Item onClick={() => meeting.media.toggleParticipantMute(person.id)}>
                  {volume === 0 ? 'Восстановить громкость' : 'Отключить звук у меня'}
                </Menu.Item>
              </>
            )}
            {active && <Menu.Item onClick={() => meeting.pinCamera(person.id)}>Закрепить камеру</Menu.Item>}
            {person.screen && person.screenId && person.screenStarted && (
              <Menu.Item onClick={() => meeting.openStream(person.id)}>Смотреть стрим</Menu.Item>
            )}
            {self?.owner && remote && active && (
              <Menu.Item
                onClick={() =>
                  void meeting
                    .command('microphone.mute', undefined, person.id)
                    .catch((e) => meeting.media.report(e))
                }
              >
                Выключить микрофон для всех
              </Menu.Item>
            )}
            {self?.owner && !person.owner && (
              <Menu.Item
                className="danger-text"
                onClick={() =>
                  void meeting
                    .command('participant.remove', undefined, person.id)
                    .catch((e) => meeting.media.report(e))
                }
              >
                Удалить из встречи
              </Menu.Item>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
