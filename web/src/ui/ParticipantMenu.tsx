import { ContextMenu } from '@base-ui/react/context-menu';
import { Menu } from '@base-ui/react/menu';
import { MoreHorizontal } from 'lucide-react';
import type { ComponentType, CSSProperties, ReactNode } from 'react';
import type { Participant } from '../api/types';
import type { Meeting } from '../core/meeting';
import { Slider, useStore } from './primitives';

/** The same menu and keyboard behavior are used on tiles and in the participant list. */
export function ParticipantMenu({
  meeting,
  person,
  children,
  className = '',
  style,
  ...marks
}: {
  meeting: Meeting;
  person: Participant;
  children: ReactNode;
  className?: string;
  /** Место плитки в сетке: его считает сцена по своему настоящему размеру, а не CSS. */
  style?: CSSProperties;
} & Record<`data-${string}`, string | undefined>) {
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
            {/*
              Музыкальный бот — участник комнаты по устройству, но не по смыслу: его дорожка
              приходит сведённой и на своём уровне. Потолок для него такой же, как у ползунка
              под плеером, иначе 200 % можно было бы выставить в обход него.
            */}
            <Slider
              min={0}
              max={person.service ? 100 : 200}
              step={1}
              value={Math.round(volume * 100)}
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
      {/* Свою демонстрацию не смотрят: это тот же экран, на котором она открыта, только
          с задержкой и через сеть. Показывающему нужна не она, а кнопка «остановить». */}
      {remote && person.screen && person.screenId && person.screenStarted && (
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
      <ContextMenu.Trigger className={className} style={style} tabIndex={0} {...marks}>
        {children}
        <Menu.Root>
          <Menu.Trigger className="icon-button participant-more" aria-label={`Действия: ${person.name}`}>
            <MoreHorizontal size={19} />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner className="menu-layer" sideOffset={6} align="end">
              <Menu.Popup className="action-menu participant-menu">{items(Menu.Item)}</Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="menu-layer">
          <ContextMenu.Popup className="action-menu participant-menu">
            {items(ContextMenu.Item)}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
