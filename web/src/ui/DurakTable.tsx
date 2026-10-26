import '../game-polish.css';
import { Dialog } from '@base-ui/react/dialog';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { useTranslation } from 'react-i18next';
import { TrackEvent } from 'livekit-client';
import {
  Armchair,
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
  DEAL_MS,
  commandFor,
  dropFrom,
  faceOf,
  fanAngle,
  modeName,
  tableSays,
  trumpName,
  type Drop,
} from '../core/durak';
import { CardMotion, useTableRatio } from './GamePresentation';
import { CordMark } from './brand/Logo';
import { FaceZoomButton, useFaceZoom } from './FaceZoom';
import { useCardSounds, useResultSound, useTurnTicks } from './useGameSounds';
import { allowed } from '../core/permissions';
import { useDurakMotion } from './DurakMotion';
import { DurakReactions } from './DurakReactions';
import { TurnRing } from './TurnRing';
import { useVoiceTier } from './useVoice';
import { IntegrationBarSlot, StageExitButton } from './IntegrationBar';
import { Avatar, IconButton, useStore } from './primitives';

type SheetKind = 'settings' | 'result' | 'score' | null;

/**
 * Время на ход на выбор ведущего (R110): 15, 30 (по умолчанию) или 45 с — владелец 24.10.2026. Те же
 * ступени держит ядро (`Durak.TURN_STEPS`): другое значение оно прижимает к ближайшей.
 */
const TURN_STEPS = [15, 30, 45];
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
  const { t } = useTranslation();
  const tracks = useStore(meeting.media.tracks);
  const snapshot = useStore(meeting.snapshot);
  const connection = useStore(meeting.control.state);
  const connected = connection === 'connected';
  const you = table.you;
  const mySeat = you?.seat ?? null;
  const host = allowed({ ...snapshot, durak: table }, meeting.admission.participantId, 'durak.manage');
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
  /*
    Раздача и добор — полёты рубашек из колоды к местам (`CardMotion`, как у покера); бросок,
    перевод, взятие и «бито» рисует сам стол. События фильтруются один раз на снимок: новый массив
    на каждую отрисовку перезапускал бы полёты бесконечно.
  */
  const dealing = useMemo(
    () => (table.visualEvents ?? []).filter((event) => event.type === 'deal' || event.type === 'draw'),
    [table.visualEvents],
  );
  useCardSounds(meeting, 'durak', table.visualEvents);
  useTurnTicks(meeting, 'durak', table.deadline, !!you?.turn && !paused && connected);
  const me = mySeat === null ? null : table.seats.find((seat) => seat.index === mySeat);
  useResultSound(
    'durak',
    table.result?.at,
    me && table.result ? (me.fool ? 'lose' : me.place > 0 ? 'win' : null) : null,
  );
  const transfer = useTransferCue(meeting, table, spots);
  // Веер своей руки после раздачи: карты встают по одной с тем же шагом, с каким летят рубашки.
  const dealtAgo = useMemo(() => Math.max(0, meeting.serverNow() - table.dealtAt), [meeting, table.dealtAt]);
  const fanning = useRecent(meeting, table.dealtAt, DEAL_MS + 700) && table.phase === 'bout';
  const bout = useRef<HTMLDivElement>(null);
  const sweep = useSweep(meeting, table, scene, bout);
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
      refuse(t(($) => $.durak.refused));
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
    ? t(($) => $.durak.status.reconnecting)
    : paused
      ? t(($) => $.durak.status.paused)
      : tableSays(t, table, mySeat);
  const guidance = !selected
    ? ''
    : selectedBeats.length && tableTarget && defending
      ? t(($) => $.durak.guidance.beatOrTransfer)
      : selectedBeats.length
        ? t(($) => $.durak.guidance.beat)
        : tableTarget
          ? defending
            ? t(($) => $.durak.guidance.transfer)
            : t(($) => $.durak.guidance.place)
          : t(($) => $.durak.guidance.none);
  const seated = table.seats.filter((seat) => seat.memberId).length;
  const frozenSeconds = Math.max(0, Math.ceil((table.pausedRemaining ?? 0) / 1000));
  /*
    Лоток под столом (R129): рука и одно место для действия — всегда видно, без прокрутки. Главная кнопка
    стоит по центру под рукой и не прыгает между ходами: у защитника это «Беру», у остальных «Бито»;
    недоступна — остаётся на месте приглушённой. Зрителю на том же месте — «Сесть за стол», ведущему
    между партиями — «Раздать». Рядом тише — «Отменить» выбор карты, слева — что делать сейчас, одной строкой.
  */
  const between = table.phase !== 'bout';
  const freeSeat = table.seats.some((seat) => !seat.memberId);
  const canSit = mySeat === null && freeSeat;
  const playing =
    table.phase === 'bout' && !!you && !!me && !me.out && (hand.length > 0 || !!you.actions.length);
  const turnAction: 'take' | 'pass' = mySeat !== null && mySeat === table.defender ? 'take' : 'pass';
  const dealButton = host && between && (
    <button
      className={canSit ? 'durak-aside-act' : 'durak-act'}
      data-kind="deal"
      disabled={!connected || pending || seated < 2}
      onClick={() => send('durak.deal')}
    >
      <Play size={canSit ? 16 : 20} /> {t(($) => $.durak.deal)}
    </button>
  );
  const note = refusal
    ? refusal
    : pending
      ? t(($) => $.durak.hint.saving)
      : focusChoice
        ? guidance
        : paused
          ? ''
          : playing && you?.turn
            ? t(($) => $.durak.hint.turn)
            : mySeat === null
              ? canSit
                ? !table.seatingOpen
                  ? t(($) => $.durak.settings.seating.closed)
                  : between
                    ? ''
                    : t(($) => $.durak.dock.nextDeal)
                : t(($) => $.durak.hand.watching)
              : between
                ? host
                  ? ''
                  : t(($) => $.durak.hand.waiting)
                : !playing && !me?.out
                  ? t(($) => $.durak.dock.nextDeal)
                  : '';

  return (
    <div
      className="durak durak-refined"
      ref={scene}
      data-phase={table.phase}
      data-paused={paused || undefined}
      data-full={targetFull || undefined}
      data-seated={mySeat !== null || undefined}
    >
      <header className="durak-bar">
        <div className="durak-mode">
          <b>{t(($) => $.durak.title)}</b>
          <small>
            {modeName(t, table.mode)} ·{' '}
            {t(($) => $.durak.deckSize, { size: table.deckSize, count: table.deckSize })}
            {table.trumpSuit ? ` · ${trumpName(t, table)}` : ''}
          </small>
        </div>
        {/* Чей ход и сколько осталось — плашкой посередине шапки, как у покера: отдельная полоса над
            сукном отнимала у стола 46 px высоты. */}
        <TurnStatus meeting={meeting} table={table} label={says} connected={connected} />
        <div className="durak-bar-tools">
          {/* Музыка во встрече — мини-плеером в шапке стола, перед кнопками стола (R128). */}
          <IntegrationBarSlot />
          {table.score.length > 0 && (
            <IconButton label={t(($) => $.durak.score.title)} onClick={() => setSheet('score')}>
              <ListOrdered size={20} />
            </IconButton>
          )}
          {host && pauseSupported && table.phase === 'bout' && (
            <IconButton
              label={paused ? t(($) => $.durak.pause.resume) : t(($) => $.durak.pause.pauseGame)}
              disabled={!connected || pending}
              onClick={() => send('durak.settings', { option: paused ? 'resume' : 'pause' })}
            >
              {paused ? <Play size={20} /> : <Pause size={20} />}
            </IconButton>
          )}
          <IconButton
            label={t(($) => $.durak.settings.title)}
            onClick={() => {
              clearSelection();
              setSheet('settings');
            }}
          >
            <Settings2 size={20} />
          </IconButton>
          {/* Выход к участникам (R121) — рядом с полным экраном: обе кнопки про вид, а не про игру. */}
          <StageExitButton variant="bar" />
          <IconButton label={full ? t(($) => $.durak.exitFull) : t(($) => $.durak.full)} onClick={toggleFull}>
            {full ? <Minimize2 size={20} /> : <Maximize2 size={20} />}
          </IconButton>
        </div>
      </header>
      <div className="durak-table">
        <div className="durak-arena" ref={tableGeometry.ref}>
          <div
            className="durak-felt"
            data-drop={tableTarget ? 'table' : undefined}
            data-choice={focusChoice || undefined}
            data-crowd={spots.length >= 3 || undefined}
          >
            <CardMotion meeting={meeting} events={dealing} spots={spots} />
            {/* Знак заведения в середине сукна — как на покерном столе: раздача идёт на столе Cord. */}
            <CordMark className="durak-felt-mark" />
            <div className="durak-focus-shade" aria-hidden="true" />
            <div
              className="durak-mat"
              data-focus={focusChoice || undefined}
              style={{ '--pairs': Math.max(1, table.table.length) } as CSSProperties}
            >
              {table.phase === 'bout' && <Stock table={table} />}
              {table.phase === 'bout' && (
                <div
                  className="durak-bout"
                  ref={bout}
                  data-end={table.boutEnd ?? undefined}
                  data-pairs={table.table.length}
                  style={sweep}
                >
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
                          aria-label={
                            target
                              ? t(($) => $.durak.attack.beat, { card: faceOf(t, pair.attack).label })
                              : t(($) => $.durak.attack.onTable, { card: faceOf(t, pair.attack).label })
                          }
                        >
                          <Card card={pair.attack} board />
                          {target && (
                            <span className="durak-target-label">
                              <Shield size={12} /> {t(($) => $.durak.attack.beatShort)}
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
              {table.phase === 'bout' && <Discard count={table.discarded} />}
              {tableTarget && (
                <button className="durak-place" data-drop="table" onClick={() => place({ kind: 'table' })}>
                  {defending ? <ArrowRightLeft size={16} /> : <Hand size={16} />}
                  {defending
                    ? t(($) => $.durak.place.transfer)
                    : table.table.length
                      ? t(($) => $.durak.place.throw)
                      : t(($) => $.durak.place.put)}
                </button>
              )}
              {table.phase !== 'bout' && (
                <div className="durak-center">
                  <span className="durak-center-suit" aria-hidden="true">
                    ♠
                  </span>
                  <h3>
                    {table.phase === 'over'
                      ? t(($) => $.durak.center.over)
                      : seated < 2
                        ? t(($) => $.durak.center.gather)
                        : t(($) => $.durak.center.ready)}
                  </h3>
                  <p>
                    {table.phase === 'over'
                      ? t(($) => $.durak.center.again)
                      : seated < 2
                        ? t(($) => $.durak.center.needTwo)
                        : host
                          ? t(($) => $.durak.center.dealHost)
                          : t(($) => $.durak.center.dealSoon)}
                  </p>
                </div>
              )}
            </div>
            {transfer && (
              <span
                key={transfer.id}
                className="durak-transfer-cue"
                aria-hidden="true"
                style={
                  {
                    '--fx': `${transfer.from.x}%`,
                    '--fy': `${transfer.from.y}%`,
                    '--tx': `${transfer.to.x}%`,
                    '--ty': `${transfer.to.y}%`,
                    animationDelay: `${-transfer.ago}ms`,
                  } as CSSProperties
                }
              >
                <ArrowRightLeft size={12} /> {transfer.name}
              </span>
            )}
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
                <b>{t(($) => $.durak.status.paused)}</b>
                <span>
                  {t(($) => $.durak.pause.stopped)}
                  {frozenSeconds ? t(($) => $.durak.pause.left, { seconds: frozenSeconds }) : ''}
                </span>
                {host ? (
                  <button
                    className="button primary"
                    disabled={!connected || pending}
                    onClick={() => send('durak.settings', { option: 'resume' })}
                  >
                    <Play size={16} /> {t(($) => $.durak.pause.continue)}
                  </button>
                ) : (
                  <small>{t(($) => $.durak.pause.hostWill)}</small>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="durak-tray" data-hand={hand.length > 0 || undefined}>
          {/* Руки нет (зритель, ждём раздачи, вышел из партии) — полоса схлопнута, и сукну достаётся её
              высота; карты пришли — она плавно раскрывается, а кнопка лотка остаётся на месте. */}
          <div className="durak-hand-band" data-empty={hand.length === 0 || undefined}>
            {handOverflow && (
              <button
                className="durak-hand-scroll is-left"
                aria-label={t(($) => $.durak.hand.left)}
                onClick={() => handScroller.current?.scrollBy({ left: -220 })}
              >
                <ChevronLeft size={20} />
              </button>
            )}
            <div
              ref={handScroller}
              className="durak-hand"
              aria-label={t(($) => $.durak.hand.label)}
              hidden={mySeat === null}
              data-large={hand.length > 10 || undefined}
              data-dealing={fanning || undefined}
              style={{ '--dealt': `${dealtAgo}ms`, '--count': hand.length } as CSSProperties}
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
                    aria-label={faceOf(t, card).label}
                    aria-pressed={picked === card}
                    aria-describedby={picked === card ? 'durak-selection-instruction' : undefined}
                    style={{ '--angle': `${angle}deg`, '--lift': raise, '--i': index } as CSSProperties}
                  >
                    <Card card={card} />
                  </button>
                );
              })}
            </div>
            {handOverflow && (
              <button
                className="durak-hand-scroll is-right"
                aria-label={t(($) => $.durak.hand.right)}
                onClick={() => handScroller.current?.scrollBy({ left: 220 })}
              >
                <ChevronRight size={20} />
              </button>
            )}
            {picked && (
              <span id="durak-selection-instruction" className="sr-only">
                {t(($) => $.durak.hand.instruction, { guidance })}
              </span>
            )}
          </div>
          <div className="durak-dock" data-has-note={note ? true : undefined}>
            {/*
              Что делать сейчас — одной строкой у кнопки: отказ хода, «сохраняем», что делать с выбранной
              картой, «выберите карту». Только когда это про ваше действие (R27): «следите за игрой»
              повторяло бы то, что видно на сукне.
            */}
            <p className="durak-dock-note" data-tone={refusal ? 'error' : focusChoice ? 'guide' : undefined}>
              {refusal ? (
                <span role="alert">{note}</span>
              ) : focusChoice ? (
                <span role="status">{note}</span>
              ) : (
                <span>{note}</span>
              )}
            </p>
            <div className="durak-actions">
              {canSit ? (
                <button
                  className="durak-act"
                  data-kind="sit"
                  disabled={!table.seatingOpen || !connected || pending}
                  onClick={() => send('durak.sit')}
                >
                  <Armchair size={20} /> {t(($) => $.durak.sit)}
                </button>
              ) : (
                dealButton
              )}
              {playing && (
                <button
                  className="durak-act"
                  data-kind={turnAction}
                  disabled={!canPlay || !you!.actions.includes(turnAction)}
                  onClick={() => send('durak.act', { option: turnAction })}
                >
                  {turnAction === 'take' ? <Hand size={20} /> : <Check size={20} />}{' '}
                  {turnAction === 'take' ? t(($) => $.durak.actions.take) : t(($) => $.durak.actions.pass)}
                </button>
              )}
            </div>
            <div className="durak-dock-aside">
              {picked ? (
                <button
                  className="durak-aside-act"
                  data-kind="cancel"
                  aria-label={t(($) => $.durak.hand.cancelSelection)}
                  title={t(($) => $.durak.hand.cancelSelection)}
                  onClick={clearSelection}
                >
                  <X size={16} /> <span>{t(($) => $.durak.hand.cancel)}</span>
                </button>
              ) : (
                canSit && dealButton
              )}
            </div>
          </div>
        </div>
      </div>
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
                  {sheet === 'settings'
                    ? t(($) => $.durak.settings.title)
                    : sheet === 'score'
                      ? t(($) => $.durak.score.title)
                      : t(($) => $.durak.result.title)}
                </Dialog.Title>
                <Dialog.Description>
                  {sheet === 'settings'
                    ? host
                      ? t(($) => $.durak.settings.hostNote)
                      : t(($) => $.durak.settings.guestNote)
                    : t(($) => $.durak.score.description)}
                </Dialog.Description>
              </div>
              <Dialog.Close
                render={
                  <IconButton label={t(($) => $.common.close)}>
                    <X size={20} />
                  </IconButton>
                }
              >
                <X size={20} />
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

/** Свежо ли событие с этой серверной меткой: перерисовка, когда перестанет. */
function useRecent(meeting: Meeting, at: number, ms: number) {
  const [, refresh] = useState(0);
  const left = at > 0 ? at + ms - meeting.serverNow() : 0;
  const live = left > 0;
  useEffect(() => {
    if (!live) return;
    const timer = setTimeout(() => refresh((count) => count + 1), left + 20);
    return () => clearTimeout(timer);
    // `left` меняется на каждой отрисовке; таймер ставится один раз на событие.
  }, [at, live]);
  return live;
}

/**
 * Перевод — бой уезжает к соседу (T07): от места переводящего к новому защитнику скользит
 * метка с его именем. Задержка отрицательная, от серверной метки события, — у всех одновременно.
 */
function useTransferCue(meeting: Meeting, table: Table, spots: { index: number; x: number; y: number }[]) {
  const event = (table.visualEvents ?? []).filter((item) => item.type === 'transfer').at(-1);
  const live = useRecent(meeting, event?.at ?? 0, 1300);
  const ago = useMemo(() => (event ? Math.max(0, meeting.serverNow() - event.at) : 0), [meeting, event?.id]);
  if (!event || !live || table.phase !== 'bout') return null;
  const from = spots.find((spot) => spot.index === event.fromSeat);
  const to = spots.find((spot) => spot.index === event.toSeat);
  if (!from || !to) return null;
  return {
    id: event.id,
    from,
    to,
    ago,
    name: table.seats.find((seat) => seat.index === event.toSeat)?.name ?? '',
  };
}

/**
 * Куда уходит закончившийся бой: «взял» — сгребается к месту взявшего, «бито» — уезжает в отбой.
 * Цель меряется по настоящей вёрстке, а время — от серверной метки конца боя.
 */
function useSweep(
  meeting: Meeting,
  table: Table,
  scene: React.RefObject<HTMLDivElement | null>,
  bout: React.RefObject<HTMLDivElement | null>,
): CSSProperties | undefined {
  const [sweep, setSweep] = useState<CSSProperties | undefined>();
  useLayoutEffect(() => {
    if (!table.boutEnd || !bout.current || !scene.current) {
      setSweep(undefined);
      return;
    }
    const target =
      table.boutEnd === 'taken'
        ? scene.current.querySelector(`[data-game-seat="${table.defender}"] .durak-seat-face`)
        : scene.current.querySelector('.durak-discard-cards');
    const from = bout.current.getBoundingClientRect();
    const to = target?.getBoundingClientRect();
    if (!to || !from.width) {
      setSweep(undefined);
      return;
    }
    setSweep({
      '--sweep-x': `${to.left + to.width / 2 - (from.left + from.width / 2)}px`,
      '--sweep-y': `${to.top + to.height / 2 - (from.top + from.height / 2)}px`,
      '--sweep-delay': `${450 - Math.max(0, meeting.serverNow() - table.boutAt)}ms`,
    } as CSSProperties);
    // Цель и время закрепляются на конец боя; перерисовки внутри него их не двигают.
  }, [table.boutEnd, table.boutAt]);
  return sweep;
}

function dragTransform(drag: Drag) {
  return `translate3d(${drag.x - drag.width / 2}px, ${drag.y - drag.height / 2}px, 0) rotate(${drag.angle}deg)`;
}

/**
 * Чей ход — плашкой посередине шапки стола (R129, как у покера): что происходит за столом и сколько
 * секунд осталось. Отказ хода сюда не пишется — он у кнопки лотка, там, куда смотрит игравший.
 */
function TurnStatus({
  meeting,
  table,
  label,
  connected,
}: {
  meeting: Meeting;
  table: Table;
  label: string;
  connected: boolean;
}) {
  const { t } = useTranslation();
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
    <div className="durak-turn" data-active={(table.you?.turn && !table.paused) || undefined}>
      <strong role="status" title={label}>
        {label}
      </strong>
      {(table.paused || running) && (
        <span
          aria-label={
            table.paused
              ? t(($) => $.durak.turn.pausedLeft, { seconds, count: seconds })
              : t(($) => $.durak.turn.left, { seconds, count: seconds })
          }
        >
          {table.paused && <Pause size={14} />}
          {t(($) => $.durak.seconds, { seconds })}
        </span>
      )}
    </div>
  );
}

/**
 * Колода — на сукне слева от боя (T07: «где лежит колода»): стопка рубашек, козырь из-под неё и
 * остаток числом. Кончилась колода — остаётся лежать один козырь, чтобы масть было видно до конца.
 */
function Stock({ table }: { table: Table }) {
  const { t } = useTranslation();
  if (!table.trump) return null;
  const backs = Math.min(3, Math.max(0, table.deckLeft - 1));
  const trump = faceOf(t, table.trump).label;
  return (
    <div
      className="durak-stock"
      data-empty={table.deckLeft === 0 || undefined}
      role="img"
      aria-label={t(($) => $.durak.stock.label, {
        cards: t(($) => $.durak.cards, { count: table.deckLeft }),
        card: trump,
      })}
    >
      <div className="durak-stock-cards">
        <span className="durak-trump" aria-label={t(($) => $.durak.stock.trump, { card: trump })}>
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
        <small>
          {table.deckLeft === 0
            ? t(($) => $.durak.stock.trumps, { suit: trumpName(t, table) })
            : t(($) => $.durak.stock.inDeck)}
        </small>
      </div>
    </div>
  );
}

/** Наклоны карт в отбое: стопка лежит вразброс, как сброшенная рукой, а не ровной колодой. */
const DISCARD_TILT = [-9, 6, -3, 11];

/** Отбой справа от боя: стопка растёт по мере «бито», рядом — сколько карт ушло. */
function Discard({ count }: { count: number }) {
  const { t } = useTranslation();
  const shown = count ? Math.min(DISCARD_TILT.length, Math.ceil(count / 6)) : 0;
  return (
    <div
      className="durak-discard"
      data-empty={count === 0 || undefined}
      role="img"
      aria-label={t(($) => $.durak.discard.label, { cards: t(($) => $.durak.cards, { count }) })}
    >
      <div className="durak-discard-cards">
        {DISCARD_TILT.slice(0, shown).map((tilt) => (
          <span className="durak-back" key={tilt} style={{ '--tilt': `${tilt}deg` } as CSSProperties}>
            <Card />
          </span>
        ))}
      </div>
      <div className="durak-stock-count">
        {count}
        <small>{t(($) => $.durak.discard.caption)}</small>
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
  const { t } = useTranslation();
  const face = card ? faceOf(t, card) : null;
  return (
    <span
      className="durak-card"
      data-durak-board-card={board ? card : undefined}
      data-red={face?.red || undefined}
      data-back={!face || undefined}
    >
      {!face && <CordMark className="durak-card-mark" />}
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
  const { t } = useTranslation();
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
  return (
    <video ref={ref} autoPlay playsInline muted aria-label={t(($) => $.durak.camera, { name: tile.name })} />
  );
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
  const { t } = useTranslation();
  const acting = table.acting.includes(seat.index);
  const zoom = useFaceZoom('durak', seat.memberId);
  // Говорит — зелёное кольцо у лица, тем же голосом, что в покере и на сцене (R109).
  const voice = useVoiceTier(meeting, seat.memberId);
  /*
    Ждём его хода — жёлтое кольцо снаружи, от меток ядра (R110). Видно всем за столом и
    зрителям. На паузе срока нет, и кольца тоже: домотанное до конца, оно бы врало.
  */
  const ring = acting && table.phase === 'bout' && !table.paused && table.deadline > 0;
  // Ни «нечего подкинуть», ни «нечем отбиться» (R108): подпись — только то, что видно за столом.
  const role = seat.fool
    ? t(($) => $.durak.role.fool)
    : seat.out
      ? t(($) => $.durak.role.out, { place: seat.place })
      : seat.defender
        ? table.taking
          ? t(($) => $.durak.role.takes)
          : t(($) => $.durak.role.defends)
        : seat.passed
          ? t(($) => $.durak.role.passed)
          : seat.attacker
            ? t(($) => $.durak.role.attacks)
            : seat.away
              ? t(($) => $.durak.role.away)
              : '';
  // Сколько карт на руках — у каждого места, и у своего тоже (T07): одно число, без рубашек веером.
  const counted = table.phase === 'bout' && !seat.out;
  return (
    <div
      className="durak-seat"
      data-game-seat={seat.index}
      data-side={spot.side}
      data-half={spot.x < 40 ? 'start' : spot.x > 60 ? 'end' : undefined}
      data-away={seat.away || undefined}
      data-out={seat.out || undefined}
      data-mine={mine || undefined}
      data-acting={acting || undefined}
      data-speaking={voice > 0 || undefined}
      data-voice={voice || undefined}
      data-fool={(table.phase === 'over' && seat.fool) || undefined}
      data-first={(table.phase === 'over' && seat.place === 1) || undefined}
      style={{ left: `${spot.x}%`, top: `${spot.y}%`, ...zoom.style }}
    >
      <span className="durak-seat-avatar">
        <DurakReactions meeting={meeting} table={table} seat={seat.index} mine={mine}>
          <span className="durak-seat-face">
            {tile ? <SeatCamera tile={tile} /> : <Avatar name={seat.name} src={avatar} />}
            {ring && <TurnRing meeting={meeting} actionAt={table.actionAt} deadline={table.deadline} />}
          </span>
        </DurakReactions>
        {counted && (
          <span className="durak-seat-count" aria-label={t(($) => $.durak.cards, { count: seat.held })}>
            <i aria-hidden="true" />
            {seat.held}
          </span>
        )}
        <FaceZoomButton zoom={zoom.zoom} name={seat.name} onCycle={zoom.cycle} />
      </span>
      <span className="durak-seat-name" title={seat.name}>
        {mine ? t(($) => $.durak.seat.mine, { name: seat.name }) : seat.name}
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
  const { t } = useTranslation();
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
          {table.paused ? <Play size={20} /> : <Pause size={20} />}
          <span>
            <b>{table.paused ? t(($) => $.durak.pause.resume) : t(($) => $.durak.pause.pause)}</b>
            <small>{t(($) => $.durak.settings.pauseHint)}</small>
          </span>
        </button>
      )}
      <div className="durak-settings-group">
        <h3>{t(($) => $.durak.settings.rules)}</h3>
        <SettingChoice
          label={t(($) => $.durak.settings.deck.label)}
          hint={live ? t(($) => $.durak.settings.deck.live) : t(($) => $.durak.settings.deck.idle)}
          values={[36, 52].map((value) => ({
            value,
            label: t(($) => $.durak.deckSize, { size: value, count: value }),
          }))}
          value={table.deckSize}
          disabled={!host || disabled || live}
          onChange={(value) => set('deck', value)}
        />
        <SettingChoice
          label={t(($) => $.durak.settings.mode.label)}
          hint={t(($) => $.durak.settings.mode.hint)}
          values={[
            { value: 0, label: t(($) => $.durak.modes.podkidnoy) },
            { value: 1, label: t(($) => $.durak.modes.perevodnoy) },
          ]}
          value={table.mode === 'perevodnoy' ? 1 : 0}
          disabled={!host || disabled || live}
          onChange={(value) => set('rules', value)}
        />
        <SettingChoice
          label={t(($) => $.durak.settings.throwers.label)}
          values={[
            { value: 0, label: t(($) => $.durak.settings.throwers.all) },
            { value: 1, label: t(($) => $.durak.settings.throwers.neighbours) },
          ]}
          value={table.neighbours ? 1 : 0}
          disabled={!host || disabled}
          onChange={() => set('neighbours')}
        />
        <SettingChoice
          label={t(($) => $.durak.settings.first.label)}
          values={[
            { value: 0, label: t(($) => $.durak.cards, { count: 6 }) },
            { value: 1, label: t(($) => $.durak.cards, { count: 5 }) },
          ]}
          value={table.firstFive ? 1 : 0}
          disabled={!host || disabled}
          onChange={() => set('first-five')}
        />
        <SettingChoice
          label={t(($) => $.durak.settings.turn.label)}
          hint={table.paused ? t(($) => $.durak.settings.turn.paused) : undefined}
          values={[...new Set([...TURN_STEPS, table.turnSeconds])]
            .sort((a, b) => a - b)
            .map((value) => ({ value, label: t(($) => $.durak.seconds, { seconds: value }) }))}
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
            <b>{t(($) => $.durak.settings.seating.label)}</b>
            <small>
              {table.seatingOpen
                ? t(($) => $.durak.settings.seating.open)
                : t(($) => $.durak.settings.seating.closed)}
            </small>
          </span>
          <i aria-hidden="true" />
        </button>
      )}
      {!host && <p className="durak-settings-note">{t(($) => $.durak.settings.guestOnly)}</p>}
      {seated && (
        <button
          className="durak-settings-action"
          disabled={disabled || (live && table.paused)}
          onClick={() => onSend('durak.stand')}
        >
          <LogOut size={20} />
          <span>
            <b>{t(($) => $.durak.settings.stand.label)}</b>
            <small>
              {live ? t(($) => $.durak.settings.stand.live) : t(($) => $.durak.settings.stand.idle)}
            </small>
          </span>
        </button>
      )}
      {host && (
        <button
          className="durak-settings-action is-danger"
          disabled={disabled}
          onClick={() => onSend('durak.close')}
        >
          <X size={20} />
          <span>
            <b>{t(($) => $.durak.settings.close.label)}</b>
            <small>{t(($) => $.durak.settings.close.hint)}</small>
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
  const { t } = useTranslation();
  return (
    <table className="durak-score-table">
      <thead>
        <tr>
          <th>{t(($) => $.durak.score.player)}</th>
          <th>{t(($) => $.durak.score.games)}</th>
          <th>{t(($) => $.durak.score.fools)}</th>
          <th>{t(($) => $.durak.score.streak)}</th>
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

/** Итог партии. Ничьей нет (R111): дурак есть всегда, без имени — только у записи прежнего ядра. */
function Result({ table }: { table: Table }) {
  const { t } = useTranslation();
  const result = table.result!;
  return (
    <div className="durak-over">
      <div className="durak-over-symbol" aria-hidden="true">
        ♠
      </div>
      <h3>
        {result.foolName ? t(($) => $.durak.fool, { name: result.foolName }) : t(($) => $.durak.says.over)}
      </h3>
      <p>
        {t(($) => $.durak.result.bouts, { count: result.bouts })} · {t(($) => $.durak.result.foolNote)}
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
      <Dialog.Close render={<button className="button primary full" />}>
        {t(($) => $.durak.result.back)}
      </Dialog.Close>
    </div>
  );
}
