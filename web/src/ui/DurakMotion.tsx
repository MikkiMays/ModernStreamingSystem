import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';
import type { DurakTable } from '../api/types';
import type { Meeting } from '../core/meeting';
import { useMediaQuery, useStore } from './primitives';
import './durak-motion.css';

/** Viewport coordinates; width/height describe the unrotated card. */
export interface DurakCardOrigin {
  left: number;
  top: number;
  width: number;
  height: number;
  angle?: number;
}

type Origin = DurakCardOrigin & { at: number };
type Flight = { target: HTMLElement; bounds: DOMRect; finish: () => void };

function orientation(element: HTMLElement, root: HTMLElement): number {
  let angle = 0;
  for (let node: HTMLElement | null = element; node && node !== root; node = node.parentElement) {
    const style = getComputedStyle(node);
    const rotate = style.rotate?.split(' ').at(-1) ?? '';
    const value = Number.parseFloat(rotate);
    if (Number.isFinite(value))
      angle += rotate.endsWith('rad')
        ? (value * 180) / Math.PI
        : rotate.endsWith('turn')
          ? value * 360
          : value;
    const matrix = style.transform
      ?.match(/^matrix(?:3d)?\((.+)\)$/)?.[1]
      ?.split(',')
      .map(Number);
    if (matrix && matrix.length >= 2) angle += (Math.atan2(matrix[1]!, matrix[0]!) * 180) / Math.PI;
  }
  return angle;
}

function measure(element: HTMLElement, root: HTMLElement): DurakCardOrigin {
  const box = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  // The bounding rectangle includes rotation; computed dimensions retain the card's shape.
  const width = Number.parseFloat(style.width) || element.offsetWidth || box.width;
  const height = Number.parseFloat(style.height) || element.offsetHeight || box.height;
  return {
    left: box.left + (box.width - width) / 2,
    top: box.top + (box.height - height) / 2,
    width,
    height,
    angle: orientation(element, root),
  };
}

function valid(origin: DurakCardOrigin) {
  return (
    origin.width > 0 &&
    origin.height > 0 &&
    [origin.left, origin.top, origin.width, origin.height, origin.angle ?? 0].every(Number.isFinite)
  );
}

/**
 * A throw is presentation of a confirmed board addition, never optimistic game state.
 * The DOM clone uses the real card face; React remains the sole owner of the hand and board.
 * WAAPI performs the flight without a React render or JS callback for each frame.
 */
export function useDurakMotion({
  meeting,
  table,
  scene,
  paused = false,
}: {
  meeting: Meeting;
  table: DurakTable;
  scene: RefObject<HTMLElement | null>;
  paused?: boolean;
}) {
  const connection = useStore(meeting.control.state);
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const pending = useRef(new Map<string, Origin>());
  const flights = useRef(new Map<string, Flight>());
  const previous = useRef<{
    meeting: Meeting;
    table: DurakTable;
    connection: typeof connection;
    cursor: number;
    board: Set<string>;
  } | null>(null);
  const awaitingSnapshot = useRef(false);

  const finishAll = useCallback(() => {
    for (const flight of flights.current.values()) flight.finish();
    pending.current.clear();
  }, []);

  const capture = useCallback(
    (card: string, source: HTMLElement | DurakCardOrigin) => {
      const root = scene.current;
      if (!root || connection !== 'connected' || paused || reduced || document.hidden) return;
      const origin = source instanceof HTMLElement ? measure(source, root) : { ...source };
      if (valid(origin)) pending.current.set(card, { ...origin, at: meeting.serverNow() });
    },
    [scene, connection, paused, reduced, meeting],
  );
  const reject = useCallback((card: string) => {
    pending.current.delete(card);
  }, []);

  // Selection or another throw can replace/reflow a target without changing its card ID.
  // Settle before that React commit is painted instead of leaving a clone at an obsolete slot.
  useLayoutEffect(() => {
    for (const flight of flights.current.values()) {
      const box = flight.target.getBoundingClientRect();
      if (
        !flight.target.isConnected ||
        Math.abs(box.left - flight.bounds.left) > 1 ||
        Math.abs(box.top - flight.bounds.top) > 1 ||
        Math.abs(box.width - flight.bounds.width) > 1 ||
        Math.abs(box.height - flight.bounds.height) > 1
      )
        flight.finish();
    }
  });

  useLayoutEffect(() => {
    const root = scene.current;
    if (!root) return;
    const interrupt = () => finishAll();
    const visibility = () => {
      if (document.hidden) {
        awaitingSnapshot.current = true;
        finishAll();
      }
    };
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(interrupt) : null;
    observer?.observe(root);
    window.addEventListener('resize', interrupt);
    window.addEventListener('scroll', interrupt, true);
    document.addEventListener('fullscreenchange', interrupt);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', interrupt);
      window.removeEventListener('scroll', interrupt, true);
      document.removeEventListener('fullscreenchange', interrupt);
      document.removeEventListener('visibilitychange', visibility);
      finishAll();
    };
  }, [scene, finishAll]);

  useLayoutEffect(() => {
    const root = scene.current;
    const events = table.visualEvents ?? [];
    const cursor = events.reduce((max, event) => Math.max(max, event.id), 0);
    const board = new Set(
      table.table.flatMap((pair) => (pair.beat ? [pair.attack, pair.beat] : [pair.attack])),
    );
    const prior = previous.current;
    const recovering = connection !== 'connected' || (prior && prior.connection !== 'connected');
    if (recovering || document.hidden) awaitingSnapshot.current = true;
    const baseline =
      !prior ||
      prior.meeting !== meeting ||
      prior.table.handNumber !== table.handNumber ||
      cursor < prior.cursor ||
      recovering ||
      awaitingSnapshot.current;
    if (connection === 'connected' && !document.hidden && prior && prior.table !== table)
      awaitingSnapshot.current = false;
    previous.current = { meeting, table, connection, cursor, board };

    if (
      !root ||
      baseline ||
      reduced ||
      paused ||
      document.hidden ||
      table.phase !== 'bout' ||
      table.boutEnd
    ) {
      finishAll();
      return;
    }
    for (const [card, flight] of flights.current) {
      if (!board.has(card) || !flight.target.isConnected) flight.finish();
    }

    const now = meeting.serverNow();
    const additions = events.filter(
      (event) => event.id > prior.cursor && event.type === 'play' && now - event.at < 1500,
    );
    // A large catch-up is a new state, not a queue of throws to replay.
    if (additions.length > 4) {
      finishAll();
      return;
    }
    const layerRoot = root.querySelector<HTMLElement>('.durak-table') ?? root;
    const bounds = layerRoot.getBoundingClientRect();
    for (const event of additions) {
      for (const card of event.cards) {
        if (!board.has(card) || prior.board.has(card) || flights.current.has(card)) continue;
        const target = [...root.querySelectorAll<HTMLElement>('[data-durak-board-card]')].find(
          (element) => element.dataset.durakBoardCard === card,
        );
        if (!target || typeof target.animate !== 'function') continue;
        const to = measure(target, root);
        if (!valid(to)) continue;
        const local = event.fromSeat === table.you?.seat;
        const cached = pending.current.get(card);
        const seat = root.querySelector<HTMLElement>(`[data-game-seat="${event.fromSeat}"]`);
        const seatBox = seat?.getBoundingClientRect();
        const from = local
          ? cached && now - cached.at <= 5000
            ? cached
            : null
          : seatBox && seatBox.width > 0 && seatBox.height > 0
            ? {
                left: seatBox.left + seatBox.width / 2 - to.width * 0.44,
                top: seatBox.top + seatBox.height / 2 - to.height * 0.44,
                width: to.width * 0.88,
                height: to.height * 0.88,
                angle: seatBox.left < to.left ? -12 : 12,
              }
            : null;
        pending.current.delete(card);
        if (!from || !valid(from)) continue;

        const layer = document.createElement('div');
        layer.className = 'durak-motion-layer';
        layer.setAttribute('aria-hidden', 'true');
        layer.inert = true;
        const clone = target.cloneNode(true) as HTMLElement;
        clone.removeAttribute('data-durak-board-card');
        clone.classList.add('durak-motion-card');
        Object.assign(clone.style, {
          width: `${to.width}px`,
          height: `${to.height}px`,
          left: `${to.left - bounds.left}px`,
          top: `${to.top - bounds.top}px`,
          visibility: 'visible',
        });
        clone.style.setProperty('--card-w', `${to.width}px`);
        layer.append(clone);
        layerRoot.append(layer);
        const dx = from.left + from.width / 2 - (to.left + to.width / 2);
        const dy = from.top + from.height / 2 - (to.top + to.height / 2);
        const distance = Math.hypot(dx, dy);
        const duration = Math.min(360, Math.max(280, 260 + distance * 0.2));
        const transform = (x: number, y: number, sx: number, sy: number, angle: number) =>
          `translate3d(${x}px, ${y}px, 0) rotate(${angle}deg) scale(${sx}, ${sy})`;
        let animation: Animation;
        try {
          animation = clone.animate(
            [
              {
                transform: transform(dx, dy, from.width / to.width, from.height / to.height, from.angle ?? 0),
              },
              {
                offset: 0.58,
                transform: transform(
                  dx * 0.42,
                  dy * 0.42 - Math.min(24, distance * 0.06),
                  1 + (from.width / to.width - 1) * 0.42,
                  1 + (from.height / to.height - 1) * 0.42,
                  (from.angle ?? 0) * 0.42 + (to.angle ?? 0) * 0.58,
                ),
              },
              { transform: transform(0, 0, 1, 1, to.angle ?? 0) },
            ],
            { duration, easing: 'cubic-bezier(0.2, 0.65, 0.3, 1)', fill: 'both' },
          );
        } catch {
          layer.remove();
          continue;
        }
        const visibility = target.style.visibility;
        target.style.visibility = 'hidden';
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          animation.onfinish = null;
          animation.oncancel = null;
          animation.cancel();
          target.style.visibility = visibility;
          layer.remove();
          flights.current.delete(card);
        };
        const timer = setTimeout(finish, duration + 100);
        animation.onfinish = finish;
        animation.oncancel = finish;
        flights.current.set(card, { target, bounds: target.getBoundingClientRect(), finish });
      }
    }
    for (const [card, source] of pending.current) {
      if (board.has(card) || now - source.at > 5000) pending.current.delete(card);
    }
  }, [table, meeting, connection, reduced, paused, scene, finishAll]);

  return { capture, reject };
}
