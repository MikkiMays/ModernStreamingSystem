/** Presentation only. Move legality, clocks and results belong to the server. */
export type ChessColor = 'white' | 'black';
export type ChessPiece = 'p' | 'n' | 'b' | 'r' | 'q' | 'k' | 'P' | 'N' | 'B' | 'R' | 'Q' | 'K';
export type ChessPosition = Record<string, ChessPiece>;
export const FILES = 'abcdefgh';

export function positionFromFen(fen: string): ChessPosition {
  const position: ChessPosition = {};
  const ranks = fen.split(' ')[0]?.split('/') ?? [];
  if (ranks.length !== 8) return position;
  for (let row = 0; row < 8; row++) {
    let file = 0;
    for (const token of ranks[row]!) {
      if (/^[1-8]$/.test(token)) file += Number(token);
      else if (/^[pnbrqkPNBRQK]$/.test(token) && file < 8)
        position[`${FILES[file++]}${8 - row}`] = token as ChessPiece;
      else return {};
    }
    if (file !== 8) return {};
  }
  return position;
}

export function pieceColor(piece: ChessPiece): ChessColor {
  return piece === piece.toUpperCase() ? 'white' : 'black';
}

export function pieceLabel(piece: ChessPiece): string {
  const white = pieceColor(piece) === 'white';
  switch (piece.toLowerCase()) {
    case 'p':
      return `${white ? 'белая' : 'чёрная'} пешка`;
    case 'r':
      return `${white ? 'белая' : 'чёрная'} ладья`;
    case 'n':
      return `${white ? 'белый' : 'чёрный'} конь`;
    case 'b':
      return `${white ? 'белый' : 'чёрный'} слон`;
    case 'q':
      return `${white ? 'белый' : 'чёрный'} ферзь`;
    default:
      return `${white ? 'белый' : 'чёрный'} король`;
  }
}

export function pieceImage(piece: ChessPiece): string {
  return `/games/chess-${pieceColor(piece)}-${piece.toLowerCase()}.svg`;
}

export function boardSquares(flipped: boolean): string[] {
  const squares = Array.from({ length: 64 }, (_, i) => `${FILES[i % 8]}${8 - Math.floor(i / 8)}`);
  return flipped ? squares.reverse() : squares;
}

export function squarePoint(square: string, flipped: boolean): { x: number; y: number } {
  const x = FILES.indexOf(square.charAt(0));
  const y = 8 - Number(square.charAt(1));
  return flipped ? { x: 7 - x, y: 7 - y } : { x, y };
}

export function squareAtPoint(
  x: number,
  y: number,
  bounds: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  flipped: boolean,
): string | null {
  if (!bounds.width || !bounds.height) return null;
  const col = Math.floor(((x - bounds.left) / bounds.width) * 8);
  const row = Math.floor(((y - bounds.top) / bounds.height) * 8);
  if (col < 0 || col > 7 || row < 0 || row > 7) return null;
  return boardSquares(flipped)[row * 8 + col] ?? null;
}

export interface PieceTravel {
  from: string;
  to: string;
  piece: ChessPiece;
  promoted: ChessPiece | null;
}

/** Derive the king AND rook displacement from consecutive authoritative positions. */
export function moveTravels(previousFen: string, nextFen: string, uci: string): PieceTravel[] {
  const previous = positionFromFen(previousFen);
  const next = positionFromFen(nextFen);
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const piece = previous[from];
  if (!piece || !next[to]) return [];
  const landed = next[to]!;
  const travels: PieceTravel[] = [{ from, to, piece, promoted: landed !== piece ? landed : null }];
  if (
    piece.toLowerCase() === 'k' &&
    Math.abs(FILES.indexOf(from.charAt(0)) - FILES.indexOf(to.charAt(0))) === 2
  ) {
    const rookFrom = `${to[0] === 'g' ? 'h' : 'a'}${from[1]}`;
    const rookTo = `${to[0] === 'g' ? 'f' : 'd'}${from[1]}`;
    const rook = previous[rookFrom];
    if (rook && next[rookTo] === rook)
      travels.push({ from: rookFrom, to: rookTo, piece: rook, promoted: null });
  }
  return travels;
}

/** Count actual disappeared opponents, including en passant and captured promotions. */
export function capturedPieces(
  initialFen: string,
  moves: readonly { uci: string; fen: string }[],
): Record<ChessColor, ChessPiece[]> {
  const captured: Record<ChessColor, ChessPiece[]> = { white: [], black: [] };
  let before = positionFromFen(initialFen);
  for (const move of moves) {
    const after = positionFromFen(move.fen);
    const moved = before[move.uci.slice(0, 2)];
    if (moved) {
      const color = pieceColor(moved);
      for (const [square, piece] of Object.entries(before)) {
        if (pieceColor(piece) !== color && after[square] !== piece) captured[color].push(piece);
      }
    }
    before = after;
  }
  const order = 'qrbnpk';
  for (const pieces of Object.values(captured))
    pieces.sort((a, b) => order.indexOf(a.toLowerCase()) - order.indexOf(b.toLowerCase()));
  return captured;
}

export function clockRemaining(remaining: number, anchor: number, now: number, running: boolean): number {
  return Math.max(0, remaining - (running ? Math.max(0, now - anchor) : 0));
}

export function clockLabel(milliseconds: number): string {
  const bounded = Math.max(0, milliseconds);
  if (bounded < 10_000) return (Math.ceil(bounded / 100) / 10).toFixed(1);
  const seconds = Math.ceil(bounded / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export const CHESS_PRESETS: Record<string, string> = {
  untimed: 'Без часов',
  '3-2': '3 + 2',
  '5-0': '5 + 0',
  '10-5': '10 + 5',
  '15-10': '15 + 10',
};

export const CHESS_RESULTS: Record<string, string> = {
  checkmate: 'Мат',
  stalemate: 'Пат',
  'insufficient-material': 'Недостаточно материала для мата',
  resignation: 'Соперник сдался',
  'resignation-insufficient-material': 'У соперника нет материала для мата',
  agreement: 'Ничья по соглашению',
  timeout: 'Время истекло',
  'timeout-insufficient-material': 'Время истекло, мат невозможен',
  threefold: 'Троекратное повторение',
  fivefold: 'Пятикратное повторение',
  'fifty-move': 'Правило 50 ходов',
  'seventy-five-move': 'Правило 75 ходов',
};
