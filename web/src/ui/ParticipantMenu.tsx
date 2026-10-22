import { ContextMenu } from '@base-ui/react/context-menu';
import { Menu } from '@base-ui/react/menu';
import { MicOff, MonitorUp, MoreHorizontal, Pin, PinOff, UserX, Volume2, VolumeX } from 'lucide-react';
import type { ComponentType, CSSProperties, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Participant } from '../api/types';
import type { Meeting } from '../core/meeting';
import { allowed } from '../core/permissions';
import { Slider, useStore } from './primitives';

type ItemComponent = ComponentType<Menu.Item.Props>;

/**
 * Пункт в виде меню набора (`kit/Menu.tsx`, R28): значок слева, высота 36 (под пальцем 44), а не
 * прежние 48 своего `.action-menu`. Компонент пункта свой у каждого меню — кнопочного и по ПКМ.
 */
function Row({
  Item,
  icon,
  destructive = false,
  onClick,
  children,
}: {
  Item: ItemComponent;
  icon: ReactNode;
  destructive?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Item
      className={destructive ? 'ui-menu__item ui-menu__item--destructive' : 'ui-menu__item'}
      onClick={onClick}
    >
      <span className="ui-menu__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="ui-menu__label">{children}</span>
    </Item>
  );
}

/**
 * Закрепить или открепить камеру — одним пунктом, своей тоже (R83). Свой компонент: о закреплении
 * спрашивает только открытое меню.
 */
function PinItem({ Item, meeting, person }: { Item: ItemComponent; meeting: Meeting; person: Participant }) {
  const { t } = useTranslation();
  const pinned = useStore(meeting.pinnedCamera) === person.id;
  return pinned ? (
    <Row Item={Item} icon={<PinOff />} onClick={() => meeting.unpinCamera()}>
      {t(($) => $.stage.menu.unpin)}
    </Row>
  ) : (
    <Row Item={Item} icon={<Pin />} onClick={() => meeting.pinCamera(person.id)}>
      {t(($) => $.stage.menu.pin)}
    </Row>
  );
}

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
  const { t } = useTranslation();
  const snapshot = useStore(meeting.snapshot);
  const volumes = useStore(meeting.media.volumes);
  const self = snapshot.participants.find((p) => p.id === meeting.admission.participantId);
  const remote = person.id !== self?.id;
  const volume = volumes[person.id] ?? 1;
  const active = person.status !== 'WAITING';

  // Both menus list the same actions; only the component rendering an entry differs.
  const items = (Item: ItemComponent) => (
    <>
      <strong className="participant-menu__name">{person.name}</strong>
      {remote && active && (
        <>
          <label className="participant-volume">
            {t(($) => $.stage.menu.volume, { value: Math.round(volume * 100) })}
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
              aria-label={t(($) => $.stage.menu.volumeOf, { name: person.name })}
              onChange={(e) => meeting.media.setVolume(person.id, Number(e.target.value) / 100)}
            />
          </label>
          <Row
            Item={Item}
            icon={volume === 0 ? <Volume2 /> : <VolumeX />}
            onClick={() => meeting.media.toggleParticipantMute(person.id)}
          >
            {volume === 0 ? t(($) => $.stage.menu.unmute) : t(($) => $.stage.menu.mute)}
          </Row>
        </>
      )}
      {active && !person.service && <PinItem Item={Item} meeting={meeting} person={person} />}
      {/* Свою демонстрацию не смотрят: это тот же экран, на котором она открыта, только
          с задержкой и через сеть. Показывающему нужна не она, а кнопка «остановить». */}
      {remote && person.screen && person.screenId && person.screenStarted && (
        <Row Item={Item} icon={<MonitorUp />} onClick={() => meeting.openStream(person.id)}>
          {t(($) => $.stage.menu.watch)}
        </Row>
      )}
      {allowed(snapshot, meeting.admission.participantId, 'participant.mute') && remote && active && (
        <Row
          Item={Item}
          icon={<MicOff />}
          onClick={() =>
            void meeting
              .command('microphone.mute', undefined, person.id)
              .catch((e) => meeting.media.report(e))
          }
        >
          {t(($) => $.stage.menu.muteForAll)}
        </Row>
      )}
      {/* Создателя не исключают: это правило о цели, а не о праве (`RoomService`). */}
      {allowed(snapshot, meeting.admission.participantId, 'participant.remove') && !person.owner && (
        <Row
          Item={Item}
          icon={<UserX />}
          destructive
          onClick={() =>
            void meeting
              .command('participant.remove', undefined, person.id)
              .catch((e) => meeting.media.report(e))
          }
        >
          {t(($) => $.stage.menu.remove)}
        </Row>
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
          <Menu.Trigger
            className="icon-button participant-more"
            aria-label={t(($) => $.stage.menu.actions, { name: person.name })}
          >
            <MoreHorizontal size={16} />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner className="ui-menu__positioner" sideOffset={6} align="end">
              <Menu.Popup className="ui-menu participant-menu">{items(Menu.Item)}</Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="ui-menu__positioner">
          <ContextMenu.Popup className="ui-menu participant-menu">
            {items(ContextMenu.Item)}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
