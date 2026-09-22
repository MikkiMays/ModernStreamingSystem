import '../game-polish.css';
import { Dialog } from '@base-ui/react/dialog';
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { TrackEvent } from 'livekit-client';
import {
  ArrowRightLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Hand,
  ListOrdered,
  LogOut,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  Settings2,
  Shield,
  X,
} from 'lucide-react';
import type { Meeting } from '../core/meeting';
import type { DurakSeat, DurakTable as Table } from '../api/types';
import type { MediaTile } from '../media/session';
import { occupiedSeatLayout } from '../core/game-layout';
import { useFullscreen } from '../core/fullscreen';
import { signal } from '../core/sounds';
import {
  commandFor,
  dropFrom,
  faceOf,
  fanAngle,
  modeName,
  plural,
  tableSays,
  trumpName,
  type Drop,
} from '../core/durak';
import { useTableRatio } from './GamePresentation';
import { useDurakMotion } from './DurakMotion';
import { DurakReactions } from './DurakReactions';
import { Avatar, IconButton, useStore } from './primitives';

type SheetKind = 'settings' | 'result' | 'score' | null;
type Command = (type: Parameters<Meeting['command']>[0], extra?: Parameters<Meeting['command']>[3]) => void;
type Drag = {
  card: string;
  pointer: number;
  x: number;
  y: number;
  fromX: number;
  fromY: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  angle: number;
  moved: boolean;
  wasPicked: boolean;
};

/** The server supplies legal destinations; local state owns only selection, dragging and pending feedback. */
export default function DurakTable({ meeting, table }: { meeting: Meeting; table: Table }) {
  const tracks = useStore(meeting.media.tracks);
  const snapshot = useStore(meeting.snapshot);
  const connection = useStore(meeting.control.state);
  const connected = connection === 'connected';
  const you = table.you;
  const mySeat = you?.seat ?? null;
  const host =
    table.hostId === meeting.admission.participantId ||
    !!snapshot.participants.find((p) => p.id === meeting.admission.participantId)?.owner;
  const paused = !!table.paused;
  const pauseSupported = table.paused !== undefined;
  const scene = useRef<HTMLDivElement>(null);
  const handScroller = useRef<HTMLDivElement>(null);
  const tableGeometry = useTableRatio();
  const spots = occupiedSeatLayout(
    table.seats.filter((seat) => seat.memberId).map((seat) => seat.index),
    mySeat,
    tableGeometry.ratio,
  );
  const { full, targetFull, toggle: toggleFull } = useFullscreen(scene);
  const motion = useDurakMotion({ meeting, table, scene, paused });
  const [sheet, setSheet] = useState<SheetKind>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [refusal, setRefusal] = useState('');
  const [drag, setDrag] = useState<Drag | null>(null);
  const [pendingDrag, setPendingDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const dragLayer = useRef<HTMLDivElement>(null);
  const dragFrame = useRef(0);
  const refusalTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refuse = useCallback((message: string) => {
    setRefusal(message);
    if (refusalTimer.current) clearTimeout(refusalTimer.current);
    refusalTimer.current = setTimeout(() => setRefusal(''), 5000);
  }, []);
  useEffect(
    () => () => {
      if (refusalTimer.current) clearTimeout(refusalTimer.current);
      cancelAnimationFrame(dragFrame.current);
    },
    [],
  );
  const cancelDrag = useCallback(() => {
    cancelAnimationFrame(dragFrame.current);
    dragFrame.current = 0;
    dragRef.current = null;
    setDrag(null);
  }, []);
  const clearSelection = useCallback(() => {
    cancelDrag();
    setPicked(null);
  }, [cancelDrag]);
  const canPlay = table.phase === 'bout' && !table.boutEnd && !!you && !paused && connected && !pending;
  useEffect(() => {
    if (!canPlay) clearSelection();
    else if (picked && !you?.cards.includes(picked)) setPicked(null);
    if (dragRef.current && !you?.cards.includes(dragRef.current.card)) cancelDrag();
  }, [canPlay, picked, you?.cards, clearSelection, cancelDrag]);
  useEffect(() => {
    if (paused || !connected || (pendingDrag && !you?.cards.includes(pendingDrag.card))) setPendingDrag(null);
  }, [paused, connected, you?.cards, pendingDrag]);
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !sheet) clearSelection();
    };
    const hidden = () => {
      if (document.hidden) clearSelection();
    };
    window.addEventListener('keydown', cancel);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('keydown', cancel);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [clearSelection, sheet]);

  const send: Command = (type, extra) => {
    if (!connected || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setRefusal('');
    void meeting
      .command(type, undefined, undefined, extra)
      .catch((error: Error) => refuse(error.message))
      .finally(() => {
        pendingRef.current = false;
        setPending(false);
      });
  };
  const announced = useRef(0);
  useEffect(() => {
    if (!you?.turn || paused || !connected || announced.current === table.actionAt) return;
    announced.current = table.actionAt;
    signal('turn');
  }, [you?.turn, paused, connected, table.actionAt]);
  const shown = useRef(0);
  useEffect(() => {
    if (!table.result || shown.current === table.result.at) return;
    shown.current = table.result.at;
    setSheet('result');
  }, [table.result]);

  // Missing plays is a compatible old-server snapshot: offer capabilities without claiming card legality.
  const legal = (card: string, target: Drop) => {
    const shape = commandFor(target, mySeat === table.defender);
    if (!shape || !canPlay) return false;
    if (you?.plays)
      return you.plays.some(
        (play) =>
          play.card === card && play.option === shape.option && (play.under ?? undefined) === shape.under,
      );
    return true;
  };
  const selected = drag?.card ?? picked;
  const selectedBeats = table.table.filter(
    (pair) => !pair.beat && selected && legal(selected, { kind: 'beat', under: pair.attack }),
  );
  const tableTarget = !!selected && legal(selected, { kind: 'table' });
  const defending = mySeat === table.defender && !table.taking;
  const focusChoice = !!selected && canPlay;
  const play = (
    card: string,
    target: Drop,
    source?: HTMLElement | { left: number; top: number; width: number; height: number; angle: number },
  ) => {
    if (!canPlay || pendingRef.current) return;
    const shape = commandFor(target, mySeat === table.defender);
    if (!shape) return;
    if (!legal(card, target)) {
      setPendingDrag(null);
      refuse('Этой картой так сходить нельзя. Выберите другую карту или цель.');
      return;
    }
    if (source) motion.capture(card, source);
    clearSelection();
    setRefusal('');
    pendingRef.current = true;
    setPending(true);
    void meeting
      .command('durak.act', undefined, undefined, { option: shape.option, card, under: shape.under })
      .catch((error: Error) => {
        setPendingDrag(null);
        motion.reject(card);
        refuse(error.message);
      })
      .finally(() => {
        pendingRef.current = false;
        setPending(false);
      });
  };
  const place = (target: Drop) => {
    if (!picked) return;
    const source = scene.current?.querySelector<HTMLElement>(
      `[data-durak-hand-card="${picked}"] .durak-card`,
    );
    play(picked, target, source ?? undefined);
  };
  const lift = (card: string, event: React.PointerEvent<HTMLElement>) => {
    if (!canPlay || event.button !== 0) return;
    event.preventDefault();
    const visual = event.currentTarget.querySelector<HTMLElement>('.durak-card')!;
    const box = visual.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const next = {
      card,
      pointer: event.pointerId,
      x,
      y,
      fromX: event.clientX,
      fromY: event.clientY,
      offsetX: event.clientX - x,
      offsetY: event.clientY - y,
      width: visual.offsetWidth || box.width,
      height: visual.offsetHeight || box.height,
      angle: 0,
      moved: false,
      wasPicked: picked === card,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = next;
    setDrag(next);
    setPicked(null);
    setRefusal('');
  };
  const move = (event: React.PointerEvent<HTMLElement>) => {
    const current = dragRef.current;
    if (!current || current.pointer !== event.pointerId) return;
    current.x = event.clientX - current.offsetX;
    current.y = event.clientY - current.offsetY;
    current.angle = Math.max(-12, Math.min(12, (event.clientX - current.fromX) / 18));
    current.moved ||= Math.hypot(event.clientX - current.fromX, event.clientY - current.fromY) > 6;
    if (dragFrame.current) return;
    dragFrame.current = requestAnimationFrame(() => {
      dragFrame.current = 0;
      const latest = dragRef.current;
      if (latest && dragLayer.current) dragLayer.current.style.transform = dragTransform(latest);
    });
  };
  const drop = (event: React.PointerEvent<HTMLElement>) => {
    const current = dragRef.current;
    if (!current || current.pointer !== event.pointerId) return;
    cancelDrag();
    if (!current.moved) {
      setPicked(current.wasPicked ? null : current.card);
      return;
    }
    const target = dropFrom(document.elementFromPoint(event.clientX, event.clientY));
    if (!target) return;
    setPendingDrag(current);
    play(current.card, target, {
      left: current.x - current.width / 2,
      top: current.y - current.height / 2,
      width: current.width,
      height: current.height,
      angle: current.angle,
    });
  };
  const hand = you?.cards ?? [];
  const [handOverflow, setHandOverflow] = useState(false);
  useEffect(() => {
    const element = handScroller.current;
    if (!element) return;
    const measure = () => setHandOverflow(element.scrollWidth > element.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [hand.length]);
  const says = !connected
    ? 'Восстанавливаем соединение…'
    : paused
      ? 'Игра на паузе'
      : tableSays(table, mySeat);
  const guidance = !selected
    ? ''
    : selectedBeats.length && tableTarget && defending
      ? 'Отбейте выделенную карту или переведите ход'
      : selectedBeats.length
        ? 'Выберите карту на столе, чтобы отбить'
        : tableTarget
          ? defending
            ? 'Переведите ход следующему игроку'
            : 'Положите выбранную карту на стол'
          : 'Для этой карты нет хода — выберите другую';
  const seated = table.seats.filter((seat) => seat.memberId).length;
  const frozenSeconds = Math.max(0, Math.ceil((table.pausedRemaining ?? 0) / 1000));

  return (
    <div
      className="durak durak-refined"
      ref={scene}
      data-phase={table.phase}
      data-paused={paused || undefined}
      data-full={targetFull || undefined}
    >
      <header className="durak-bar">
        <div className="durak-mode">
          <b>Дурак</b>
          <small>
            {modeName(table.mode)} · {table.deckSize} карт{table.trumpSuit ? ` · ${trumpName(table)}` : ''}
          </small>
        </div>
        <span className="durak-bar-spacer" />
        {table.score.length > 0 && (
          <IconButton label="Счёт игры" onClick={() => setSheet('score')}>
            <ListOrdered size={18} />
          </IconButton>
        )}
        {host && table.phase !== 'bout' && (
          <button
            className="button primary small"
            disabled={!connected || pending || seated < 2}
            onClick={() => send('durak.deal')}
          >
            <Play size={16} /> Раздать
          </button>
        )}
        {host && pauseSupported && table.phase === 'bout' && (
          <IconButton
            label={paused ? 'Продолжить игру' : 'Поставить игру на паузу'}
            disabled={!connected || pending}
            onClick={() => send('durak.settings', { option: paused ? 'resume' : 'pause' })}
          >
            {paused ? <Play size={18} /> : <Pause size={18} />}
          </IconButton>
        )}
        <IconButton
          label="Настройки игры"
          onClick={() => {
            clearSelection();
            setSheet('settings');
          }}
        >
          <Settings2 size={18} />
        </IconButton>
        <IconButton label={full ? 'Свернуть стол' : 'Развернуть стол'} onClick={toggleFull}>
          {full ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
        </IconButton>
      </header>
      <TurnStatus
        meeting={meeting}
        table={table}
        label={refusal || says}
        error={!!refusal}
        connected={connected}
      />
      <div className="durak-table">
        <div className="durak-arena" ref={tableGeometry.ref}>
          <div
            className="durak-felt"
            data-drop={tableTarget ? 'table' : undefined}
            data-choice={focusChoice || undefined}
          >
            <div className="durak-focus-shade" aria-hidden="true" />
            <div className="durak-mat" data-focus={focusChoice || undefined}>
              {table.phase === 'bout' && (
                <div className="durak-bout" data-end={table.boutEnd ?? undefined}>
                  {table.table.map((pair) => {
                    const target = !!selected && selectedBeats.some((match) => match.attack === pair.attack);
                    return (
                      <div
                        className="durak-pair"
                        key={pair.attack}
                        data-drop={!pair.beat ? 'pair' : undefined}
                        data-under={pair.attack}
                        data-target={target || undefined}
                      >
                        <button
                          className="durak-attack"
                          disabled={!target}
                          onClick={() => place({ kind: 'beat', under: pair.attack })}
                          aria-label={`${target ? 'Отбить' : 'На столе:'} ${faceOf(pair.attack).label}`}
                        >
                          <Card card={pair.attack} board />
                          {target && (
                            <span className="durak-target-label">
                              <Shield size={12} /> Отбить
                            </span>
                          )}
                        </button>
                        {pair.beat && (
                          <span className="durak-defence">
                            <Card card={pair.beat} board />
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {tableTarget && (
                <button className="durak-place" data-drop="table" onClick={() => place({ kind: 'table' })}>
                  {defending ? <ArrowRightLeft size={16} /> : <Hand size={16} />}
                  {defending ? 'Перевести' : table.table.length ? 'Подкинуть' : 'Положить на стол'}
                </button>
              )}
              {table.phase !== 'bout' && (
                <div className="durak-center">
                  <span className="durak-center-suit" aria-hidden="true">
                    ♠
                  </span>
                  <h3>
                    {table.phase === 'over'
                      ? 'Партия завершена'
                      : seated < 2
                        ? 'Соберёмся за столом'
                        : 'Можно начинать'}
                  </h3>
                  <p>
                    {table.phase === 'over'
                      ? 'Готовы сыграть ещё?'
                      : seated < 2
                        ? 'Для игры нужны хотя бы двое'
                        : host
                          ? 'Раздайте карты, когда все будут готовы'
                          : 'Организатор скоро раздаст карты'}
                  </p>
                </div>
              )}
            </div>
            {spots.map((spot) => {
              const seat = table.seats.find((item) => item.index === spot.index)!;
              return (
                <Seat
                  key={seat.index}
                  seat={seat}
                  spot={spot}
                  table={table}
                  mine={seat.index === mySeat}
                  meeting={meeting}
                  tile={tracks.find(
                    (track) => track.participantId === seat.memberId && track.source === 'camera',
                  )}
                  avatar={snapshot.participants.find((person) => person.id === seat.memberId)?.avatar ?? null}
                />
              );
            })}
            {paused && (
              <div className="durak-pause">
                <Pause size={24} />
                <b>Игра на паузе</b>
                <span>Время остановлено{frozenSeconds ? ` · осталось ${frozenSeconds} с` : ''}</span>
                {host ? (
                  <button
                    className="button primary"
                    disabled={!connected || pending}
                    onClick={() => send('durak.settings', { option: 'resume' })}
                  >
                    <Play size={16} /> Продолжить
                  </button>
                ) : (
                  <small>Организатор продолжит игру, когда все вернутся</small>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="durak-hand-band">
          <div className="durak-hand-caption">
            {picked ? (
              <button aria-label="Отменить выбор" onClick={clearSelection}>
                <X size={14} /> Отменить
              </button>
            ) : (
              <span>
                {hand.length ? 'Ваша рука' : mySeat === null ? 'Вы наблюдаете за игрой' : 'Ждём раздачи'}
              </span>
            )}
            <Stock table={table} />
          </div>
          {focusChoice && (
            <p className="durak-guidance" role="status">
              {guidance}
            </p>
          )}
          {handOverflow && (
            <button
              className="durak-hand-scroll is-left"
              aria-label="Карты левее"
              onClick={() => handScroller.current?.scrollBy({ left: -220 })}
            >
              <ChevronLeft size={20} />
            </button>
          )}
          <div
            ref={handScroller}
            className="durak-hand"
            aria-label="Ваши карты"
            data-large={hand.length > 10 || undefined}
          >
            {hand.map((card, index) => {
              const { angle, lift: raise } = fanAngle(index, hand.length);
              return (
                <button
                  key={card}
                  className="durak-hand-card"
                  data-durak-hand-card={card}
                  data-held={drag?.card === card || pendingDrag?.card === card || undefined}
                  data-picked={picked === card || undefined}
                  disabled={!canPlay}
                  onClick={(event) => {
                    if (event.detail === 0) {
                      setRefusal('');
                      setPicked(picked === card ? null : card);
                    }
                  }}
                  onPointerDown={(event) => lift(card, event)}
                  onPointerMove={move}
                  onPointerUp={drop}
                  onPointerCancel={cancelDrag}
                  onLostPointerCapture={() => {
                    if (dragRef.current) cancelDrag();
                  }}
                  aria-label={faceOf(card).label}
                  aria-pressed={picked === card}
                  aria-describedby={picked === card ? 'durak-selection-instruction' : undefined}
                  style={{ '--angle': `${angle}deg`, '--lift': raise } as CSSProperties}
                >
                  <Card card={card} />
                </button>
              );
            })}
          </div>
          {handOverflow && (
            <button
              className="durak-hand-scroll is-right"
              aria-label="Карты правее"
              onClick={() => handScroller.current?.scrollBy({ left: 220 })}
            >
              <ChevronRight size={20} />
            </button>
          )}
          {picked && (
            <span id="durak-selection-instruction" className="sr-only">
              {guidance}. Escape — отменить выбор.
            </span>
          )}
        </div>
      </div>
      <footer className="durak-controls">
        {mySeat === null && table.seats.some((seat) => !seat.memberId) ? (
          <button
            className="button primary"
            disabled={!table.seatingOpen || !connected || pending}
            onClick={() => send('durak.sit')}
          >
            Сесть за стол
          </button>
        ) : (
          <span className="durak-controls-hint">
            {pending
              ? 'Сохраняем ход…'
              : paused
                ? 'Карты останутся на своих местах'
                : picked
                  ? 'Выберите выделенную цель на столе'
                  : you?.turn
                    ? 'Выберите карту или перетащите её на стол'
                    : 'Следите за ходом игры'}
          </span>
        )}
        <div className="durak-actions">
          {you?.actions.includes('take') && (
            <button
              className="durak-act"
              disabled={!canPlay}
              onClick={() => send('durak.act', { option: 'take' })}
            >
              <Hand size={17} /> Беру
            </button>
          )}
          {you?.actions.includes('pass') && (
            <button
              className="durak-act"
              data-kind="pass"
              disabled={!canPlay}
              onClick={() => send('durak.act', { option: 'pass' })}
            >
              <Check size={17} /> Бито
            </button>
          )}
        </div>
      </footer>
      {(drag || (pendingDrag && hand.includes(pendingDrag.card) && connected && !paused)) && (
        <div
          ref={dragLayer}
          className="durak-drag-card"
          style={{
            width: (drag ?? pendingDrag!).width,
            height: (drag ?? pendingDrag!).height,
            transform: dragTransform(drag ?? pendingDrag!),
          }}
          aria-hidden="true"
        >
          <Card card={(drag ?? pendingDrag!).card} />
        </div>
      )}
      <Dialog.Root
        open={sheet !== null}
        onOpenChange={(open) => {
          if (!open) setSheet(null);
        }}
      >
        <Dialog.Portal container={scene} className="durak-dialog-layer">
          <Dialog.Backdrop className="durak-sheet-backdrop" />
          <Dialog.Popup className="durak-sheet">
            <header className="durak-sheet-head">
              <div>
                <Dialog.Title>
                  {sheet === 'settings' ? 'Настройки игры' : sheet === 'score' ? 'Счёт игры' : 'Итог партии'}
                </Dialog.Title>
                <Dialog.Description>
                  {sheet === 'settings'
                    ? host
                      ? 'Изменения применяются для всего стола'
                      : 'Правила этого стола'
                    : 'Результаты за этой встречей'}
                </Dialog.Description>
              </div>
              <Dialog.Close
                render={
                  <IconButton label="Закрыть">
                    <X size={18} />
                  </IconButton>
                }
              >
                <X size={18} />
              </Dialog.Close>
            </header>
            <div className="durak-sheet-body">
              {sheet === 'settings' && (
                <Settings
                  table={table}
                  host={host}
                  seated={mySeat !== null}
                  disabled={!connected || pending}
                  onSend={send}
                />
              )}
              {sheet === 'score' && <Score table={table} />}
              {sheet === 'result' && table.result && <Result table={table} />}
              {refusal && (
                <p className="durak-sheet-error" role="alert">
                  {refusal}
                </p>
              )}
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

function dragTransform(drag: Drag) {
  return `translate3d(${drag.x - drag.width / 2}px, ${drag.y - drag.height / 2}px, 0) rotate(${drag.angle}deg)`;
}

function TurnStatus({
  meeting,
  table,
  label,
  error,
  connected,
}: {
  meeting: Meeting;
  table: Table;
  label: string;
  error: boolean;
  connected: boolean;
}) {
  const [now, setNow] = useState(() => meeting.serverNow());
  const running = connected && !table.paused && table.phase === 'bout' && table.deadline > 0;
  useEffect(() => {
    setNow(meeting.serverNow());
    if (!running) return;
    const timer = setInterval(() => setNow(meeting.serverNow()), 250);
    return () => clearInterval(timer);
  }, [meeting, running, table.deadline]);
  const seconds = Math.max(
    0,
    Math.ceil((table.paused ? (table.pausedRemaining ?? 0) : table.deadline - now) / 1000),
  );
  return (
    <div
      className="durak-turn"
      data-active={(table.you?.turn && !table.paused) || undefined}
      data-error={error || undefined}
    >
      <strong role={error ? 'alert' : 'status'}>{label}</strong>
      {(table.paused || running) && (
        <span aria-label={`${table.paused ? 'На паузе, осталось' : 'Осталось'} ${seconds} секунд`}>
          {table.paused && <Pause size={14} />}
          {seconds} с
        </span>
      )}
    </div>
  );
}

function Stock({ table }: { table: Table }) {
  if (!table.trump) return null;
  const backs = Math.min(3, Math.max(0, table.deckLeft - 1));
  return (
    <div className="durak-stock" data-empty={table.deckLeft === 0 || undefined}>
      <div className="durak-stock-cards">
        <span className="durak-trump" aria-label={`Козырь: ${faceOf(table.trump).label}`}>
          <Card card={table.trump} />
        </span>
        {Array.from({ length: backs }, (_, index) => (
          <span className="durak-back" key={index}>
            <Card />
          </span>
        ))}
      </div>
      <div className="durak-stock-count">
        {table.deckLeft}
        <small>{table.deckLeft === 0 ? 'козыри' : 'в колоде'}</small>
      </div>
    </div>
  );
}

/**
 * Карта.
 *
 * Номинал стоит в двух углах и перевёрнут во втором — так напечатаны настоящие карты, и по этому
 * их узнают, держа веер: видно всегда только левый верхний угол соседней. Без аргумента рисуется
 * рубашка: так переворот остаётся одним элементом.
 */
function Card({ card, board = false }: { card?: string; board?: boolean }) {
  const face = card ? faceOf(card) : null;
  return (
    <span
      className="durak-card"
      data-durak-board-card={board ? card : undefined}
      data-red={face?.red || undefined}
      data-back={!face || undefined}
    >
      {face && (
        <>
          <b className="durak-card-rank">
            {face.rank}
            <i>{face.glyph}</i>
          </b>
          <u className="durak-card-pip">{face.glyph}</u>
          <b className="durak-card-rank durak-card-foot">
            {face.rank}
            <i>{face.glyph}</i>
          </b>
        </>
      )}
    </span>
  );
}

function SeatCamera({ tile }: { tile: MediaTile }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    tile.track.attach(element);
    element.muted = true;
    const mirror = () => {
      const facing = tile.track.mediaStreamTrack?.getSettings().facingMode;
      element.style.transform = tile.local && facing !== 'environment' ? 'scaleX(-1)' : 'none';
    };
    mirror();
    tile.track.on(TrackEvent.Restarted, mirror);
    return () => {
      tile.track.off(TrackEvent.Restarted, mirror);
      tile.track.detach(element);
    };
  }, [tile.track, tile.local]);
  return <video ref={ref} autoPlay playsInline muted aria-label={`Камера: ${tile.name}`} />;
}

function Seat({
  seat,
  spot,
  table,
  mine,
  tile,
  avatar,
  meeting,
}: {
  seat: DurakSeat;
  spot: { x: number; y: number; side: string };
  table: Table;
  mine: boolean;
  tile?: MediaTile;
  avatar: string | null;
  meeting: Meeting;
}) {
  const acting = table.acting.includes(seat.index);
  const role = seat.fool
    ? 'Дурак'
    : seat.out
      ? `Вышел ${seat.place}-м`
      : seat.defender
        ? table.taking
          ? 'Берёт'
          : 'Отбивается'
        : seat.passed
          ? 'Бито'
          : seat.attacker
            ? 'Ходит'
            : seat.away
              ? 'Отошёл'
              : '';
  return (
    <div
      className="durak-seat"
      data-game-seat={seat.index}
      data-side={spot.side}
      data-away={seat.away || undefined}
      data-out={seat.out || undefined}
      data-mine={mine || undefined}
      data-acting={acting || undefined}
      style={{ left: `${spot.x}%`, top: `${spot.y}%` }}
    >
      <DurakReactions meeting={meeting} table={table} seat={seat.index} mine={mine}>
        <span className="durak-seat-face">
          {tile ? <SeatCamera tile={tile} /> : <Avatar name={seat.name} src={avatar} />}
        </span>
      </DurakReactions>
      <span className="durak-seat-name" title={seat.name}>
        {mine ? `${seat.name} · вы` : seat.name}
      </span>
      <span className="durak-seat-role">{role}</span>
    </div>
  );
}

function Settings({
  table,
  host,
  seated,
  disabled,
  onSend,
}: {
  table: Table;
  host: boolean;
  seated: boolean;
  disabled: boolean;
  onSend: Command;
}) {
  const set = (option: string, chips?: number) => onSend('durak.settings', { option, chips });
  const live = table.phase === 'bout';
  return (
    <>
      {host && table.paused !== undefined && live && (
        <button
          className="durak-settings-action"
          disabled={disabled}
          onClick={() => set(table.paused ? 'resume' : 'pause')}
        >
          {table.paused ? <Play size={18} /> : <Pause size={18} />}
          <span>
            <b>{table.paused ? 'Продолжить игру' : 'Поставить на паузу'}</b>
            <small>Часы остановятся, карты останутся на столе</small>
          </span>
        </button>
      )}
      <div className="durak-settings-group">
        <h3>Правила стола</h3>
        <SettingChoice
          label="Колода"
          hint={live ? 'Меняется между партиями' : 'Без джокеров'}
          values={[36, 52].map((value) => ({ value, label: `${value} карт` }))}
          value={table.deckSize}
          disabled={!host || disabled || live}
          onChange={(value) => set('deck', value)}
        />
        <SettingChoice
          label="Режим игры"
          hint="Первый бой не переводят"
          values={[
            { value: 0, label: 'Подкидной' },
            { value: 1, label: 'Переводной' },
          ]}
          value={table.mode === 'perevodnoy' ? 1 : 0}
          disabled={!host || disabled || live}
          onChange={(value) => set('rules', value)}
        />
        <SettingChoice
          label="Подкидывают"
          values={[
            { value: 0, label: 'Все' },
            { value: 1, label: 'Соседи' },
          ]}
          value={table.neighbours ? 1 : 0}
          disabled={!host || disabled}
          onChange={() => set('neighbours')}
        />
        <SettingChoice
          label="Первый бой"
          values={[
            { value: 0, label: '6 карт' },
            { value: 1, label: '5 карт' },
          ]}
          value={table.firstFive ? 1 : 0}
          disabled={!host || disabled}
          onChange={() => set('first-five')}
        />
        <SettingChoice
          label="Время на ход"
          hint={table.paused ? 'Продолжите игру, чтобы изменить время' : undefined}
          values={[...new Set([20, 40, 60, table.turnSeconds])]
            .sort((a, b) => a - b)
            .map((value) => ({ value, label: `${value} с` }))}
          value={table.turnSeconds}
          disabled={!host || disabled || !!table.paused}
          onChange={(value) => set('turn', value)}
        />
      </div>
      {host && (
        <button
          className="durak-toggle"
          role="switch"
          aria-checked={table.seatingOpen}
          disabled={disabled}
          onClick={() => set('seating')}
        >
          <span>
            <b>Пускать новых за стол</b>
            <small>{table.seatingOpen ? 'Свободные места открыты' : 'Играют только те, кто уже сел'}</small>
          </span>
          <i aria-hidden="true" />
        </button>
      )}
      {!host && (
        <p className="durak-settings-note">
          Менять правила и ставить игру на паузу может организатор стола или ведущий встречи.
        </p>
      )}
      {seated && (
        <button
          className="durak-settings-action"
          disabled={disabled || (live && table.paused)}
          onClick={() => onSend('durak.stand')}
        >
          <LogOut size={18} />
          <span>
            <b>Встать из-за стола</b>
            <small>{live ? 'Вы выйдете из текущей партии' : 'Останетесь зрителем во встрече'}</small>
          </span>
        </button>
      )}
      {host && (
        <button
          className="durak-settings-action is-danger"
          disabled={disabled}
          onClick={() => onSend('durak.close')}
        >
          <X size={18} />
          <span>
            <b>Убрать стол из встречи</b>
            <small>Игра закончится, итоги останутся в истории</small>
          </span>
        </button>
      )}
    </>
  );
}

function SettingChoice({
  label,
  hint,
  value,
  values,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  values: { value: number; label: string }[];
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <div className="durak-settings-choice">
      <span>
        <b>{label}</b>
        {hint && <small>{hint}</small>}
      </span>
      <div className="durak-choice" role="group" aria-label={label}>
        {values.map((option) => (
          <button
            key={option.value}
            aria-pressed={option.value === value}
            disabled={disabled}
            onClick={() => {
              if (option.value !== value) onChange(option.value);
            }}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Score({ table }: { table: Table }) {
  return (
    <table className="durak-score-table">
      <thead>
        <tr>
          <th>Игрок</th>
          <th>Партий</th>
          <th>Дурак</th>
          <th>Серия</th>
        </tr>
      </thead>
      <tbody>
        {table.score.map((row) => (
          <tr key={row.name}>
            <td>{row.name}</td>
            <td>{row.games}</td>
            <td>{row.fools}</td>
            <td>{row.streak}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Result({ table }: { table: Table }) {
  const result = table.result!;
  return (
    <div className="durak-over">
      <div className="durak-over-symbol" aria-hidden="true">
        {result.draw ? '♣' : '♠'}
      </div>
      <h3>{result.draw ? 'Ничья' : `${result.foolName} — дурак`}</h3>
      <p>
        {plural(result.bouts, 'бой', 'боя', 'боёв')} ·{' '}
        {result.draw ? 'Все остались без карт' : 'Остальные игроки вышли из партии'}
      </p>
      {result.places.length > 0 && (
        <ol className="durak-places">
          {result.places.map((name, index) => (
            <li key={`${name}-${index}`}>
              <span>{index + 1}</span>
              <b>{name}</b>
              <Check size={16} />
            </li>
          ))}
        </ol>
      )}
      <Dialog.Close render={<button className="button primary full" />}>К столу</Dialog.Close>
    </div>
  );
}
