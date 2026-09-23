import { GripVertical } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Favorite } from '../core/favorites';
import { IconButton } from './primitives';

const AUTO_SCROLL_EDGE = 72;
const AUTO_SCROLL_MAX_SPEED = 18;

type ScrollTarget = HTMLElement | Window;

function isWindowTarget(target: ScrollTarget): target is Window {
  return target === window;
}

function scrollTargetFor(element: HTMLElement): ScrollTarget {
  let parent = element.parentElement;
  while (parent) {
    const overflow = window.getComputedStyle(parent).overflowY;
    if (/(auto|scroll|overlay)/.test(overflow) && parent.scrollHeight > parent.clientHeight) return parent;
    parent = parent.parentElement;
  }
  return window;
}

export function moveFavorite(roomIds: string[], roomId: string, destination: number) {
  const from = roomIds.indexOf(roomId);
  const to = Math.max(0, Math.min(destination, roomIds.length - 1));
  if (from < 0 || from === to) return roomIds;
  const next = [...roomIds];
  next.splice(from, 1);
  next.splice(to, 0, roomId);
  return next;
}

export function moveFavoriteAtInsertion(roomIds: string[], roomId: string, boundary: number) {
  const from = roomIds.indexOf(roomId);
  if (from < 0) return roomIds;
  return moveFavorite(roomIds, roomId, boundary - (from < boundary ? 1 : 0));
}

export function FavoriteReorder({
  rooms,
  pending,
  reorder,
  children,
  className = '',
}: {
  rooms: Favorite[];
  pending: boolean;
  reorder: (roomIds: string[]) => void;
  children: (room: Favorite) => ReactNode;
  className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{ roomId: string; pointerId: number; handle: HTMLButtonElement } | null>(null);
  const autoScrollFrame = useRef<number | null>(null);
  const pointerY = useRef<number | null>(null);
  const scrollTarget = useRef<ScrollTarget | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [insertion, setInsertion] = useState<number | null>(null);
  const ids = rooms.map((room) => room.roomId);
  const move = (roomId: string, destination: number) => {
    const next = moveFavorite(ids, roomId, destination);
    if (next !== ids) reorder(next);
  };
  const destinationAt = (clientY: number) => {
    const items = [...(root.current?.querySelectorAll<HTMLElement>('[data-favorite-id]') ?? [])];
    const index = items.findIndex(
      (item) => clientY < item.getBoundingClientRect().top + item.getBoundingClientRect().height / 2,
    );
    return index < 0 ? items.length : index;
  };
  const stopAutoScroll = () => {
    if (autoScrollFrame.current !== null) cancelAnimationFrame(autoScrollFrame.current);
    autoScrollFrame.current = null;
    pointerY.current = null;
    scrollTarget.current = null;
  };
  const autoScroll = () => {
    autoScrollFrame.current = null;
    const target = scrollTarget.current;
    const clientY = pointerY.current;
    if (!target || clientY === null || !drag.current) return;
    const windowTarget = isWindowTarget(target);
    const targetBounds = windowTarget
      ? { top: 0, bottom: window.innerHeight }
      : target.getBoundingClientRect();
    const bounds = {
      top: Math.max(0, targetBounds.top),
      bottom: Math.min(window.innerHeight, targetBounds.bottom),
    };
    const nearTop = Math.min(AUTO_SCROLL_EDGE, Math.max(0, AUTO_SCROLL_EDGE - (clientY - bounds.top)));
    const nearBottom = Math.min(AUTO_SCROLL_EDGE, Math.max(0, AUTO_SCROLL_EDGE - (bounds.bottom - clientY)));
    const delta = nearTop
      ? -Math.ceil((nearTop / AUTO_SCROLL_EDGE) * AUTO_SCROLL_MAX_SPEED)
      : nearBottom
        ? Math.ceil((nearBottom / AUTO_SCROLL_EDGE) * AUTO_SCROLL_MAX_SPEED)
        : 0;
    if (!delta) return;
    const before = windowTarget ? window.scrollY : target.scrollTop;
    if (windowTarget) window.scrollBy(0, delta);
    else target.scrollTop += delta;
    const after = windowTarget ? window.scrollY : target.scrollTop;
    if (after === before) return;
    setInsertion(destinationAt(clientY));
    autoScrollFrame.current = requestAnimationFrame(autoScroll);
  };
  const startAutoScroll = (element: HTMLButtonElement, clientY: number) => {
    pointerY.current = clientY;
    scrollTarget.current ??= scrollTargetFor(element);
    if (autoScrollFrame.current === null) autoScrollFrame.current = requestAnimationFrame(autoScroll);
  };
  const cancel = () => {
    const current = drag.current;
    if (current?.handle.hasPointerCapture?.(current.pointerId))
      current.handle.releasePointerCapture(current.pointerId);
    stopAutoScroll();
    drag.current = null;
    setDragging(null);
    setInsertion(null);
  };
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancel();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, []);
  useEffect(() => {
    if (pending) cancel();
  }, [pending]);
  useEffect(
    () => () => {
      stopAutoScroll();
      const current = drag.current;
      if (current?.handle.hasPointerCapture?.(current.pointerId))
        current.handle.releasePointerCapture(current.pointerId);
      drag.current = null;
    },
    [],
  );
  return (
    <div
      className={`favorite-reorder ${className}`}
      ref={root}
      role="list"
      aria-label="Порядок избранных комнат"
    >
      {rooms.map((room, index) => (
        <div
          className="favorite-reorder-item"
          key={room.roomId}
          role="listitem"
          data-favorite-id={room.roomId}
          data-dragging={dragging === room.roomId || undefined}
          data-insertion={
            dragging !== room.roomId && insertion === index
              ? 'before'
              : index === rooms.length - 1 && insertion === rooms.length
                ? 'after'
                : undefined
          }
        >
          <IconButton
            label={`Переместить «${room.title}». Стрелки вверх и вниз меняют порядок.`}
            className="favorite-reorder-handle"
            // Не `disabled`: выключенная кнопка теряет фокус, и после первого шага стрелкой
            // перестановка с клавиатуры обрывалась — фокус уезжал в body. Нажатия во время
            // сохранения и так отбрасывает каждый обработчик ниже.
            aria-disabled={pending || undefined}
            aria-grabbed={dragging === room.roomId}
            onPointerDown={(event) => {
              if (
                pending ||
                drag.current ||
                (event.isPrimary === false && (event.pointerType as string) !== '') ||
                event.button !== 0
              )
                return;
              event.preventDefault();
              event.stopPropagation();
              drag.current = { roomId: room.roomId, pointerId: event.pointerId, handle: event.currentTarget };
              scrollTarget.current = scrollTargetFor(event.currentTarget);
              setDragging(room.roomId);
              setInsertion(index);
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (
                pending ||
                drag.current?.roomId !== room.roomId ||
                drag.current.pointerId !== event.pointerId
              )
                return;
              setInsertion(destinationAt(event.clientY));
              startAutoScroll(event.currentTarget, event.clientY);
            }}
            onPointerUp={(event) => {
              if (
                pending ||
                drag.current?.roomId !== room.roomId ||
                drag.current.pointerId !== event.pointerId
              )
                return;
              event.currentTarget.releasePointerCapture(event.pointerId);
              const boundary = destinationAt(event.clientY);
              cancel();
              const next = moveFavoriteAtInsertion(ids, room.roomId, boundary);
              if (next !== ids) reorder(next);
            }}
            onPointerCancel={cancel}
            onKeyDown={(event) => {
              if (pending || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
              event.preventDefault();
              event.stopPropagation();
              move(room.roomId, index + (event.key === 'ArrowUp' ? -1 : 1));
            }}
          >
            <GripVertical size={18} />
          </IconButton>
          {children(room)}
        </div>
      ))}
    </div>
  );
}
