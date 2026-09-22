import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { GameVisualEvent } from '../api/types';
import type { Meeting } from '../core/meeting';
import type { GameSeatSpot } from '../core/game-layout';
import { faceOf } from '../core/durak';
import { useMediaQuery, useStore } from './primitives';

export function useTableRatio() {
  const ref = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState(2);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.height > 0) setRatio(entry.contentRect.width / entry.contentRect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, ratio };
}

export function GameTurn({
  meeting,
  deadline,
  active,
  label,
}: {
  meeting: Meeting;
  deadline: number;
  active: boolean;
  label: string;
}) {
  const [now, setNow] = useState(() => meeting.serverNow());
  useEffect(() => {
    setNow(meeting.serverNow());
    if (!active) return;
    const timer = setInterval(() => setNow(meeting.serverNow()), 250);
    return () => clearInterval(timer);
  }, [meeting, deadline, active]);
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1000));
  return (
    <div
      className="game-turn"
      data-active={active || undefined}
      data-urgent={(active && seconds <= 5) || undefined}
    >
      <strong role="status">{label}</strong>
      {active && <span aria-label={`Осталось ${seconds} секунд`}>{seconds} с</span>}
    </div>
  );
}

const EMPTY: GameVisualEvent[] = [];
/** First snapshot and recovery establish a cursor. Only new, live, recent events animate. */
export function CardMotion({
  meeting,
  events = EMPTY,
  spots,
}: {
  meeting: Meeting;
  events?: GameVisualEvent[];
  spots: GameSeatSpot[];
}) {
  const connection = useStore(meeting.control.state);
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const cursor = useRef<number | null>(null);
  const previousConnection = useRef(connection);
  const previousEvents = useRef(events);
  const recoverySnapshot = useRef(false);
  const layer = useRef<HTMLDivElement>(null);
  const geometry = useRef(spots);
  geometry.current = spots;
  type Motion = GameVisualEvent & {
    delay: number;
    from: { x: number; y: number };
    to: { x: number; y: number };
  };
  const [visible, setVisible] = useState<Motion[]>([]);
  useEffect(() => {
    const max = events.reduce((value, event) => Math.max(value, event.id), 0);
    if (connection !== 'connected' || previousConnection.current !== 'connected')
      recoverySnapshot.current = true;
    const recoveredSnapshot =
      connection === 'connected' && recoverySnapshot.current && previousEvents.current !== events;
    const baseline =
      cursor.current === null ||
      connection !== 'connected' ||
      previousConnection.current !== 'connected' ||
      max < cursor.current ||
      recoverySnapshot.current;
    previousConnection.current = connection;
    previousEvents.current = events;
    if (recoveredSnapshot) recoverySnapshot.current = false;
    const next =
      baseline || reduced
        ? []
        : events.filter((event) => event.id > cursor.current! && meeting.serverNow() - event.at < 2200);
    cursor.current = max;
    const bounds = layer.current?.getBoundingClientRect();
    const root = layer.current?.closest('.poker, .durak');
    const point = (selector: string, fallback: { x: number; y: number }) => {
      const box = root?.querySelector(selector)?.getBoundingClientRect();
      return box && bounds && bounds.width && bounds.height
        ? {
            x: ((box.left + box.width / 2 - bounds.left) / bounds.width) * 100,
            y: ((box.top + box.height / 2 - bounds.top) / bounds.height) * 100,
          }
        : fallback;
    };
    const placed = next.map((event, order) => {
      const fromFallback = geometry.current.find((spot) => spot.index === event.fromSeat) ?? { x: 24, y: 50 };
      const toFallback = geometry.current.find((spot) => spot.index === event.toSeat) ?? {
        x: event.type === 'discard' ? 80 : 50,
        y: 50,
      };
      const from =
        event.fromSeat !== null
          ? point(`[data-game-seat="${event.fromSeat}"]`, fromFallback)
          : point(
              event.type === 'deal' || event.type === 'draw'
                ? '.poker-deck, .durak-stock-cards'
                : '.poker-board, .durak-mat',
              { x: event.type === 'deal' || event.type === 'draw' ? 24 : 50, y: 50 },
            );
      const to =
        event.toSeat !== null
          ? point(`[data-game-seat="${event.toSeat}"]`, toFallback)
          : point(event.type === 'discard' ? '.durak-discard' : '.poker-board, .durak-mat', toFallback);
      return {
        ...event,
        from,
        to,
        delay: Math.min(order * 35, 1100) - Math.max(0, meeting.serverNow() - event.at),
      };
    });
    setVisible((current) =>
      baseline || reduced
        ? []
        : [...current, ...placed].filter((event) => meeting.serverNow() - event.at < 2200),
    );
    const timer = setTimeout(() => setVisible([]), 2300);
    return () => clearTimeout(timer);
  }, [events, connection, reduced, meeting]);
  return (
    <div className="game-motion" ref={layer} aria-hidden="true">
      {visible.flatMap((event) => {
        const { from, to } = event;
        return Array.from({ length: Math.min(event.count, 12) }, (_, index) => {
          const card = event.cards[index];
          const face = card ? faceOf(card) : null;
          return (
            <span
              className="game-card-flight"
              data-back={!face || undefined}
              data-red={face?.red || undefined}
              key={`${event.id}-${index}`}
              style={
                {
                  '--fx': `${from.x}%`,
                  '--fy': `${from.y}%`,
                  '--tx': `${to.x}%`,
                  '--ty': `${to.y}%`,
                  animationDelay: `${event.delay + index * 40}ms`,
                } as CSSProperties
              }
            >
              {face && (
                <>
                  {face.rank}
                  <br />
                  {face.glyph}
                </>
              )}
            </span>
          );
        });
      })}
    </div>
  );
}
