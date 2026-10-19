import { useEffect, useRef } from 'react';
import type { ChessTable, GameVisualEvent, GarticTable } from '../api/types';
import type { Meeting } from '../core/meeting';
import type { GameKind } from '../core/preferences';
import {
  EventCursor,
  cardCues,
  chessCue,
  garticCues,
  playGameSound,
  preloadGameSounds,
  tickSecond,
  type GameSound,
} from '../core/game-sounds';
import { useStore } from './primitives';

const EMPTY: GameVisualEvent[] = [];

/** Карты и фишки звучат от тех же событий снимка, от которых летят (`CardMotion`, `DurakMotion`). */
export function useCardSounds(meeting: Meeting, game: 'poker' | 'durak', events: GameVisualEvent[] = EMPTY) {
  const connection = useStore(meeting.control.state);
  const cursor = useRef<EventCursor | null>(null);
  cursor.current ??= new EventCursor();
  useEffect(() => preloadGameSounds(game), [game]);
  useEffect(() => {
    const fresh = cursor.current!.take(events, connection === 'connected', meeting.serverNow());
    for (const cue of cardCues(game, fresh)) playGameSound(game, cue.sound, cue.delay);
  }, [events, connection, meeting, game]);
}

/**
 * Часы своего хода тикают последние пять секунд. Срок — серверный, поэтому тикает ровно тогда,
 * когда кольцо хода доходит до конца, а не по своим часам браузера.
 */
export function useTurnTicks(meeting: Meeting, game: GameKind, deadline: number, active: boolean) {
  useEffect(() => {
    if (!active || deadline <= 0) return;
    let last: number | null = null;
    const check = () => {
      const second = tickSecond(deadline, meeting.serverNow());
      if (second !== null && second !== last) playGameSound(game, 'tick');
      last = second;
    };
    check();
    const timer = setInterval(check, 200);
    return () => clearInterval(timer);
  }, [meeting, game, deadline, active]);
}

/** Звук один раз на событие: снимок приходит на каждое чужое действие. */
function useOnce(game: GameKind, key: string | number | null | undefined, sound: GameSound | null) {
  const played = useRef(key);
  useEffect(() => {
    if (key === null || key === undefined || played.current === key) return;
    played.current = key;
    if (sound) playGameSound(game, sound);
  }, [game, key, sound]);
}

/** Итог партии у карточного стола: победа или проигрыш этого зрителя, остальным — ничего. */
export function useResultSound(
  game: GameKind,
  at: number | null | undefined,
  outcome: 'win' | 'lose' | null,
) {
  useOnce(game, at || null, outcome);
}

/** Шахматы: ход, взятие, шах и мат — по последней записи партии; конец партии — колокольчик. */
export function useChessSounds(meeting: Meeting, table: ChessTable, myTurn: boolean) {
  const previous = useRef<ChessTable | null>(null);
  const connection = useStore(meeting.control.state);
  useEffect(() => {
    const prior = previous.current;
    previous.current = table;
    if (connection !== 'connected' || !prior) return;
    const cue = chessCue(prior, table);
    if (cue) playGameSound('chess', cue);
  }, [table, connection]);
  useTurnTicks(meeting, 'chess', table.phase === 'playing' ? table.deadline : 0, myTurn);
}

/**
 * Фишки покера. Ставок нет среди событий движения карт, поэтому звук считается по разнице двух
 * снимков, как и полёт фишек (`useChipFlights`): ставка выросла — фишка легла, ва-банк — столбик,
 * банк собрали в конце круга — столбик, банк ушёл победителю — горсть.
 */
export function usePokerChipSounds(
  meeting: Meeting,
  table: {
    handNumber: number;
    pot: number;
    seats: { index: number; bet: number; allIn: boolean }[];
    result: { at: number } | null;
  },
) {
  const connection = useStore(meeting.control.state);
  const previous = useRef(table);
  useEffect(() => {
    const prior = previous.current;
    previous.current = table;
    if (connection !== 'connected' || prior === table || prior.handNumber !== table.handNumber) return;
    if (table.result && prior.result?.at !== table.result.at) {
      playGameSound('poker', 'collect');
      return;
    }
    const before = new Map(prior.seats.map((seat) => [seat.index, seat]));
    let raised = false;
    let allIn = false;
    for (const seat of table.seats) {
      const was = before.get(seat.index);
      if (!was || seat.bet <= was.bet) continue;
      raised = true;
      allIn ||= seat.allIn && !was.allIn;
    }
    if (raised) playGameSound('poker', allIn ? 'chips' : 'chip');
    else if (table.pot > prior.pot) playGameSound('poker', 'chips');
  }, [table, connection]);
}

/** Gartic: новый раунд, верная догадка, раскрытие и конец игры; часы — последние пять секунд. */
export function useGarticSounds(meeting: Meeting, table: GarticTable, playing: boolean) {
  const previous = useRef<GarticTable | null>(null);
  const connection = useStore(meeting.control.state);
  useEffect(() => {
    const prior = previous.current;
    previous.current = table;
    if (connection !== 'connected' || !prior) return;
    garticCues(prior, table).forEach((cue, index) => playGameSound('gartic', cue, index * 160));
  }, [table, connection]);
  useTurnTicks(
    meeting,
    'gartic',
    table.deadline,
    playing && ['drawing', 'prompt', 'describing'].includes(table.phase),
  );
}
