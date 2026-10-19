import { ContextMenu } from '@base-ui/react/context-menu';
import {
  ArrowRight,
  Check,
  Copy,
  FolderInput,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Trash2,
  Zap,
} from 'lucide-react';
import { useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { roomName, type FavoriteGroup, type SavedRoom } from '../../core/favorite-groups';
import { formatCode } from '../../core/invitation';
import {
  Badge,
  IconButton,
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuSubmenu,
  MenuTrigger,
} from '../kit';
import { InlineName } from './InlineName';

/** Строки строки избранного — в одном месте, до слоя переводов (E14). */
export const ROOM_TEXT = {
  actions: (name: string) => `Действия с «${name}»`,
  open: 'Открыть',
  rename: 'Переименовать у себя',
  renameField: (name: string) => `Своё имя для «${name}»`,
  pin: 'Закрепить',
  unpin: 'Открепить',
  group: 'Группа',
  noGroup: 'Без группы',
  newGroup: 'Новая группа…',
  copy: 'Скопировать код',
  autojoin: 'Автоподключение',
  remove: 'Убрать из избранного',
  here: 'вы здесь',
  forgotten: 'Комната больше не помнит вас',
  pinned: 'Закреплена',
};

export interface RoomActions {
  open: (room: SavedRoom) => void;
  rename: (room: SavedRoom, alias: string | null) => void;
  togglePin: (room: SavedRoom) => void;
  moveTo: (room: SavedRoom, groupId: string | null) => void;
  newGroupWith: (room: SavedRoom) => void;
  copyCode: (room: SavedRoom) => void;
  autojoin: (room: SavedRoom) => boolean;
  setAutojoin: (room: SavedRoom, enabled: boolean) => void;
  remove: (room: SavedRoom) => void;
  nudge: (room: SavedRoom, step: -1 | 1) => void;
}

/**
 * Меню комнаты — одно и то же на ПКМ, на долгом касании и на «…» (образец — меню ChatGPT,
 * `refs/README.md`): значок, действие, сочетание клавиш справа, разрушительное — последним.
 */
function RoomMenuItems({
  room,
  groups,
  actions,
  onRename,
}: {
  room: SavedRoom;
  groups: FavoriteGroup[];
  actions: RoomActions;
  onRename: () => void;
}) {
  const automatic = actions.autojoin(room);
  return (
    <>
      <MenuItem icon={<ArrowRight size={16} />} shortcut="Enter" onClick={() => actions.open(room)}>
        {ROOM_TEXT.open}
      </MenuItem>
      <MenuItem icon={<Pencil size={16} />} shortcut="F2" onClick={onRename}>
        {ROOM_TEXT.rename}
      </MenuItem>
      <MenuItem
        icon={room.pinned ? <PinOff size={16} /> : <Pin size={16} />}
        onClick={() => actions.togglePin(room)}
      >
        {room.pinned ? ROOM_TEXT.unpin : ROOM_TEXT.pin}
      </MenuItem>
      <MenuSubmenu icon={<FolderInput size={16} />} label={ROOM_TEXT.group}>
        <MenuItem
          icon={!room.groupId ? <Check size={16} /> : null}
          onClick={() => actions.moveTo(room, null)}
        >
          {ROOM_TEXT.noGroup}
        </MenuItem>
        {groups.map((group) => (
          <MenuItem
            key={group.id}
            icon={room.groupId === group.id ? <Check size={16} /> : null}
            onClick={() => actions.moveTo(room, group.id)}
          >
            {group.title}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem icon={<FolderPlus size={16} />} onClick={() => actions.newGroupWith(room)}>
          {ROOM_TEXT.newGroup}
        </MenuItem>
      </MenuSubmenu>
      <MenuItem icon={<Copy size={16} />} onClick={() => actions.copyCode(room)}>
        {ROOM_TEXT.copy}
      </MenuItem>
      <MenuCheckboxItem
        className="ui-menu__item"
        checked={automatic}
        onCheckedChange={(checked) => actions.setAutojoin(room, checked)}
      >
        <span className="ui-menu__icon" aria-hidden="true">
          {automatic ? <Check size={16} /> : <Zap size={16} />}
        </span>
        <span className="ui-menu__label">{ROOM_TEXT.autojoin}</span>
      </MenuCheckboxItem>
      <MenuSeparator />
      <MenuItem icon={<Trash2 size={16} />} shortcut="Del" destructive onClick={() => actions.remove(room)}>
        {ROOM_TEXT.remove}
      </MenuItem>
    </>
  );
}

export interface DragHandlers {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>, room: SavedRoom) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: () => void;
  /** Был ли последний жест перетаскиванием — тогда это не нажатие «открыть». */
  consumeDrag: () => boolean;
}

export function RoomRow({
  room,
  groups,
  here,
  actions,
  drag,
  dragging,
  insertion,
}: {
  room: SavedRoom;
  groups: FavoriteGroup[];
  /** Эта встреча идёт сейчас в соседней вкладке. */
  here: boolean;
  actions: RoomActions;
  drag: DragHandlers;
  dragging: boolean;
  insertion: 'before' | 'after' | null;
}) {
  const [renaming, setRenaming] = useState(false);
  const name = roomName(room);
  let body: ReactNode;
  if (renaming)
    body = (
      <InlineName
        initial={room.alias ?? room.title}
        label={ROOM_TEXT.renameField(room.title)}
        placeholder={room.title}
        onCommit={(value) => {
          setRenaming(false);
          actions.rename(room, value && value !== room.title ? value : null);
        }}
        onCancel={() => setRenaming(false)}
      />
    );
  else
    body = (
      <button
        type="button"
        className="home-room__open"
        // Не `disabled`: комнату, которая вас забыла, всё равно нужно уметь убрать или перенести —
        // с клавиатуры и мышью. Открыть её нельзя, и это говорит строка под названием.
        aria-disabled={!room.canJoin || undefined}
        onClick={() => {
          if (!drag.consumeDrag() && room.canJoin) actions.open(room);
        }}
        onPointerDown={(event) => drag.onPointerDown(event, room)}
        onPointerMove={drag.onPointerMove}
        onPointerUp={drag.onPointerUp}
        onPointerCancel={drag.onPointerCancel}
        onKeyDown={(event) => {
          if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
            event.preventDefault();
            actions.nudge(room, event.key === 'ArrowUp' ? -1 : 1);
          }
          if (event.key === 'F2') {
            event.preventDefault();
            setRenaming(true);
          }
          if (event.key === 'Delete') {
            event.preventDefault();
            actions.remove(room);
          }
        }}
      >
        <span className="home-room__tile" aria-hidden="true">
          {name.trim().slice(0, 1).toLocaleUpperCase() || '·'}
        </span>
        <span className="home-room__text">
          <span className="home-room__name">{name}</span>
          <span className="home-room__code" data-warning={!room.canJoin || undefined}>
            {room.canJoin ? formatCode(room.code) : ROOM_TEXT.forgotten}
          </span>
        </span>
        {here && (
          <Badge variant="accent" className="home-room__here">
            {ROOM_TEXT.here}
          </Badge>
        )}
        {room.pinned && !here && (
          <Pin size={14} className="home-room__pin" aria-label={ROOM_TEXT.pinned} role="img" />
        )}
      </button>
    );
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger
        render={
          <li
            className="home-room"
            data-room-id={room.roomId}
            data-here={here || undefined}
            data-dragging={dragging || undefined}
            data-insert={insertion ?? undefined}
          />
        }
      >
        {body}
        {!renaming && (
          <Menu>
            <MenuTrigger
              render={
                <IconButton label={ROOM_TEXT.actions(name)} size="sm" className="home-room__more">
                  <MoreHorizontal size={16} />
                </IconButton>
              }
            />
            <MenuContent align="end">
              <RoomMenuItems
                room={room}
                groups={groups}
                actions={actions}
                onRename={() => setRenaming(true)}
              />
            </MenuContent>
          </Menu>
        )}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="ui-menu__positioner">
          <ContextMenu.Popup className="ui-menu">
            <RoomMenuItems room={room} groups={groups} actions={actions} onRename={() => setRenaming(true)} />
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
