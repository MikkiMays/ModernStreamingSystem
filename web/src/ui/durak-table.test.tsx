import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const seats = Array.from({ length: 6 }, (_, index) => ({
  index,
  memberId: [0, 3, 5].includes(index) ? `m${index}` : null,
  name: `Игрок ${index}`,
  held: 6,
}));
const table = {
  mode: 'perevodnoy',
  modeName: 'Переводной',
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
  paused: false,
  you: {
    seat: 0,
    cards: ['8c', '7h', '9s'],
    turn: true,
    actions: ['beat', 'transfer', 'take'],
    plays: [
      { card: '8c', option: 'beat', under: '7c' },
      { card: '7h', option: 'beat', under: '7c' },
      { card: '7h', option: 'transfer', under: null },
    ],
  },
  score: [],
  result: null,
  closesAt: 0,
} as unknown as Table;
function meeting(memberId = 'm0') {
  return {
    admission: { participantId: memberId, roomId: 'room' },
    snapshot: new Store({ participants: [] }),
    media: { tracks: new Store([]) },
    control: { state: new Store('connected') },
    serverNow: () => 10000,
    command: vi.fn().mockResolvedValue(undefined),
  } as unknown as Meeting;
}
const pick = (name: string) => fireEvent.click(screen.getByRole('button', { name }), { detail: 0 });
it('selecting a beat-only card offers the exact target and submits once', async () => {
  const room = meeting();
  render(<DurakTable meeting={room} table={table} />);
  pick('8, трефы');
  expect(screen.queryByRole('button', { name: 'Перевести' })).toBeNull();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Отбить 7, трефы' })));
  expect(room.command).toHaveBeenCalledTimes(1);
  expect(room.command).toHaveBeenCalledWith('durak.act', undefined, undefined, {
    option: 'beat',
    card: '8c',
    under: '7c',
  });
});
it('one card can explicitly beat or transfer without conflating the targets', async () => {
  const room = meeting();
  render(<DurakTable meeting={room} table={table} />);
  pick('7, черви');
  expect(screen.getByRole('button', { name: 'Отбить 7, трефы' })).toBeVisible();
  expect(screen.getByText('Отбейте выделенную карту или переведите ход')).toBeVisible();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Перевести' })));
  expect(room.command).toHaveBeenCalledWith('durak.act', undefined, undefined, {
    option: 'transfer',
    card: '7h',
    under: undefined,
  });
});
it('an unavailable card creates no misleading destination and Escape cancels selection', () => {
  const room = meeting();
  const { container } = render(<DurakTable meeting={room} table={table} />);
  pick('9, пики');
  expect(screen.queryByRole('button', { name: 'Перевести' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Отбить 7, трефы' })).toBeNull();
  expect(container.querySelector('.durak-felt')).toHaveAttribute('data-choice', 'true');
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.getByRole('button', { name: '9, пики' })).toHaveAttribute('aria-pressed', 'false');
  expect(container.querySelector('.durak-felt')).not.toHaveAttribute('data-choice');
  expect(room.command).not.toHaveBeenCalled();
});
it('a new authoritative snapshot invalidates a stale destination before it can be chosen', () => {
  const room = meeting();
  const { rerender } = render(<DurakTable meeting={room} table={table} />);
  pick('7, черви');
  expect(screen.getByRole('button', { name: 'Перевести' })).toBeEnabled();
  rerender(<DurakTable meeting={room} table={{ ...table, you: { ...table.you!, plays: [] } }} />);
  expect(screen.queryByRole('button', { name: 'Перевести' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Отбить 7, трефы' })).toBeNull();
  expect(room.command).not.toHaveBeenCalled();
});
it('pending commands block double submission and rejection keeps the authoritative card', async () => {
  const room = meeting();
  let reject!: (error: Error) => void;
  vi.mocked(room.command).mockReturnValue(
    new Promise((_, failure) => {
      reject = failure;
    }),
  );
  render(<DurakTable meeting={room} table={table} />);
  pick('8, трефы');
  fireEvent.click(screen.getByRole('button', { name: 'Отбить 7, трефы' }));
  expect(screen.getByRole('button', { name: '8, трефы' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Беру' }));
  expect(room.command).toHaveBeenCalledTimes(1);
  await act(async () => reject(new Error('Этот бой уже закончился')));
  expect(screen.getByRole('alert')).toHaveTextContent('Этот бой уже закончился');
  expect(screen.getByRole('button', { name: '8, трефы' })).toBeEnabled();
});
it('renders occupied seats with no avatar count and one spectator seat action', async () => {
  const room = meeting();
  const { container } = render(<DurakTable meeting={room} table={{ ...table, you: null }} />);
  expect(container.querySelectorAll('.durak-seat')).toHaveLength(3);
  expect(
    [...container.querySelectorAll('[data-game-seat]')].map((element) =>
      element.getAttribute('data-game-seat'),
    ),
  ).toEqual(['0', '3', '5']);
  expect(container.querySelector('.durak-seat-count')).toBeNull();
  expect(screen.getAllByRole('button', { name: 'Сесть за стол' })).toHaveLength(1);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Сесть за стол' })));
  expect(room.command).toHaveBeenCalledWith('durak.sit', undefined, undefined, undefined);
});
it('paused snapshot freezes countdown, clears selection and disables playing', () => {
  vi.useFakeTimers();
  const room = meeting();
  const { rerender } = render(<DurakTable meeting={room} table={table} />);
  pick('7, черви');
  rerender(
    <DurakTable
      meeting={room}
      table={{ ...table, paused: true, pausedAt: 10000, pausedRemaining: 31000, deadline: 0 }}
    />,
  );
  expect(screen.getByLabelText('На паузе, осталось 31 секунд')).toHaveTextContent('31 с');
  act(() => vi.advanceTimersByTime(60000));
  expect(screen.getByLabelText('На паузе, осталось 31 секунд')).toHaveTextContent('31 с');
  expect(screen.getByRole('button', { name: '8, трефы' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Перевести' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Продолжить' })).toBeEnabled();
});
it('host pause uses the existing command contract; legacy snapshots hide unsupported controls', async () => {
  const room = meeting();
  const { rerender } = render(<DurakTable meeting={room} table={table} />);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Поставить игру на паузу' })));
  expect(room.command).toHaveBeenCalledWith('durak.settings', undefined, undefined, { option: 'pause' });
  rerender(<DurakTable meeting={room} table={{ ...table, paused: undefined }} />);
  expect(screen.queryByRole('button', { name: 'Поставить игру на паузу' })).toBeNull();
});
it('non-hosts see shared paused status without a resume action', () => {
  const room = meeting('m3');
  render(
    <DurakTable meeting={room} table={{ ...table, paused: true, pausedRemaining: 31000, deadline: 0 }} />,
  );
  expect(screen.getByText('Организатор продолжит игру, когда все вернутся')).toBeVisible();
  expect(screen.queryByRole('button', { name: /Продолжить/ })).toBeNull();
});
it('settings freeze timer controls during pause and close with Escape', async () => {
  const room = meeting();
  render(
    <DurakTable meeting={room} table={{ ...table, paused: true, pausedRemaining: 31000, deadline: 0 }} />,
  );
  const trigger = screen.getByRole('button', { name: 'Настройки игры' });
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = await screen.findByRole('dialog', { name: 'Настройки игры' });
  expect(within(dialog).getByRole('button', { name: '20 с' })).toBeDisabled();
  expect(within(dialog).getByText('Продолжите игру, чтобы изменить время')).toBeVisible();
  expect(within(dialog).getByRole('button', { name: /Продолжить игру/ })).toBeEnabled();
  fireEvent.keyDown(dialog, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});
it('disconnect clears selected targets and blocks game commands until recovery', () => {
  const room = meeting();
  render(<DurakTable meeting={room} table={table} />);
  pick('7, черви');
  act(() => room.control.state.set('recovering'));
  expect(screen.queryByRole('button', { name: 'Перевести' })).toBeNull();
  expect(screen.getByRole('button', { name: '8, трефы' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Поставить игру на паузу' })).toBeDisabled();
  expect(screen.getByText('Восстанавливаем соединение…')).toBeVisible();
});
it('legacy snapshots retain card play even when actions contains only take and pass', async () => {
  const room = meeting();
  render(
    <DurakTable
      meeting={room}
      table={{ ...table, paused: undefined, you: { ...table.you!, actions: ['take'], plays: undefined } }}
    />,
  );
  pick('8, трефы');
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Отбить 7, трефы' })));
  expect(room.command).toHaveBeenCalledWith('durak.act', undefined, undefined, {
    option: 'beat',
    card: '8c',
    under: '7c',
  });
});
it('picking a fresh card clears a refusal from an earlier move', async () => {
  const room = meeting();
  vi.mocked(room.command).mockRejectedValueOnce(new Error('Этот ход уже недоступен'));
  render(<DurakTable meeting={room} table={table} />);
  pick('8, трефы');
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Отбить 7, трефы' })));
  expect(screen.getByRole('alert')).toHaveTextContent('Этот ход уже недоступен');
  pick('7, черви');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('button', { name: 'Перевести' })).toBeEnabled();
});
