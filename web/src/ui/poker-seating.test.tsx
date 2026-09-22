import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { PokerSeat, PokerTable } from '../api/types';
import type { Meeting } from '../core/meeting';
import { Store } from '../core/store';
import PokerScene from './PokerTable';
vi.mock('../core/sounds', () => ({ signal: vi.fn() }));
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    disconnect() {}
  },
);
afterEach(cleanup);
function seat(index: number, patch: Partial<PokerSeat> = {}): PokerSeat {
  return {
    index,
    memberId: `p${index}`,
    name: `Игрок ${index}`,
    stack: 5000,
    bet: 0,
    committed: 0,
    buyIn: 5000,
    cards: [],
    held: 0,
    revealed: false,
    inHand: false,
    folded: false,
    allIn: false,
    waiting: false,
    away: false,
    leaving: false,
    busted: false,
    place: 0,
    lastAction: '',
    lastActionAmount: 0,
    wonAmount: 0,
    handName: '',
    handCards: [],
    timeBankMs: 60000,
    ...patch,
  };
}

function table(patch: Partial<PokerTable> = {}): PokerTable {
  return {
    mode: 'friendly',
    modeName: 'Дружеская игра',
    phase: 'preflop',
    hostId: 'p0',
    handNumber: 1,
    revision: 1,
    button: 0,
    smallBlind: 25,
    bigBlind: 50,
    ante: 0,
    level: 1,
    levelUpAt: 0,
    turnSeconds: 45,
    seatingOpen: true,
    autoDeal: true,
    awaiting: false,
    paused: false,
    rebuy: true,
    rebuyLimit: -1,
    rebuyChips: 5000,
    startingStack: 5000,
    pot: 0,
    betToCall: 50,
    actor: 0,
    actionAt: 1000,
    deadline: 46000,
    streetAt: 1000,
    handStartedAt: 1000,
    board: [],
    seats: Array.from({ length: 10 }, (_, index) =>
      seat(index, { memberId: index < 3 ? `p${index}` : null }),
    ),
    pots: [],
    log: [],
    result: null,
    you: null,
    commitment: '',
    seed: '',
    closesAt: 0,
    summary: null,
    ...patch,
  };
}

it('asks the server for a seat instead of choosing one from a stale snapshot', () => {
  const command = vi.fn().mockResolvedValue(undefined);
  const room = {
    admission: { participantId: 'spectator', roomId: 'room' },
    snapshot: new Store({ participants: [] }),
    media: { tracks: new Store([]), preferences: new Store({}), speaking: new Store([]) },
    control: { state: new Store('connected') },
    serverNow: () => 10000,
    command,
  } as unknown as Meeting;
  render(<PokerScene meeting={room} table={table({ phase: 'lobby' })} />);
  fireEvent.click(screen.getByRole('button', { name: 'Сесть за стол' }));
  expect(command).toHaveBeenCalledWith('poker.sit', undefined, undefined, undefined);
});
