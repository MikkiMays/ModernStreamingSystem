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
import { useTranslation } from 'react-i18next';
import { roomName, type FavoriteGroup, type SavedRoom } from '../../core/favorite-groups';
import { formatCode } from '../../core/invitation';
import {
  Badge,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuSubmenu,
  MenuSwitchItem,
  MenuTrigger,
} from '../kit';
import { InlineName } from './InlineName';

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
  const { t } = useTranslation();
  // Автовход живёт в `localStorage`, не в состоянии React: без своей копии переключатель в открытом
  // меню не перерисовался бы после щелчка.
  const [automatic, setAutomatic] = useState(() => actions.autojoin(room));
  return (
    <>
      <MenuItem icon={<ArrowRight size={16} />} shortcut="Enter" onClick={() => actions.open(room)}>
        {t(($) => $.favorites.room.open)}
      </MenuItem>
      <MenuItem icon={<Pencil size={16} />} shortcut="F2" onClick={onRename}>
        {t(($) => $.favorites.room.rename)}
      </MenuItem>
      <MenuItem
        icon={room.pinned ? <PinOff size={16} /> : <Pin size={16} />}
        onClick={() => actions.togglePin(room)}
      >
        {room.pinned ? t(($) => $.favorites.room.unpin) : t(($) => $.favorites.room.pin)}
      </MenuItem>
      <MenuSubmenu icon={<FolderInput size={16} />} label={t(($) => $.favorites.room.group)}>
        <MenuItem
          icon={!room.groupId ? <Check size={16} /> : null}
          onClick={() => actions.moveTo(room, null)}
        >
          {t(($) => $.favorites.room.noGroup)}
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
          {t(($) => $.favorites.room.newGroup)}
        </MenuItem>
      </MenuSubmenu>
      <MenuItem icon={<Copy size={16} />} onClick={() => actions.copyCode(room)}>
        {t(($) => $.favorites.room.copy)}
      </MenuItem>
      {/* Да или нет — переключателем в меню (X4, R70): состояние видно по нему, значок постоянный.
          Щелчок меню не закрывает — видно, что переключилось; закрывают Esc или щелчок мимо. */}
      <MenuSwitchItem
        icon={<Zap size={16} />}
        checked={automatic}
        onCheckedChange={(checked) => {
          setAutomatic(checked);
          actions.setAutojoin(room, checked);
        }}
      >
        {t(($) => $.favorites.room.autojoin)}
      </MenuSwitchItem>
      <MenuSeparator />
      <MenuItem icon={<Trash2 size={16} />} shortcut="Del" destructive onClick={() => actions.remove(room)}>
        {t(($) => $.favorites.room.remove)}
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
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState(false);
  const name = roomName(room);
  const group = room.pinned ? groups.find((candidate) => candidate.id === room.groupId) : undefined;
  let body: ReactNode;
  if (renaming)
    body = (
      <InlineName
        initial={room.alias ?? room.title}
        label={t(($) => $.favorites.room.renameField, { name: room.title })}
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
            {room.canJoin ? formatCode(room.code) : t(($) => $.favorites.room.forgotten)}
            {/* Закреплённая из группы стоит в «Закреплено» одна, без копии в группе (R86): своя
                группа видна здесь, а открепление вернёт её туда. */}
            {group && <span className="home-room__group"> · {group.title}</span>}
          </span>
        </span>
        {here && (
          <Badge variant="accent" className="home-room__here">
            {t(($) => $.favorites.room.here)}
          </Badge>
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
            data-pinned={room.pinned || undefined}
            data-dragging={dragging || undefined}
            data-insert={insertion ?? undefined}
          />
        }
      >
        {body}
        {!renaming && (
          <div className="home-room__actions">
            {/* «Закрепить» — слева от «…» у каждой встречи (R71): у закреплённой видна всегда и
                синяя, у остальных — под указателем и фокусом, на касании — всегда (Р-4). Имя одно и
                то же, состояние — `aria-pressed`; пункт в меню остаётся для клавиатуры и ПКМ. */}
            <IconButton
              label={t(($) => $.favorites.room.pinNamed, { name })}
              title={room.pinned ? t(($) => $.favorites.room.unpin) : t(($) => $.favorites.room.pin)}
              aria-pressed={room.pinned}
              size="sm"
              className="home-room__pin"
              onClick={() => actions.togglePin(room)}
            >
              <Pin size={16} />
            </IconButton>
            <Menu>
              <MenuTrigger
                render={
                  <IconButton
                    label={t(($) => $.favorites.room.actions, { name })}
                    size="sm"
                    className="home-room__more"
                  >
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
          </div>
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
