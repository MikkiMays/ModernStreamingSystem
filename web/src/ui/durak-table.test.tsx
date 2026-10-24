import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Meeting } from '../core/meeting';
import type { DurakTable as Table } from '../api/types';
import { Store } from '../core/store';
import DurakTable from './DurakTable';
vi.mock('../core/sounds', () => ({
  signal: vi.fn(),
  ensureNotificationAudio: vi.fn(),
  notificationAudio: () => undefined,
  soundVolume: () => 1,
}));
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
/** Голос участников: кто сейчас говорит и на какой ступени громкости (`media/levels.ts`). */
function voices(tiers: Record<string, number> = {}) {
  return { watch: () => () => {}, tier: (id: string) => tiers[id] ?? 0 };
}
function meeting(memberId = 'm0', tiers: Record<string, number> = {}) {
  return {
    admission: { participantId: memberId, roomId: 'room' },
    snapshot: new Store({ participants: [] }),
    media: { tracks: new Store([]), levels: voices(tiers) },
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
it('renders occupied seats with their card counts and one spectator seat action', async () => {
  const room = meeting();
  const { container } = render(<DurakTable meeting={room} table={{ ...table, you: null }} />);
  expect(container.querySelectorAll('.durak-seat')).toHaveLength(3);
  expect(
    [...container.querySelectorAll('[data-game-seat]')].map((element) =>
      element.getAttribute('data-game-seat'),
    ),
  ).toEqual(['0', '3', '5']);
  // T07: сколько карт на руках — у каждого места, число без рубашек веером.
  expect([...container.querySelectorAll('.durak-seat-count')].map((count) => count.textContent)).toEqual([
    '6',
    '6',
    '6',
  ]);
  expect(screen.getAllByRole('button', { name: 'Сесть за стол' })).toHaveLength(1);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Сесть за стол' })));
  expect(room.command).toHaveBeenCalledWith('durak.sit', undefined, undefined, undefined);
});
it('shows the deck and the discard on the felt, and no decisions taken for a player (R108)', () => {
  // Снимок прежнего ядра ещё мог нести «решение стола за игрока»: на столе его не видно никому.
  const legacy = {
    ...table,
    you: null,
    discarded: 8,
    seats: seats.map((seat) =>
      seat.index === 5
        ? { ...seat, auto: 'pass' }
        : seat.index === 0
          ? { ...seat, defender: true, auto: 'take' }
          : seat,
    ),
  } as unknown as Table;
  const { container } = render(<DurakTable meeting={meeting('m3')} table={legacy} />);
  expect(container.querySelector('[data-auto]')).toBeNull();
  expect(screen.queryByText('Нечего подкинуть')).toBeNull();
  expect(screen.queryByText('Нечем отбиться')).toBeNull();
  expect(
    within(container.querySelector<HTMLElement>('[data-game-seat="0"]')!).getByText('Отбивается'),
  ).toBeVisible();
  expect(container.querySelector('.durak-felt .durak-stock')).not.toBeNull();
  expect(screen.getByRole('img', { name: 'Колода: 12 карт, козырь 9, черви' })).toBeInTheDocument();
  expect(screen.getByRole('img', { name: 'Бито: 8 карт' })).toBeInTheDocument();
  expect(container.querySelector('.durak-felt-mark')).not.toBeNull();
  expect(screen.getAllByRole('button', { name: /Увеличить лицо до 1,25×/ })).toHaveLength(3);
});
it('offers «Бито» whenever the server awaits the player, with no hint about his cards (R108)', async () => {
  const room = meeting('m3');
  const throwing = {
    ...table,
    acting: [3, 5],
    table: [{ attack: '7c', beat: '8c' }],
    you: { seat: 3, cards: ['Qd', 'Jd'], turn: true, actions: ['pass'], plays: [] },
  } as unknown as Table;
  render(<DurakTable meeting={room} table={throwing} />);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Бито' })));
  expect(room.command).toHaveBeenCalledWith('durak.act', undefined, undefined, { option: 'pass' });
});
it('rings a speaking player green, as poker does (R109)', () => {
  const { container } = render(<DurakTable meeting={meeting('m0', { m3: 2 })} table={table} />);
  const speaker = container.querySelector<HTMLElement>('[data-game-seat="3"]')!;
  expect(speaker).toHaveAttribute('data-speaking', 'true');
  expect(speaker).toHaveAttribute('data-voice', '2');
  const silent = container.querySelector<HTMLElement>('[data-game-seat="5"]')!;
  expect(silent).not.toHaveAttribute('data-speaking');
});
it('winds a turn ring from the server deadline around every awaited seat, for players and watchers (R110)', () => {
  const several = { ...table, acting: [3, 5], table: [{ attack: '7c', beat: '8c' }] } as Table;
  for (const viewer of [meeting('m0', { m3: 3 }), meeting('stranger', { m3: 3 })]) {
    const { container, unmount } = render(
      <DurakTable
        meeting={viewer}
        table={viewer.admission.participantId === 'stranger' ? { ...several, you: null } : several}
      />,
    );
    const rings = [...container.querySelectorAll<HTMLElement>('[data-game-seat] .turn-ring')];
    expect(rings.map((ring) => ring.closest('[data-game-seat]')!.getAttribute('data-game-seat'))).toEqual([
      '3',
      '5',
    ]);
    // Сорок секунд хода, и девять уже прошли по часам сервера (`serverNow` = 10 000, ход с 1 000).
    const run = rings[0]!.querySelector<SVGElement>('.turn-ring-run')!;
    expect(run.style.animationDuration).toBe('40000ms');
    expect(run.style.animationDelay).toBe('-9000ms');
    // Говорящий и ждущий хода — оба кольца сразу: зелёное у лица и жёлтое снаружи.
    expect(container.querySelector('[data-game-seat="3"]')).toHaveAttribute('data-speaking', 'true');
    unmount();
  }
});
it('shows no turn ring while paused or between bouts', () => {
  const { container, rerender } = render(
    <DurakTable
      meeting={meeting()}
      table={{ ...table, paused: true, pausedRemaining: 31000, deadline: 0 }}
    />,
  );
  expect(container.querySelector('.turn-ring')).toBeNull();
  rerender(<DurakTable meeting={meeting()} table={{ ...table, acting: [], boutEnd: 'beaten' }} />);
  expect(container.querySelector('.turn-ring')).toBeNull();
});
it('lets the host pick the turn time from the same steps as poker (R110)', async () => {
  const room = meeting();
  render(<DurakTable meeting={room} table={{ ...table, turnSeconds: 45 }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Настройки игры' }));
  const dialog = await screen.findByRole('dialog', { name: 'Настройки игры' });
  const group = within(dialog).getByRole('group', { name: 'Время на ход' });
  expect(
    within(group)
      .getAllByRole('button')
      .map((button) => button.textContent),
  ).toEqual(['15 с', '30 с', '45 с', '60 с', '90 с']);
  expect(within(group).getByRole('button', { name: '45 с' })).toHaveAttribute('aria-pressed', 'true');
  await act(async () => fireEvent.click(within(group).getByRole('button', { name: '90 с' })));
  expect(room.command).toHaveBeenCalledWith('durak.settings', undefined, undefined, {
    option: 'turn',
    chips: 90,
  });
});
it('names the fool in the result and never a draw (R111)', async () => {
  const over = {
    ...table,
    phase: 'over',
    acting: [],
    table: [],
    you: null,
    result: { at: 5, foolSeat: 0, foolName: 'Игрок 0', bouts: 7, places: ['Игрок 3', 'Игрок 5'] },
  } as unknown as Table;
  render(<DurakTable meeting={meeting('m3')} table={over} />);
  const dialog = await screen.findByRole('dialog', { name: 'Итог партии' });
  expect(within(dialog).getByRole('heading', { name: 'Игрок 0 — дурак' })).toBeVisible();
  expect(within(dialog).queryByText(/Ничья/)).toBeNull();
});
it('keeps the controls row free of a standing «watch the game» hint (R27)', () => {
  render(<DurakTable meeting={meeting()} table={{ ...table, you: { ...table.you!, turn: false } }} />);
  expect(screen.queryByText('Следите за ходом игры')).toBeNull();
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
  expect(screen.getByLabelText('На паузе, осталась 31 секунда')).toHaveTextContent('31 с');
  act(() => vi.advanceTimersByTime(60000));
  expect(screen.getByLabelText('На паузе, осталась 31 секунда')).toHaveTextContent('31 с');
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
  expect(within(dialog).getByRole('button', { name: '30 с' })).toBeDisabled();
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
