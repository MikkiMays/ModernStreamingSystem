import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ChessTable as ChessState, Snapshot } from '../api/types';
import type { Meeting } from '../core/meeting';
import { Store } from '../core/store';
import ChessTable from './ChessTable';

vi.mock('./GamePeople', () => ({
  GamePeople: ({ memberIds }: { memberIds: string[] }) => <div>{memberIds.join(', ')}</div>,
}));
const initialFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
const afterE5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2';
let now = 10_000;

function state(overrides: Partial<ChessState> = {}): ChessState {
  return {
    id: 'chess-one',
    hostId: 'white-player',
    preset: '10-5',
    phase: 'playing',
    fen: initialFen,
    initialFen,
    turn: 'white',
    white: { memberId: 'white-player', name: 'Аня', away: false },
    black: { memberId: 'black-player', name: 'Борис', away: false },
    whiteMs: 600_000,
    blackMs: 600_000,
    anchorAt: 10_000,
    deadline: 610_000,
    incrementMs: 5000,
    ply: 0,
    moves: [],
    legalMoves: ['e2e3', 'e2e4', 'g1f3'],
    check: false,
    result: null,
    winner: null,
    drawOffer: null,
    claimableDraws: [],
    claimableMoves: [],
    rematchRequests: [],
    revision: 1,
    startedAt: 10_000,
    finishedAt: 0,
    pgn: '',
    closesAt: 0,
    ...overrides,
  };
}
function room(table = state(), participantId = 'white-player') {
  const snapshot = new Store({
    chess: table,
    participants: [
      { id: 'white-player', name: 'Аня', status: 'CONNECTED', owner: true },
      { id: 'black-player', name: 'Борис', status: 'CONNECTED', owner: false },
      { id: 'spectator', name: 'Зритель', status: 'CONNECTED', owner: false },
    ],
  } as Snapshot);
  const connection = new Store<'connected' | 'recovering'>('connected');
  const command = vi.fn().mockResolvedValue({});
  const meeting = {
    admission: { participantId },
    snapshot,
    control: { state: connection },
    serverNow: () => now,
    command,
  } as unknown as Meeting;
  return { meeting, snapshot, connection, command };
}
function square(id: string) {
  return screen.getByRole('gridcell', { name: new RegExp(`^${id},`) });
}
function update(session: ReturnType<typeof room>, chess: ChessState) {
  act(() => session.snapshot.set({ ...session.snapshot.get(), chess }));
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  now = 10_000;
});

it('submits only a server-provided click move with game and ply guards', async () => {
  const session = room();
  render(<ChessTable meeting={session.meeting} />);
  fireEvent.click(square('e2'));
  expect(square('e4')).toHaveAttribute('data-target', 'true');
  fireEvent.click(square('e5'));
  expect(session.command).not.toHaveBeenCalled();
  fireEvent.click(square('e2'));
  await act(async () => fireEvent.click(square('e4')));
  expect(session.command).toHaveBeenCalledExactlyOnceWith('chess.move', 'e2e4', undefined, {
    contentId: 'chess-one',
    positionMs: 0,
  });
});

it('uses arrows and Enter for a complete move without pointer input', async () => {
  const session = room();
  render(<ChessTable meeting={session.meeting} />);
  act(() => square('e2').focus());
  fireEvent.keyDown(square('e2'), { key: 'Enter' });
  fireEvent.keyDown(square('e2'), { key: 'ArrowUp' });
  expect(square('e3')).toHaveFocus();
  fireEvent.keyDown(square('e3'), { key: 'ArrowUp' });
  expect(square('e4')).toHaveFocus();
  await act(async () => fireEvent.keyDown(square('e4'), { key: 'Enter' }));
  expect(session.command).toHaveBeenCalledWith('chess.move', 'e2e4', undefined, expect.any(Object));
});

it('drags onto the board coordinates once and keeps the standard dark a1 square', async () => {
  class TestPointerEvent extends MouseEvent {
    pointerId: number;
    constructor(type: string, options: PointerEventInit = {}) {
      super(type, options);
      this.pointerId = options.pointerId ?? 1;
    }
  }
  vi.stubGlobal('PointerEvent', TestPointerEvent);
  const session = room();
  render(<ChessTable meeting={session.meeting} />);
  const board = screen.getByRole('grid');
  vi.spyOn(board, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    right: 400,
    bottom: 400,
    width: 400,
    height: 400,
    x: 0,
    y: 0,
    toJSON() {},
  });
  expect(square('a1')).toHaveAttribute('data-dark', 'true');
  expect(square('h1')).not.toHaveAttribute('data-dark');
  fireEvent.pointerDown(square('e2'), { pointerId: 1, button: 0, clientX: 225, clientY: 325 });
  fireEvent.pointerMove(square('e2'), { pointerId: 1, clientX: 225, clientY: 225 });
  await act(async () => fireEvent.pointerUp(square('e2'), { pointerId: 1, clientX: 225, clientY: 225 }));
  expect(session.command).toHaveBeenCalledExactlyOnceWith('chess.move', 'e2e4', undefined, {
    contentId: 'chess-one',
    positionMs: 0,
  });
});

it('offers all four explicit promotions and submits the chosen knight', async () => {
  const session = room(
    state({ fen: '4k3/P7/8/8/8/8/8/4K3 w - - 0 1', legalMoves: ['a7a8q', 'a7a8r', 'a7a8b', 'a7a8n'] }),
  );
  render(<ChessTable meeting={session.meeting} />);
  fireEvent.click(square('a7'));
  fireEvent.click(square('a8'));
  expect(session.command).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog', { name: 'Превращение пешки' })).toBeVisible();
  expect(screen.getAllByRole('button', { name: /^Превратить/ })).toHaveLength(4);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Превратить в коня' })));
  expect(session.command).toHaveBeenCalledWith('chess.move', 'a7a8n', undefined, expect.any(Object));
});

it('offers a prospective draw claim without silently playing the move', async () => {
  const session = room(state({ claimableMoves: ['g1f3'] }));
  render(<ChessTable meeting={session.meeting} />);
  fireEvent.click(square('g1'));
  fireEvent.click(square('f3'));
  expect(session.command).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Заявить ничью' })));
  expect(session.command).toHaveBeenCalledWith('chess.act', 'g1f3', undefined, {
    contentId: 'chess-one',
    positionMs: 0,
    option: 'draw-claim',
  });
});

it('keeps history review read-only and lets spectators flip the board', () => {
  const move = { ply: 1, uci: 'e2e4', san: 'e4', fen: afterE4, at: 10_000 };
  const session = room(
    state({ fen: afterE4, ply: 1, turn: 'black', moves: [move], legalMoves: [] }),
    'spectator',
  );
  render(<ChessTable meeting={session.meeting} />);
  fireEvent.click(screen.getByRole('button', { name: 'Начальная позиция' }));
  expect(square('e2')).toHaveAccessibleName('e2, белая пешка');
  fireEvent.click(square('e2'));
  fireEvent.click(square('e4'));
  expect(session.command).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Перевернуть доску' }));
  expect(screen.getAllByRole('gridcell')[0]).toHaveAttribute('data-square', 'h1');
  fireEvent.click(screen.getByRole('button', { name: 'Вернуться к игре' }));
  expect(square('e4')).toHaveAccessibleName('e4, белая пешка');
});

it('does not replay initial, missed or recovery moves but animates a fresh consecutive move', () => {
  const session = room();
  const { container } = render(<ChessTable meeting={session.meeting} />);
  expect(container.querySelectorAll('.chess-moving-piece')).toHaveLength(0);
  const first = { ply: 1, uci: 'e2e4', san: 'e4', fen: afterE4, at: now };
  update(session, state({ fen: afterE4, ply: 1, turn: 'black', moves: [first] }));
  expect(container.querySelectorAll('.chess-moving-piece')).toHaveLength(1);
  act(() => session.connection.set('recovering'));
  act(() => session.connection.set('connected'));
  const second = { ply: 2, uci: 'e7e5', san: 'e5', fen: afterE5, at: now };
  update(session, state({ fen: afterE5, ply: 2, moves: [first, second] }));
  expect(container.querySelectorAll('.chess-moving-piece')).toHaveLength(0);
  const thirdFen = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2';
  update(
    session,
    state({
      fen: thirdFen,
      ply: 3,
      turn: 'black',
      moves: [first, second, { ply: 3, uci: 'g1f3', san: 'Nf3', fen: thirdFen, at: now }],
    }),
  );
  expect(container.querySelectorAll('.chess-moving-piece')).toHaveLength(1);
});

it('respects reduced motion and computes clocks from server time', () => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  const session = room();
  const { container } = render(<ChessTable meeting={session.meeting} />);
  now = 12_000;
  act(() => vi.advanceTimersByTime(100));
  expect(screen.getByRole('timer', { name: 'Белые: 9:58' })).toBeVisible();
  expect(screen.getByRole('timer', { name: 'Чёрные: 10:00' })).toBeVisible();
  update(
    session,
    state({ fen: afterE4, ply: 1, moves: [{ ply: 1, uci: 'e2e4', san: 'e4', fen: afterE4, at: now }] }),
  );
  expect(container.querySelectorAll('.chess-moving-piece')).toHaveLength(0);
});

it('keeps a rejected server move visible as a recoverable error', async () => {
  const session = room();
  session.command.mockRejectedValueOnce(new Error('Позиция изменилась. Повторите ход.'));
  render(<ChessTable meeting={session.meeting} />);
  fireEvent.click(square('e2'));
  await act(async () => fireEvent.click(square('e4')));
  expect(screen.getByRole('alert')).toHaveTextContent('Позиция изменилась');
  expect(square('e2')).toHaveAccessibleName('e2, белая пешка');
});
