import '../chess.css';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import {
  ArrowLeftRight,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  Download,
  Flag,
  Handshake,
  Play,
  RotateCcw,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ChessTable as ChessState } from '../api/types';
import type { Meeting } from '../core/meeting';
import {
  boardSquares,
  capturedPieces,
  clockLabel,
  clockRemaining,
  FILES,
  moveTravels,
  pieceColor,
  pieceImage,
  pieceLabel,
  positionFromFen,
  presetLabel,
  resultLabel,
  squareAtPoint,
  squarePoint,
  type ChessColor,
  type ChessPiece,
  type PieceTravel,
} from '../core/chess';
import { allowed } from '../core/permissions';
import { GamePeople } from './GamePeople';
import { useChessSounds } from './useGameSounds';
import { IconButton, Modal, useMediaQuery, useStore } from './primitives';

interface Drag {
  from: string;
  piece: ChessPiece;
  pointerId: number;
  originX: number;
  originY: number;
  x: number;
  y: number;
  size: number;
  moved: boolean;
}
const PROMOTIONS = ['q', 'r', 'b', 'n'] as const;

export default function ChessTable({ meeting }: { meeting: Meeting }) {
  const snapshot = useStore(meeting.snapshot);
  const table = snapshot.chess;
  return table ? <ChessGame key={table.id} meeting={meeting} table={table} /> : null;
}

function ChessGame({ meeting, table }: { meeting: Meeting; table: ChessState }) {
  const { t } = useTranslation();
  const snapshot = useStore(meeting.snapshot);
  const connection = useStore(meeting.control.state);
  const me = meeting.admission.participantId;
  const color: ChessColor | null =
    table.white?.memberId === me ? 'white' : table.black?.memberId === me ? 'black' : null;
  const host = allowed({ ...snapshot, chess: table }, me, 'chess.manage');
  // Ход, взятие, шах и мат звучат у всех от записи партии; часы тикают только у того, чей ход.
  useChessSounds(meeting, table, color !== null && table.phase === 'playing' && table.turn === color);
  const [flippedOverride, setFlipped] = useState<boolean | null>(null);
  const flipped = flippedOverride ?? color === 'black';
  const [selected, setSelected] = useState<string | null>(null);
  const [focused, setFocused] = useState(color === 'black' ? 'e7' : 'e2');
  const [reviewPly, setReviewPly] = useState<number | null>(null);
  const [promotion, setPromotion] = useState<string[] | null>(null);
  const [claimMove, setClaimMove] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<'resign' | 'close' | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const ignoreClick = useRef(false);
  const board = useRef<HTMLDivElement>(null);
  const notation = useRef<HTMLOListElement>(null);
  const previousPly = useRef(table.ply);
  const minimumPly = table.moves[0] ? table.moves[0].ply - 1 : table.ply;
  const shownPly = reviewPly === null ? table.ply : Math.max(minimumPly, Math.min(reviewPly, table.ply));
  const live = reviewPly === null;
  const shownFen = live
    ? table.fen
    : (table.moves.find((move) => move.ply === shownPly)?.fen ?? table.initialFen);
  const position = positionFromFen(shownFen);
  const squares = boardSquares(flipped);
  const shownMove = table.moves.find((move) => move.ply === shownPly);
  const lastSquares = shownMove ? [shownMove.uci.slice(0, 2), shownMove.uci.slice(2, 4)] : [];
  const canMove =
    live && table.phase === 'playing' && color === table.turn && !pending && connection === 'connected';
  const picked = drag?.from ?? selected;
  const targets = new Set(
    picked ? table.legalMoves.filter((move) => move.startsWith(picked)).map((move) => move.slice(2, 4)) : [],
  );
  const captured = capturedPieces(
    table.initialFen,
    table.moves.filter((move) => move.ply <= shownPly),
  );
  const motion = useChessMotion(meeting, table, !live, flipped);
  const movingTo = new Set(motion.map((travel) => travel.to));
  const spectators = snapshot.participants
    .filter(
      (person) =>
        !person.service &&
        ['JOINING', 'CONNECTED', 'RECOVERING'].includes(person.status) &&
        person.id !== table.white?.memberId &&
        person.id !== table.black?.memberId,
    )
    .map((person) => person.id);

  useEffect(() => {
    if (previousPly.current !== table.ply || table.phase !== 'playing' || connection !== 'connected') {
      setSelected(null);
      setPromotion(null);
      setClaimMove(null);
      setDrag(null);
      dragRef.current = null;
    }
    previousPly.current = table.ply;
  }, [table.ply, table.phase, connection]);
  useEffect(() => {
    if (live) notation.current?.lastElementChild?.scrollIntoView?.({ block: 'nearest' });
  }, [table.ply, live]);

  async function send(
    type: Parameters<Meeting['command']>[0],
    text?: string,
    extra?: Parameters<Meeting['command']>[3],
  ) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError('');
    try {
      await meeting.command(type, text, undefined, { contentId: table.id, positionMs: table.ply, ...extra });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t(($) => $.chess.sendFailed));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  function playMove(uci: string) {
    setPromotion(null);
    setSelected(null);
    if (table.claimableMoves.includes(uci)) setClaimMove(uci);
    else void send('chess.move', uci);
  }

  function place(from: string, to: string) {
    if (!canMove) return;
    const choices = table.legalMoves.filter((move) => move.slice(0, 4) === `${from}${to}`);
    if (choices.length === 0) {
      const piece = position[to];
      setSelected(piece && pieceColor(piece) === color ? to : null);
      return;
    }
    if (choices.some((move) => move.length === 5)) setPromotion(choices);
    else playMove(choices[0]!);
  }

  function choose(square: string) {
    setFocused(square);
    if (!canMove || promotion || claimMove) return;
    if (selected === square) setSelected(null);
    else if (selected && targets.has(square)) place(selected, square);
    else {
      const piece = position[square];
      setSelected(piece && pieceColor(piece) === color ? square : null);
    }
  }

  function lift(square: string, event: PointerEvent<HTMLButtonElement>) {
    const piece = position[square];
    if (!canMove || promotion || claimMove || !piece || pieceColor(piece) !== color || event.button !== 0)
      return;
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const next = {
      from: square,
      piece,
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      size: (board.current?.getBoundingClientRect().width ?? 400) / 8,
      moved: false,
    };
    dragRef.current = next;
    setDrag(next);
  }

  function movePointer(event: PointerEvent<HTMLButtonElement>) {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const next = {
      ...current,
      x: event.clientX,
      y: event.clientY,
      moved:
        current.moved || Math.hypot(event.clientX - current.originX, event.clientY - current.originY) > 5,
    };
    dragRef.current = next;
    setDrag(next);
  }

  function drop(event: PointerEvent<HTMLButtonElement>) {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDrag(null);
    if (!current.moved) return;
    ignoreClick.current = true;
    const bounds = board.current?.getBoundingClientRect();
    const to = bounds && squareAtPoint(event.clientX, event.clientY, bounds, flipped);
    if (to) place(current.from, to);
    // The click following pointerup belongs to the drag, not a second selection.
    setTimeout(() => {
      ignoreClick.current = false;
    }, 0);
  }

  function review(ply: number | null) {
    setReviewPly(ply);
    setSelected(null);
    setPromotion(null);
  }

  function downloadPgn() {
    const url = URL.createObjectURL(new Blob([table.pgn], { type: 'application/x-chess-pgn;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `cord-chess-${table.id}.pgn`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const turnSide: ChessColor = table.turn === 'white' ? 'white' : 'black';
  const winner: ChessColor = table.winner === 'white' ? 'white' : 'black';
  const resultTitle = table.winner ? t(($) => $.chess.status.winner[winner]) : t(($) => $.chess.status.draw);
  const turn =
    table.turn === color ? t(($) => $.chess.status.yourTurn) : t(($) => $.chess.status.turn[turnSide]);
  const status =
    table.phase === 'lobby'
      ? t(($) => $.chess.status.lobby)
      : table.phase === 'over'
        ? resultTitle
        : `${turn}${table.check ? ` · ${t(($) => $.chess.status.check)}` : ''}`;
  const topColor: ChessColor = flipped ? 'white' : 'black';
  const bottomColor: ChessColor = flipped ? 'black' : 'white';
  const moveRows = new Map<number, typeof table.moves>();
  for (const move of table.moves) {
    const number = Math.ceil(move.ply / 2);
    moveRows.set(number, [...(moveRows.get(number) ?? []), move]);
  }

  function playerBar(side: ChessColor) {
    const player = table[side];
    const label = t(($) => $.chess.sides[side]);
    const active = table.phase === 'playing' && table.turn === side;
    return (
      <div className="chess-player" data-active={active || undefined} data-color={side}>
        <span className="chess-color-mark" aria-hidden="true" />
        <div className="chess-player-person">
          {player ? (
            <GamePeople meeting={meeting} memberIds={[player.memberId]} game="chess" />
          ) : (
            <span className="chess-empty-player">
              {label} · {t(($) => $.chess.freeSeat)}
            </span>
          )}
          <div className="chess-player-detail">
            <span>
              {label}
              {player?.away ? ` · ${t(($) => $.chess.away)}` : ''}
            </span>
            {captured[side].length > 0 && (
              <span
                className="chess-captured"
                aria-label={t(($) => $.chess.captured, {
                  pieces: captured[side].map((piece) => pieceLabel(t, piece)).join(', '),
                })}
              >
                {captured[side].map((piece, index) => (
                  <img key={index} src={pieceImage(piece)} alt="" />
                ))}
              </span>
            )}
          </div>
        </div>
        {!player && table.phase !== 'playing' ? (
          <button
            className="button secondary chess-seat"
            disabled={pending}
            onClick={() => void send('chess.sit', undefined, { seat: side === 'white' ? 0 : 1 })}
          >
            {t(($) => $.chess.sit[side])}
          </button>
        ) : (
          <ChessClock
            meeting={meeting}
            remaining={side === 'white' ? table.whiteMs : table.blackMs}
            anchor={table.anchorAt}
            running={active}
            untimed={table.preset === 'untimed'}
            label={label}
          />
        )}
      </div>
    );
  }

  return (
    <section className="chess" aria-label={t(($) => $.chess.title)} data-phase={table.phase}>
      <header className="chess-header">
        <div className="chess-heading">
          <h2>{t(($) => $.chess.title)}</h2>
          <span>{presetLabel(t, table.preset)}</span>
        </div>
        <div className="chess-header-actions">
          <IconButton
            label={t(($) => $.chess.flip)}
            onClick={() => {
              setFlipped(!flipped);
              setSelected(null);
            }}
          >
            <ArrowLeftRight size={20} />
          </IconButton>
          <IconButton
            label={t(($) => $.chess.downloadPgn)}
            disabled={table.moves.length === 0}
            onClick={downloadPgn}
          >
            <Download size={20} />
          </IconButton>
          {host && (
            <IconButton
              label={t(($) => $.chess.close)}
              disabled={pending}
              onClick={() => setConfirmation('close')}
            >
              <X size={20} />
            </IconButton>
          )}
        </div>
      </header>
      <div className="chess-layout">
        <div className="chess-playing-area">
          {playerBar(topColor)}
          <div className="chess-board-frame">
            <div
              className="chess-board"
              ref={board}
              role="grid"
              aria-label={t(($) => $.chess.board)}
              aria-describedby="chess-status"
              data-interactive={canMove || undefined}
            >
              {Array.from({ length: 8 }, (_, row) => (
                <div role="row" className="chess-rank" key={row}>
                  {squares.slice(row * 8, row * 8 + 8).map((square, column) => {
                    const piece = position[square];
                    const check =
                      live && table.check && piece?.toLowerCase() === 'k' && pieceColor(piece) === table.turn;
                    return (
                      <button
                        type="button"
                        role="gridcell"
                        key={square}
                        data-square={square}
                        className="chess-square"
                        data-dark={
                          (FILES.indexOf(square.charAt(0)) + Number(square[1])) % 2 !== 0 || undefined
                        }
                        data-last={lastSquares.includes(square) || undefined}
                        data-selected={picked === square || undefined}
                        data-target={targets.has(square) || undefined}
                        data-occupied={!!piece || undefined}
                        data-check={check || undefined}
                        aria-label={[
                          square,
                          piece ? pieceLabel(t, piece) : t(($) => $.chess.square.empty),
                          targets.has(square) && t(($) => $.chess.square.target),
                          check && t(($) => $.chess.square.check),
                        ]
                          .filter(Boolean)
                          .join(', ')}
                        aria-selected={picked === square}
                        tabIndex={focused === square ? 0 : -1}
                        onFocus={() => setFocused(square)}
                        onClick={() => {
                          if (!ignoreClick.current) choose(square);
                        }}
                        onPointerDown={(event) => lift(square, event)}
                        onPointerMove={movePointer}
                        onPointerUp={drop}
                        onPointerCancel={() => {
                          dragRef.current = null;
                          setDrag(null);
                        }}
                        onLostPointerCapture={() => {
                          dragRef.current = null;
                          setDrag(null);
                        }}
                        onKeyDown={(event) => {
                          const index = squares.indexOf(square);
                          const deltas: Record<string, number> = {
                            ArrowLeft: -1,
                            ArrowRight: 1,
                            ArrowUp: -8,
                            ArrowDown: 8,
                          };
                          if (event.key in deltas) {
                            event.preventDefault();
                            const delta = deltas[event.key]!;
                            const next = index + delta;
                            if (
                              next >= 0 &&
                              next < 64 &&
                              (Math.abs(delta) === 8 || Math.floor(next / 8) === row)
                            ) {
                              setFocused(squares[next]!);
                              board.current
                                ?.querySelector<HTMLButtonElement>(`[data-square="${squares[next]}"]`)
                                ?.focus();
                            }
                          } else if (event.key === 'Escape') {
                            setSelected(null);
                            setPromotion(null);
                          } else if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            choose(square);
                          }
                        }}
                      >
                        {piece && (
                          <img
                            className="chess-piece"
                            src={pieceImage(piece)}
                            alt=""
                            draggable={false}
                            data-hidden={
                              movingTo.has(square) || (drag?.moved && drag.from === square) || undefined
                            }
                          />
                        )}
                        {column === 0 && (
                          <span className="chess-coordinate chess-rank-label" aria-hidden="true">
                            {square[1]}
                          </span>
                        )}
                        {row === 7 && (
                          <span className="chess-coordinate chess-file-label" aria-hidden="true">
                            {square[0]}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))}
              {motion.map((travel) => {
                const from = squarePoint(travel.from, flipped);
                const to = squarePoint(travel.to, flipped);
                return (
                  <div
                    key={`${table.ply}-${travel.from}`}
                    className="chess-moving-piece"
                    aria-hidden="true"
                    style={
                      {
                        left: `${to.x * 12.5}%`,
                        top: `${to.y * 12.5}%`,
                        '--from-x': `${(from.x - to.x) * 100}%`,
                        '--from-y': `${(from.y - to.y) * 100}%`,
                      } as CSSProperties
                    }
                  >
                    <img
                      src={pieceImage(travel.piece)}
                      alt=""
                      className={travel.promoted ? 'chess-promoting-pawn' : undefined}
                    />
                    {travel.promoted && (
                      <img src={pieceImage(travel.promoted)} alt="" className="chess-promoted-piece" />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          {playerBar(bottomColor)}
          {!live && (
            <div className="chess-review-notice">
              <span>
                {shownPly === minimumPly
                  ? t(($) => $.chess.review.start)
                  : t(($) => $.chess.review.move, {
                      move: `${Math.ceil(shownPly / 2)}${shownPly % 2 ? '.' : '…'}`,
                    })}
              </span>
              <button type="button" onClick={() => review(null)}>
                {t(($) => $.chess.review.back)}
              </button>
            </div>
          )}
        </div>

        <aside className="chess-sidebar" aria-label={t(($) => $.chess.sidebar)}>
          <div className="chess-status-block">
            <span className="chess-live-dot" data-active={table.phase === 'playing' || undefined} />
            <h3 id="chess-status" role="status">
              {status}
            </h3>
          </div>
          {connection !== 'connected' && (
            <p className="chess-notice" role="status">
              {t(($) => $.chess.reconnecting)}
            </p>
          )}
          {table.phase === 'lobby' && (
            <div className="chess-lobby">
              <p>{t(($) => $.chess.lobby.intro)}</p>
              {host && (
                <button
                  className="button"
                  disabled={pending || !table.white || !table.black}
                  onClick={() => void send('chess.start')}
                >
                  <Play size={16} />
                  {t(($) => $.chess.lobby.start)}
                </button>
              )}
              {host && (!table.white || !table.black) && <small>{t(($) => $.chess.lobby.needPlayers)}</small>}
              {!host && table.white && table.black && <small>{t(($) => $.chess.lobby.hostStarts)}</small>}
            </div>
          )}
          {table.phase === 'over' && (
            <div className="chess-result">
              <strong>
                {table.winner === 'white' ? '1 — 0' : table.winner === 'black' ? '0 — 1' : '½ — ½'}
              </strong>
              <p>{resultLabel(t, table.result)}</p>
              {color && (
                <button
                  className="button"
                  disabled={pending || table.rematchRequests.includes(me) || !table.white || !table.black}
                  onClick={() => void send('chess.act', undefined, { option: 'rematch' })}
                >
                  <RotateCcw size={16} />
                  {table.rematchRequests.includes(me)
                    ? t(($) => $.chess.rematch.waiting)
                    : table.rematchRequests.length
                      ? t(($) => $.chess.rematch.accept)
                      : t(($) => $.chess.rematch.again)}
                </button>
              )}
              <small>{t(($) => $.chess.rematch.swapColors)}</small>
            </div>
          )}
          <div className="chess-notation-heading">
            <h4>{t(($) => $.chess.notation.title)}</h4>
            <span>{live ? t(($) => $.chess.notation.live) : t(($) => $.chess.notation.review)}</span>
          </div>
          <ol className="chess-notation" ref={notation} aria-label={t(($) => $.chess.notation.history)}>
            {[...moveRows].map(([number, moves]) => (
              <li key={number}>
                <span>{number}.</span>
                {[1, 0].map((parity) => {
                  const move = moves.find((candidate) => candidate.ply % 2 === parity);
                  return move ? (
                    <button
                      key={parity}
                      type="button"
                      aria-current={move.ply === shownPly ? 'step' : undefined}
                      aria-label={t(($) => $.chess.notation.move[parity ? 'white' : 'black'], {
                        number,
                        san: move.san,
                      })}
                      onClick={() => review(move.ply)}
                    >
                      {move.san}
                    </button>
                  ) : (
                    <span key={parity} />
                  );
                })}
              </li>
            ))}
            {table.moves.length === 0 && (
              <li className="chess-no-moves">{t(($) => $.chess.notation.empty)}</li>
            )}
          </ol>
          <div className="chess-history-controls">
            <IconButton
              label={t(($) => $.chess.notation.start)}
              disabled={shownPly <= minimumPly}
              onClick={() => review(minimumPly)}
            >
              <ChevronsLeft size={16} />
            </IconButton>
            <IconButton
              label={t(($) => $.chess.notation.previous)}
              disabled={shownPly <= minimumPly}
              onClick={() => review(shownPly - 1)}
            >
              <ChevronLeft size={16} />
            </IconButton>
            <IconButton
              label={t(($) => $.chess.notation.next)}
              disabled={live || shownPly >= table.ply}
              onClick={() => review(shownPly + 1)}
            >
              <ChevronRight size={16} />
            </IconButton>
            <button
              className="chess-return-live"
              type="button"
              aria-pressed={live}
              onClick={() => review(null)}
            >
              <span />
              {t(($) => $.chess.notation.liveButton)}
            </button>
          </div>

          {color && table.phase === 'playing' && (
            <div className="chess-game-actions">
              {table.drawOffer && table.drawOffer !== color ? (
                <div className="chess-draw-offer">
                  <p>{t(($) => $.chess.draw.offered)}</p>
                  <div>
                    <button
                      className="button"
                      disabled={pending}
                      onClick={() => void send('chess.act', undefined, { option: 'draw-accept' })}
                    >
                      {t(($) => $.chess.draw.accept)}
                    </button>
                    <button
                      className="button secondary"
                      disabled={pending}
                      onClick={() => void send('chess.act', undefined, { option: 'draw-decline' })}
                    >
                      {t(($) => $.chess.draw.decline)}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="chess-text-action"
                  disabled={pending || table.drawOffer === color}
                  onClick={() => void send('chess.act', undefined, { option: 'draw-offer' })}
                >
                  <Handshake size={16} />
                  {table.drawOffer === color ? t(($) => $.chess.draw.pending) : t(($) => $.chess.draw.offer)}
                </button>
              )}
              {table.claimableDraws.length > 0 && (
                <button
                  type="button"
                  className="button secondary"
                  disabled={pending}
                  onClick={() => void send('chess.act', undefined, { option: 'draw-claim' })}
                >
                  {table.claimableDraws.includes('threefold')
                    ? t(($) => $.chess.draw.claimRepetition)
                    : t(($) => $.chess.draw.claimFiftyMoves)}
                </button>
              )}
              <button
                type="button"
                className="chess-text-action"
                disabled={pending}
                onClick={() => setConfirmation('resign')}
              >
                <Flag size={16} />
                {t(($) => $.chess.resign)}
              </button>
            </div>
          )}
          {color && table.phase !== 'playing' && (
            <button className="chess-text-action" disabled={pending} onClick={() => void send('chess.stand')}>
              {t(($) => $.chess.stand)}
            </button>
          )}
          {error && (
            <p role="alert" className="chess-error">
              {error}
            </p>
          )}
          {spectators.length > 0 && (
            <div className="chess-spectators">
              <h4>
                {t(($) => $.chess.spectators)} <span>{spectators.length}</span>
              </h4>
              <GamePeople meeting={meeting} memberIds={spectators} game="chess" />
            </div>
          )}
          <details className="chess-help">
            <summary>{t(($) => $.chess.help.title)}</summary>
            <p>{t(($) => $.chess.help.controls)}</p>
            <p>{t(($) => $.chess.help.rules)}</p>
            <p>{t(($) => $.chess.help.clock)}</p>
          </details>
        </aside>
      </div>
      {drag?.moved && (
        <img
          className="chess-drag-piece"
          src={pieceImage(drag.piece)}
          alt=""
          aria-hidden="true"
          style={{ left: drag.x, top: drag.y, width: drag.size, height: drag.size }}
        />
      )}
      <Modal
        open={!!promotion}
        onOpenChange={(open) => {
          if (!open) setPromotion(null);
        }}
        title={t(($) => $.chess.promotion.title)}
        description={t(($) => $.chess.promotion.description)}
      >
        <div className="chess-promotion">
          {PROMOTIONS.map((choice) => {
            const uci = promotion?.find((move) => move.endsWith(choice));
            const piece = (color === 'white' ? choice.toUpperCase() : choice) as ChessPiece;
            return (
              <button
                type="button"
                key={choice}
                aria-label={t(($) => $.chess.promotion.pieces[choice].action)}
                disabled={!uci || pending}
                onClick={() => uci && playMove(uci)}
              >
                <img src={pieceImage(piece)} alt="" />
                <span>{t(($) => $.chess.promotion.pieces[choice].label)}</span>
              </button>
            );
          })}
        </div>
      </Modal>
      <Modal
        open={!!claimMove}
        onOpenChange={(open) => {
          if (!open) setClaimMove(null);
        }}
        title={t(($) => $.chess.claim.title)}
        description={t(($) => $.chess.claim.description)}
      >
        <div className="chess-confirm-actions">
          <button
            className="button secondary"
            disabled={pending}
            onClick={() => {
              if (claimMove) void send('chess.move', claimMove);
              setClaimMove(null);
            }}
          >
            {t(($) => $.chess.claim.continue)}
          </button>
          <button
            className="button primary"
            disabled={pending}
            onClick={() => {
              if (claimMove) void send('chess.act', claimMove, { option: 'draw-claim' });
              setClaimMove(null);
            }}
          >
            {t(($) => $.chess.claim.claim)}
          </button>
        </div>
      </Modal>
      <Modal
        open={!!confirmation}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
        title={
          confirmation === 'resign'
            ? t(($) => $.chess.confirm.resignTitle)
            : t(($) => $.chess.confirm.closeTitle)
        }
        description={
          confirmation === 'resign'
            ? t(($) => $.chess.confirm.resignDescription)
            : t(($) => $.chess.confirm.closeDescription)
        }
      >
        <div className="chess-confirm-actions">
          <button className="button secondary" onClick={() => setConfirmation(null)}>
            {t(($) => $.chess.confirm.cancel)}
          </button>
          <button
            className="button danger"
            disabled={pending}
            onClick={() => {
              const action = confirmation;
              setConfirmation(null);
              void send(
                action === 'resign' ? 'chess.act' : 'chess.close',
                undefined,
                action === 'resign' ? { option: 'resign' } : undefined,
              );
            }}
          >
            {confirmation === 'resign' ? t(($) => $.chess.confirm.resign) : t(($) => $.chess.confirm.close)}
          </button>
        </div>
      </Modal>
    </section>
  );
}

function ChessClock({
  meeting,
  remaining,
  anchor,
  running,
  untimed,
  label,
}: {
  meeting: Meeting;
  remaining: number;
  anchor: number;
  running: boolean;
  untimed: boolean;
  label: string;
}) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => meeting.serverNow());
  useEffect(() => {
    setNow(meeting.serverNow());
    if (!running || untimed) return;
    const timer = setInterval(() => setNow(meeting.serverNow()), 100);
    return () => clearInterval(timer);
  }, [meeting, anchor, running, untimed]);
  const left = clockRemaining(remaining, anchor, now, running);
  return (
    <div
      className="chess-clock"
      role="timer"
      aria-label={t(($) => $.chess.clock, {
        side: label,
        time: untimed ? t(($) => $.chess.untimed) : clockLabel(left),
      })}
      data-running={running || undefined}
      data-urgent={(!untimed && running && left < 30_000) || undefined}
    >
      {untimed ? <span aria-hidden="true">∞</span> : clockLabel(left)}
    </div>
  );
}

/** Recovery establishes a new cursor. Only one fresh consecutive move may animate. */
function useChessMotion(
  meeting: Meeting,
  table: ChessState,
  reviewing: boolean,
  flipped: boolean,
): PieceTravel[] {
  const connection = useStore(meeting.control.state);
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const previous = useRef({
    id: table.id,
    ply: table.ply,
    fen: table.fen,
    moves: table.moves,
    connection,
    flipped,
  });
  const recovering = useRef(false);
  const [motion, setMotion] = useState<PieceTravel[]>([]);
  useLayoutEffect(() => {
    const before = previous.current;
    if (connection !== 'connected' || before.connection !== 'connected') recovering.current = true;
    const baseline =
      recovering.current || before.id !== table.id || before.flipped !== flipped || reduced || reviewing;
    if (baseline) setMotion([]);
    const last = table.moves.at(-1);
    if (!baseline && table.ply === before.ply + 1 && last && meeting.serverNow() - last.at < 1800) {
      setMotion(moveTravels(before.fen, table.fen, last.uci));
    } else if (table.ply !== before.ply) setMotion([]);
    if (connection === 'connected' && recovering.current && before.moves !== table.moves)
      recovering.current = false;
    previous.current = {
      id: table.id,
      ply: table.ply,
      fen: table.fen,
      moves: table.moves,
      connection,
      flipped,
    };
  }, [meeting, table.id, table.ply, table.fen, table.moves, connection, reduced, reviewing, flipped]);
  useEffect(() => {
    if (!motion.length) return;
    const timer = setTimeout(() => setMotion([]), 280);
    return () => clearTimeout(timer);
  }, [motion]);
  return motion;
}
