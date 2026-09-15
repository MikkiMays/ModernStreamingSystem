import { ContextMenu } from '@base-ui/react/context-menu';
import { Menu } from '@base-ui/react/menu';
import { MoreHorizontal } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
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
  const snapshot = useStore(meeting.snapshot);
  const volumes = useStore(meeting.media.volumes);
  const self = snapshot.participants.find((p) => p.id === meeting.admission.participantId);
  const remote = person.id !== self?.id;
  const volume = volumes[person.id] ?? 1;
  const active = person.status !== 'WAITING';

  // Both menus list the same actions; only the component rendering an entry differs.
  const items = (Item: ComponentType<Menu.Item.Props>) => (
    <>
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
          <Item onClick={() => meeting.media.toggleParticipantMute(person.id)}>
            {volume === 0 ? 'Восстановить громкость' : 'Отключить звук у меня'}
          </Item>
        </>
      )}
      {active && !person.service && (
        <Item onClick={() => meeting.pinCamera(person.id)}>Закрепить камеру</Item>
      )}
      {person.screen && person.screenId && person.screenStarted && (
        <Item onClick={() => meeting.openStream(person.id)}>Смотреть стрим</Item>
      )}
      {self?.owner && remote && active && (
        <Item
          onClick={() =>
            void meeting
              .command('microphone.mute', undefined, person.id)
              .catch((e) => meeting.media.report(e))
          }
        >
          Выключить микрофон для всех
        </Item>
      )}
      {self?.owner && !person.owner && (
        <Item
          className="danger-text"
          onClick={() =>
            void meeting
              .command('participant.remove', undefined, person.id)
              .catch((e) => meeting.media.report(e))
          }
        >
          Удалить из встречи
        </Item>
      )}
    </>
  );

  return (
    <ContextMenu.Root>
      {/* The trigger renders the container itself, so the tile keeps its direct children and
          the CSS that positions the button by `>` still matches. Right click and long press
          open at the pointer; the button below keeps its own menu anchored to itself. */}
      <ContextMenu.Trigger className={className} tabIndex={0}>
        {children}
        <Menu.Root>
          <Menu.Trigger className="icon-button participant-more" aria-label={`Действия: ${person.name}`}>
            <MoreHorizontal size={19} />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner sideOffset={6} align="end">
              <Menu.Popup className="action-menu participant-menu">{items(Menu.Item)}</Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner>
          <ContextMenu.Popup className="action-menu participant-menu">
            {items(ContextMenu.Item)}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
