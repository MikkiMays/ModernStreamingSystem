import { ContextMenu } from '@base-ui/react/context-menu';
import { ChevronRight, FolderMinus, MoreHorizontal, Pencil, Pin, Plus, Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { autoJoinEnabled, setAutoJoin } from '../../core/favorites';
import {
  GROUPS_MAX,
  nudge,
  roomName,
  type FavoriteGroup,
  type SavedRoom,
  type Section,
  type SectionKey,
} from '../../core/favorite-groups';
import { formatCode, type Destination } from '../../core/invitation';
import {
  Button,
  Dialog,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  useToast,
} from '../kit';
import { useFavoritesLimit } from '../useFavorites';
import { useFavoriteShelf } from '../useFavoriteShelf';
import { InlineName } from './InlineName';
import { RoomRow, type DragHandlers, type RoomActions } from './RoomRow';

const DRAG_THRESHOLD = 5;

interface DragState {
  roomId: string;
  pointerId: number;
  x: number;
  y: number;
  active: boolean;
  target: SectionKey | null;
  index: number;
}

/**
 * Избранное в боковой панели главной (T40): закреплённые, группы и остальные комнаты, как проекты
 * и чаты в ChatGPT. ПКМ и «…» — управление комнатой и группой, перетаскивание мышью — перенос между
 * группами и порядок, Alt+↑/↓ — то же с клавиатуры. Счётчик «N из 10» виден всегда (П3).
 */
export function FavoritesNav({
  onJoin,
  here,
}: {
  onJoin: (destination: Destination) => void;
  /** Комнаты, где встреча идёт в соседней вкладке (T52). */
  here: ReadonlySet<string>;
}) {
  const { t } = useTranslation();
  const id = useId();
  const shelf = useFavoriteShelf();
  const limit = useFavoritesLimit();
  const toast = useToast();
  const [drafting, setDrafting] = useState<{ moveRoomId?: string } | null>(null);
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null);
  const [removing, setRemoving] = useState<SavedRoom | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const justDragged = useRef(false);
  /*
    Комната, которую сдвинули с клавиатуры. Шаг вниз React делает переносом самого узла строки, и
    фокус с её кнопки падает в body — второе Alt+↓ было бы уже некуда нажать. После отрисовки фокус
    возвращается туда, где он был.
  */
  const refocus = useRef<string | null>(null);
  useEffect(() => {
    const roomId = refocus.current;
    const lost = !document.activeElement || document.activeElement === document.body;
    if (!roomId || !lost) return;
    document.querySelector<HTMLElement>(`[data-room-id="${roomId}"] .home-room__open`)?.focus();
    refocus.current = null;
  });

  const fail = (error: unknown) =>
    toast.add({ title: (error as Error).message || t(($) => $.favorites.nav.failedAction), type: 'danger' });
  const run = (work: Promise<unknown>) => void work.catch(fail);

  const actions: RoomActions = {
    open: (room) => onJoin({ kind: 'favorite', favorite: room }),
    rename: (room, alias) => run(shelf.updateRoom(room.roomId, { alias })),
    togglePin: (room) => run(shelf.updateRoom(room.roomId, { pinned: !room.pinned })),
    // Группа и закрепление — разные вещи (R86): «Группа ›» меняет группу и закрепления не снимает.
    moveTo: (room, groupId) => run(shelf.updateRoom(room.roomId, { groupId })),
    newGroupWith: (room) => setDrafting({ moveRoomId: room.roomId }),
    copyCode: (room) =>
      void navigator.clipboard
        .writeText(formatCode(room.code))
        .then(() => toast.add({ title: t(($) => $.favorites.nav.copied), type: 'success' }))
        .catch(() => toast.add({ title: t(($) => $.favorites.nav.copyFailed), type: 'danger' })),
    autojoin: (room) => autoJoinEnabled(room.roomId),
    setAutojoin: (room, enabled) => setAutoJoin(room.roomId, enabled),
    remove: (room) => setRemoving(room),
    nudge: (room, step) => {
      const placement = nudge(shelf.rooms, shelf.groups, room.roomId, step);
      if (!placement) return;
      const section = shelf.sections.find((candidate) =>
        candidate.rooms.some((item) => item.roomId === room.roomId),
      )!;
      const index = section.rooms.findIndex((item) => item.roomId === room.roomId) + step;
      refocus.current = room.roomId;
      // Возвращать фокус можно только сразу после шага: позже он ушёл бы туда, куда его увели сами.
      setTimeout(() => {
        if (refocus.current === room.roomId) refocus.current = null;
      }, 1000);
      run(shelf.placeRoom(room.roomId, section.key, index));
    },
  };

  /* Перетаскивание. Только мышь и перо: на касании палец листает список, а переносят там через
     меню «Группа ›». Цель ищется по точке под указателем — раздел (`data-drop`) и строка в нём. */
  const locate = (x: number, y: number, roomId: string) => {
    const zone = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-drop]');
    const target = (zone?.dataset.drop as SectionKey | undefined) ?? null;
    if (!zone || !target) return { target: null, index: 0 };
    const rows = [...zone.querySelectorAll<HTMLElement>('[data-room-id]')].filter(
      (row) => row.dataset.roomId !== roomId,
    );
    const index = rows.findIndex((row) => {
      const box = row.getBoundingClientRect();
      return y < box.top + box.height / 2;
    });
    return { target, index: index < 0 ? rows.length : index };
  };
  const update = (next: DragState | null) => {
    dragRef.current = next;
    setDrag(next);
  };
  const dragHandlers: DragHandlers = {
    onPointerDown(event: ReactPointerEvent<HTMLElement>, room: SavedRoom) {
      // Начатое, но не ставшее перетаскиванием нажатие (указатель ушёл, отпустили мимо) не держит
      // место: новое нажатие его заменяет, иначе перетаскивание умерло бы до перезагрузки.
      if (event.button !== 0 || event.pointerType === 'touch' || dragRef.current?.active) return;
      dragRef.current = {
        roomId: room.roomId,
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        active: false,
        target: null,
        index: 0,
      };
    },
    onPointerMove(event) {
      const current = dragRef.current;
      if (!current || current.pointerId !== event.pointerId) return;
      if ((event.buttons & 1) === 0) {
        update(null);
        return;
      }
      if (!current.active) {
        if (Math.hypot(event.clientX - current.x, event.clientY - current.y) < DRAG_THRESHOLD) return;
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      update({ ...current, active: true, ...locate(event.clientX, event.clientY, current.roomId) });
    },
    onPointerUp(event) {
      const current = dragRef.current;
      if (!current || current.pointerId !== event.pointerId) return;
      update(null);
      if (!current.active) return;
      justDragged.current = true;
      if (current.target) run(shelf.placeRoom(current.roomId, current.target, current.index));
    },
    onPointerCancel() {
      update(null);
    },
    consumeDrag() {
      const dragged = justDragged.current;
      justDragged.current = false;
      return dragged;
    },
  };

  const insertionFor = (section: Section, room: SavedRoom): 'before' | 'after' | null => {
    if (!drag?.active || drag.target !== section.key || room.roomId === drag.roomId) return null;
    const visible = section.rooms.filter((item) => item.roomId !== drag.roomId);
    const at = visible.findIndex((item) => item.roomId === room.roomId);
    if (at === drag.index) return 'before';
    if (at === visible.length - 1 && drag.index >= visible.length) return 'after';
    return null;
  };

  const rooms = shelf.favorites.data ?? [];
  const total = rooms.length;
  const groupsFull = shelf.groups.length >= GROUPS_MAX;

  const renderRooms = (section: Section) => (
    <ul className="home-nav__rooms" id={`${id}-${section.key}`}>
      {section.rooms.map((room) => (
        <RoomRow
          key={room.roomId}
          room={room}
          groups={shelf.groups}
          here={here.has(room.roomId)}
          actions={actions}
          drag={dragHandlers}
          dragging={drag?.active === true && drag.roomId === room.roomId}
          insertion={insertionFor(section, room)}
        />
      ))}
    </ul>
  );

  return (
    <nav
      className="home-nav__favorites"
      aria-label={t(($) => $.favorites.nav.title)}
      data-dragging={drag?.active || undefined}
    >
      <div className="home-nav__heading" data-tour="favorites">
        <h2 className="home-nav__title">{t(($) => $.favorites.nav.title)}</h2>
        <span
          className="home-nav__count"
          data-full={total >= limit || undefined}
          aria-label={t(($) => $.favorites.nav.countLabel, { n: total, count: limit })}
          title={t(($) => $.favorites.nav.countLabel, { n: total, count: limit })}
        >
          {t(($) => $.favorites.nav.count, { n: total, max: limit })}
        </span>
        <button
          type="button"
          className="home-nav__new-group"
          aria-label={t(($) => $.favorites.nav.newGroupLabel)}
          title={
            groupsFull
              ? t(($) => $.favorites.nav.groupsFull, { max: GROUPS_MAX })
              : t(($) => $.favorites.nav.newGroupLabel)
          }
          aria-disabled={groupsFull || undefined}
          onClick={() => {
            if (!groupsFull) setDrafting({});
          }}
        >
          <Plus size={14} aria-hidden="true" />
          <span>{t(($) => $.favorites.nav.newGroup)}</span>
        </button>
      </div>

      {drafting && (
        <div className="home-group-draft">
          <span className="home-group__chevron" aria-hidden="true">
            <ChevronRight size={14} />
          </span>
          <InlineName
            initial=""
            label={t(($) => $.favorites.nav.groupField)}
            placeholder={t(($) => $.favorites.nav.groupPlaceholder)}
            onCommit={(title) => {
              const moveRoomId = drafting.moveRoomId;
              setDrafting(null);
              if (title) run(shelf.createGroup(title, moveRoomId));
            }}
            onCancel={() => setDrafting(null)}
          />
        </div>
      )}

      {shelf.sections.map((section) => {
        if (section.kind === 'pinned')
          return (
            <section key={section.key} className="home-nav__section" data-drop={section.key}>
              <h3 className="home-nav__label">{t(($) => $.favorites.nav.pinned)}</h3>
              {renderRooms(section)}
            </section>
          );
        if (section.kind === 'group' && section.group)
          return (
            <GroupSection
              key={section.key}
              section={section}
              group={section.group}
              listId={`${id}-${section.key}`}
              collapsed={shelf.collapsed.has(section.group.id)}
              renaming={renamingGroup === section.group.id}
              dropping={drag?.active === true && drag.target === section.key}
              onToggle={() => shelf.toggleCollapsed(section.group!.id)}
              onRename={() => setRenamingGroup(section.group!.id)}
              onRenamed={(title) => {
                setRenamingGroup(null);
                if (title) run(shelf.renameGroup(section.group!.id, title));
              }}
              onRemove={() => {
                const title = section.group!.title;
                void shelf
                  .removeGroup(section.group!.id)
                  .then(() =>
                    toast.add({ title: t(($) => $.favorites.nav.groupRemoved, { title }), type: 'info' }),
                  )
                  .catch(fail);
              }}
            >
              {renderRooms(section)}
            </GroupSection>
          );
        if (!section.rooms.length && !(drag?.active && shelf.groups.length)) return null;
        return (
          <section
            key={section.key}
            className="home-nav__section"
            data-drop={section.key}
            data-dropping={(drag?.active && drag.target === section.key) || undefined}
          >
            {(shelf.groups.length > 0 || shelf.sections[0]?.kind === 'pinned') && (
              <h3 className="home-nav__label">{t(($) => $.favorites.nav.loose)}</h3>
            )}
            {renderRooms(section)}
          </section>
        );
      })}

      {!total && shelf.favorites.isPending && (
        <p className="home-nav__note" role="status">
          {t(($) => $.favorites.nav.loading)}
        </p>
      )}
      {!total && !shelf.favorites.isPending && !shelf.favorites.isError && (
        <div className="home-nav__empty">
          <Star size={18} aria-hidden="true" />
          <strong>{t(($) => $.favorites.nav.emptyTitle)}</strong>
          <p>{t(($) => $.favorites.nav.emptyText)}</p>
        </div>
      )}
      {shelf.favorites.isError && (
        <p className="home-nav__note" role="status">
          {t(($) => $.favorites.nav.failed)}{' '}
          <button
            type="button"
            className="home-nav__retry"
            disabled={shelf.favorites.isFetching}
            onClick={() => void shelf.favorites.refetch()}
          >
            {t(($) => $.favorites.nav.retry)}
          </button>
        </p>
      )}

      <Dialog
        open={!!removing}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        size="sm"
        closeLabel={t(($) => $.favorites.nav.cancel)}
        title={removing ? t(($) => $.favorites.nav.removeTitle, { name: roomName(removing) }) : ''}
        description={t(($) => $.favorites.nav.removeText)}
        footer={
          <>
            <Button variant="quiet" onClick={() => setRemoving(null)}>
              {t(($) => $.favorites.nav.cancel)}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const room = removing;
                setRemoving(null);
                if (room) run(shelf.removeRoom(room.roomId));
              }}
            >
              {t(($) => $.favorites.nav.removeConfirm)}
            </Button>
          </>
        }
      />
    </nav>
  );
}

function GroupSection({
  section,
  group,
  listId,
  collapsed,
  renaming,
  dropping,
  onToggle,
  onRename,
  onRenamed,
  onRemove,
  children,
}: {
  section: Section;
  group: FavoriteGroup;
  listId: string;
  collapsed: boolean;
  renaming: boolean;
  dropping: boolean;
  onToggle: () => void;
  onRename: () => void;
  onRenamed: (title: string) => void;
  onRemove: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const items = (
    <>
      <MenuItem icon={<Pencil size={16} />} shortcut="F2" onClick={onRename}>
        {t(($) => $.favorites.nav.renameGroup)}
      </MenuItem>
      <MenuItem icon={<ChevronRight size={16} />} onClick={onToggle}>
        {collapsed ? t(($) => $.favorites.nav.expand) : t(($) => $.favorites.nav.collapse)}
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={<FolderMinus size={16} />} destructive onClick={onRemove}>
        {t(($) => $.favorites.nav.removeGroup)}
      </MenuItem>
    </>
  );
  return (
    <section
      className="home-group"
      data-drop={section.key}
      data-collapsed={collapsed || undefined}
      data-dropping={dropping || undefined}
    >
      <ContextMenu.Root>
        <ContextMenu.Trigger className="home-group__head">
          {renaming ? (
            <>
              <span className="home-group__chevron" aria-hidden="true">
                <ChevronRight size={14} />
              </span>
              <InlineName
                initial={group.title}
                label={t(($) => $.favorites.nav.renameGroupField, { title: group.title })}
                onCommit={onRenamed}
                onCancel={() => onRenamed('')}
              />
            </>
          ) : (
            <>
              <button
                type="button"
                className="home-group__toggle"
                aria-expanded={!collapsed}
                aria-controls={collapsed ? undefined : listId}
                onKeyDown={(event) => {
                  if (event.key === 'F2') {
                    event.preventDefault();
                    onRename();
                  }
                }}
                onClick={onToggle}
              >
                <span className="home-group__chevron" aria-hidden="true">
                  <ChevronRight size={14} />
                </span>
                <span className="home-group__title">{group.title}</span>
                {/* Закреплённые из группы стоят выше, но группа считает и их (R86). */}
                <span
                  className="home-group__count"
                  title={
                    section.pinned
                      ? t(($) => $.favorites.nav.pinnedInGroup, { n: section.pinned })
                      : undefined
                  }
                >
                  {section.pinned > 0 && <Pin size={12} aria-hidden="true" />}
                  {section.rooms.length + section.pinned}
                </span>
              </button>
              <Menu>
                <MenuTrigger
                  render={
                    <IconButton
                      label={t(($) => $.favorites.nav.groupActions, { title: group.title })}
                      size="sm"
                      className="home-group__more"
                    >
                      <MoreHorizontal size={16} />
                    </IconButton>
                  }
                />
                <MenuContent align="end">{items}</MenuContent>
              </Menu>
            </>
          )}
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Positioner className="ui-menu__positioner">
            <ContextMenu.Popup className="ui-menu">{items}</ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {!collapsed &&
        (section.rooms.length ? (
          children
        ) : (
          <p className="home-group__empty" id={listId}>
            {section.pinned ? t(($) => $.favorites.nav.allPinned) : t(($) => $.favorites.nav.emptyGroup)}
          </p>
        ))}
    </section>
  );
}
