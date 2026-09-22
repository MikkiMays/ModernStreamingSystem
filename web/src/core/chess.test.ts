import { describe, expect, it } from 'vitest';
import {
  boardSquares,
  capturedPieces,
  clockLabel,
  clockRemaining,
  moveTravels,
  positionFromFen,
  squareAtPoint,
} from './chess';

describe('chess presentation without a second rules engine', () => {
  it('reads positions and refuses malformed ranks', () => {
    expect(positionFromFen('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1')).toEqual({ e8: 'k', e2: 'P', e1: 'K' });
    expect(positionFromFen('4k3/8/8/8/8/8/9/4K3 w - - 0 1')).toEqual({});
    expect(positionFromFen('invalid')).toEqual({});
  });

  it('maps pointer drops using board bounds and orientation', () => {
    const bounds = { left: 100, top: 50, width: 400, height: 400 };
    expect(squareAtPoint(125, 75, bounds, false)).toBe('a8');
    expect(squareAtPoint(125, 75, bounds, true)).toBe('h1');
    expect(squareAtPoint(499, 449, bounds, false)).toBe('h1');
    expect(squareAtPoint(500, 449, bounds, false)).toBeNull();
    expect(squareAtPoint(99, 75, bounds, false)).toBeNull();
    expect(boardSquares(true)).toEqual(boardSquares(false).reverse());
  });

  it('animates both pieces in either castling direction', () => {
    expect(moveTravels('4k3/8/8/8/8/8/8/4K2R w K - 0 1', '4k3/8/8/8/8/8/8/5RK1 b - - 1 1', 'e1g1')).toEqual([
      { from: 'e1', to: 'g1', piece: 'K', promoted: null },
      { from: 'h1', to: 'f1', piece: 'R', promoted: null },
    ]);
    expect(moveTravels('r3k3/8/8/8/8/8/8/4K3 b q - 0 1', '2kr4/8/8/8/8/8/8/4K3 w - - 1 2', 'e8c8')).toEqual([
      { from: 'e8', to: 'c8', piece: 'k', promoted: null },
      { from: 'a8', to: 'd8', piece: 'r', promoted: null },
    ]);
  });

  it('keeps a pawn in motion until its chosen underpromotion arrives', () => {
    expect(moveTravels('4k3/P7/8/8/8/8/8/4K3 w - - 0 1', 'N3k3/8/8/8/8/8/8/4K3 b - - 0 1', 'a7a8n')).toEqual([
      { from: 'a7', to: 'a8', piece: 'P', promoted: 'N' },
    ]);
  });

  it('shows actual captures including en passant and a promoted queen', () => {
    const ep = capturedPieces('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1', [
      { uci: 'e5d6', fen: '4k3/8/3P4/8/8/8/8/4K3 b - - 0 1' },
    ]);
    expect(ep).toEqual({ white: ['p'], black: [] });
    const promoted = capturedPieces('4k3/8/8/8/8/8/q7/R3K3 w - - 0 1', [
      { uci: 'a1a2', fen: '4k3/8/8/8/8/8/R7/4K3 b - - 0 1' },
    ]);
    expect(promoted.white).toEqual(['q']);
  });

  it('derives running time from the server anchor and never subtracts from the stopped clock', () => {
    expect(clockRemaining(60_000, 10_000, 13_050, true)).toBe(56_950);
    expect(clockRemaining(60_000, 10_000, 13_050, false)).toBe(60_000);
    expect(clockRemaining(1000, 10_000, 13_050, true)).toBe(0);
    expect(clockRemaining(1000, 10_000, 9000, true)).toBe(1000);
    expect(clockLabel(59_950)).toBe('1:00');
    expect(clockLabel(9_920)).toBe('10.0');
    expect(clockLabel(-400)).toBe('0.0');
  });
});
