import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Meeting } from '../core/meeting';
import type { DurakTable as Table } from '../api/types';
import { Store } from '../core/store';
import DurakTable from './DurakTable';
vi.mock('../core/sounds', () => ({ signal: vi.fn() }));
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    disconnect() {}
  },
);
afterEach(cleanup);
const seats = Array.from({ length: 6 }, (_, index) => ({
  index,
  memberId: [0, 3, 5].includes(index) ? `m${index}` : null,
  name: `Игрок ${index}`,
  held: 6,
}));
const table = {
  mode: 'podkidnoy',
  modeName: 'Подкидной',
  phase: 'bout',
  hostId: 'm0',
  deckSize: 36,
  turnSeconds: 40,
  seatingOpen: true,
  handNumber: 1,
  revision: 1,
  trump: '9h',
  trumpSuit: 'h',
  deckLeft: 12,
  discarded: 0,
  attacker: 3,
  defender: 0,
  acting: [0],
  actionAt: 1000,
  deadline: 41000,
  taking: false,
  limit: 6,
  boutEnd: null,
  boutAt: 0,
  dealtAt: 0,
  table: [{ attack: '7c', beat: null }],
  seats,
  log: [],
  you: { seat: 0, cards: ['8c'], turn: true, actions: ['take'] },
  score: [],
  result: null,
  closesAt: 0,
} as unknown as Table;
function meeting() {
  return {
    admission: { participantId: 'm0', roomId: 'room' },
    snapshot: new Store({ participants: [] }),
    media: { tracks: new Store([]) },
    control: { state: new Store('connected') },
    serverNow: () => 10000,
    command: vi.fn().mockResolvedValue(undefined),
  } as unknown as Meeting;
}
it('keyboard card selection submits exactly one beat instead of bubbling a second attack', async () => {
  const room = meeting();
  render(<DurakTable meeting={room} table={table} />);
  fireEvent.click(screen.getByRole('button', { name: '8, трефы' }), { detail: 0 });
  expect(screen.getByRole('button', { name: 'Положить на стол' })).toBeVisible();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Побить 7, трефы' })));
  expect(room.command).toHaveBeenCalledTimes(1);
  expect(room.command).toHaveBeenCalledWith('durak.act', undefined, undefined, {
    option: 'beat',
    card: '8c',
    under: '7c',
  });
});
it('renders occupied IDs only and a single external spectator seat action', () => {
  const room = meeting();
  const { container } = render(<DurakTable meeting={room} table={{ ...table, you: null }} />);
  expect(container.querySelectorAll('.durak-seat')).toHaveLength(3);
  expect(
    [...container.querySelectorAll('[data-game-seat]')].map((e) => e.getAttribute('data-game-seat')),
  ).toEqual(['0', '3', '5']);
  expect(screen.getAllByRole('button', { name: 'Сесть за стол' })).toHaveLength(1);
  expect(container.querySelector('.durak-felt .game-seat-action')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Сесть за стол' }));
  expect(room.command).toHaveBeenCalledWith('durak.sit', undefined, undefined, undefined);
});
