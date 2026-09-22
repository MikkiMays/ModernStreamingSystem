import { DurakReactions } from './DurakReactions';
import '../game-polish.css';
import { occupiedSeatLayout } from '../core/game-layout';
import { CardMotion, GameTurn, useTableRatio } from './GamePresentation';
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { TrackEvent } from 'livekit-client';
import { Hand, LogOut, Maximize2, Minimize2, Play, Settings2, X } from 'lucide-react';
import type { Meeting } from '../core/meeting';
import type { DurakSeat, DurakTable as Table } from '../api/types';
import type { MediaTile } from '../media/session';
import { signal } from '../core/sounds';
import {
  BOUT_MS,
  DEAL_MS,
  DEAL_STEP_MS,
  commandFor,
  dropFrom,
  faceOf,
  fanAngle,
  modeName,
  plural,
  tableSays,
  trumpName,
} from '../core/durak';
import { useFullscreen } from '../core/fullscreen';
import { Avatar, IconButton, useStore } from './primitives';

/**
 * Стол дурака на сцене встречи.
 *
 * ЗДЕСЬ НЕТ ПРАВИЛ И НЕТ ПОДСКАЗОК. Первая версия получала от ядра три списка законных карт и
 * подсвечивала ими руку. За настоящим столом никто не подсвечивает: человек берёт карту, кладёт
 * её — и узнаёт, легла ли. Теперь так же: все карты выглядят одинаково, любую можно взять
 * пальцем, а незаконный ход просто не ложится и возвращается в руку.
 *
 * ХОД — ЭТО ДВИЖЕНИЕ, А НЕ НАЖАТИЕ. Карту тащат: на чужую карту — значит бьют именно её, на
 * сукно — значит кладут новую (а защитник этим переводит). Кнопок остаётся ровно две, и обе про
 * отказ ходить: «Беру» и «Бито».
 *
 * ПОЧЕМУ ЗДЕСЬ ПОЧТИ НЕТ ТАЙМЕРОВ. Всё, что движется само, — прилёт карт, кольцо хода, уход боя —
 * это CSS с длительностью из снимка и отрицательной задержкой, равной уже прошедшему времени. За
 * пальцем карта едет, разумеется, кадрами, но ровно пока палец на ней.
 */
type SheetKind = 'settings' | 'result' | 'score' | null;

/** Карта в полёте: что тащим, откуда взяли и где палец сейчас. */
interface Drag {
  card: string;
  pointer: number;
  x: number;
  y: number;
  /** Откуда карта поднялась: по этой точке считается наклон и то, сдвинули ли её вообще. */
  fromX: number;
  fromY: number;
  width: number;
  angle: number;
  moved: boolean;
}

export default function DurakTable({ meeting, table }: { meeting: Meeting; table: Table }) {
  const tracks = useStore(meeting.media.tracks);
  const snapshot = useStore(meeting.snapshot);
  const me = meeting.admission.participantId;
  const you = table.you;
  const mySeat = you ? you.seat : null;
  const tableGeometry = useTableRatio();
  const spots = occupiedSeatLayout(
    table.seats.filter((seat) => seat.memberId).map((seat) => seat.index),
    mySeat,
    tableGeometry.ratio,
  );
  const host = table.hostId === me || !!snapshot.participants.find((p) => p.id === me)?.owner;
  const [sheet, setSheet] = useState<SheetKind>(null);
  /*
    Отказ сервера — единственная обратная связь про законность хода, и живёт он пару секунд.

    Это не подсказка: подсказка говорит «сюда нельзя» до того, как человек попробовал. Здесь
    наоборот — попробовал, не легло, услышал почему.
  */
  const [refusal, setRefusal] = useState('');
  const refusalTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refuse = useCallback((text: string) => {
    setRefusal(text);
    if (refusalTimer.current) clearTimeout(refusalTimer.current);
    refusalTimer.current = setTimeout(() => setRefusal(''), 2600);
  }, []);
  useEffect(() => () => void (refusalTimer.current && clearTimeout(refusalTimer.current)), []);

  const scene = useRef<HTMLDivElement>(null);
  const handScroller = useRef<HTMLDivElement>(null);
  const { full, targetFull, toggle: toggleFull } = useFullscreen(scene);

  const send = (type: Parameters<Meeting['command']>[0], extra?: Parameters<Meeting['command']>[3]) =>
    meeting.command(type, undefined, undefined, extra);
  const command = (type: Parameters<Meeting['command']>[0], extra?: Parameters<Meeting['command']>[3]) => {
    void send(type, extra).catch((e) => refuse((e as Error).message));
  };

  /*
    Свой ход слышно. Человек за столом почти всегда занят ещё и разговором, и «ваш ход» без звука
    означает ход, проигранный по часам. Сигнал звучит один раз на ход.
  */
  const announced = useRef(0);
  useEffect(() => {
    if (!you?.turn) return;
    if (announced.current === table.actionAt) return;
    announced.current = table.actionAt;
    signal('turn');
  }, [you?.turn, table.actionAt]);

  // Партия кончилась — итог открывается сам: это тот единственный момент, когда его и ждут.
  const shown = useRef(0);
  useEffect(() => {
    const result = table.result;
    if (!result || shown.current === result.at) return;
    shown.current = result.at;
    setSheet('result');
  }, [table.result]);

  // --- Перетаскивание -----------------------------------------------------------------------

  const [drag, setDrag] = useState<Drag | null>(null);
  /*
    Карта, выбранная нажатием.

    Запасной путь для клавиатуры и для тех, кто привык тапать: нажал карту, нажал цель. Это не
    подсказка — подсвечивается ровно та карта, которую человек поднял сам, и ничего больше.
  */
  const [picked, setPicked] = useState<string | null>(null);
  /** Карта, которая уже ушла на стол и ждёт ответа сервера: из руки она пропадает сразу. */
  const [flying, setFlying] = useState<string | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;

  // Карта, которой больше нет на руках, не может оставаться выбранной.
  useEffect(() => {
    if (picked && !you?.cards.includes(picked)) setPicked(null);
  }, [picked, you?.cards]);

  const canPlay = table.phase === 'bout' && !table.boutEnd && !!you;

  const lift = (card: string, event: React.PointerEvent<HTMLElement>) => {
    if (!canPlay || flying) return;
    /*
      Без этого браузер занимается своим: тянет выделение текста по столу и отменяет захват
      указателя своим `pointercancel`. Карта при этом не едет никуда, и жест пропадает целиком —
      ровно это и случилось в первой версии.
    */
    event.preventDefault();
    const box = event.currentTarget.getBoundingClientRect();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({
      card,
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      fromX: box.left + box.width / 2,
      fromY: box.top + box.height / 2,
      width: box.width,
      angle: 0,
      moved: false,
    });
  };

  const move = (event: React.PointerEvent<HTMLElement>) => {
    const current = dragRef.current;
    if (!current || current.pointer !== event.pointerId) return;
    setDrag({
      ...current,
      x: event.clientX,
      y: event.clientY,
      // Карта отклоняется по ходу движения — так её и несут в руке.
      angle: Math.max(-12, Math.min(12, (event.clientX - current.fromX) / 14)),
      moved: current.moved || Math.abs(event.clientY - current.fromY) > 6,
    });
  };

  /*
    Бросок.

    Зону выбирает точка под пальцем, а не сама карта: летящая карта лежит поверх всего и не ловит
    нажатия, иначе `elementFromPoint` всегда возвращал бы её же. Движение меньше шести пикселей
    броском не считается — это случайное касание веера, а не ход.
  */
  /** Положить выбранную нажатием карту: та же команда, что и у броска. */
  const place = (target: { kind: 'beat'; under: string } | { kind: 'table' }) => {
    if (!picked) return;
    const shape = commandFor(target, mySeat !== null && mySeat === table.defender);
    if (!shape) return;
    const card = picked;
    setPicked(null);
    setFlying(card);
    void send('durak.act', { option: shape.option, card, under: shape.under })
      .catch((e) => refuse((e as Error).message))
      .finally(() => setFlying(null));
  };

  const drop = (event: React.PointerEvent<HTMLElement>) => {
    const current = dragRef.current;
    if (!current || current.pointer !== event.pointerId) return;
    setDrag(null);
    // Нажатие без движения — это выбор карты, а не бросок.
    if (!current.moved) {
      setPicked(picked === current.card ? null : current.card);
      return;
    }
    setPicked(null);
    const target = dropFrom(document.elementFromPoint(event.clientX, event.clientY));
    const shape = commandFor(target, mySeat !== null && mySeat === table.defender);
    if (!shape) return;
    setFlying(current.card);
    void send('durak.act', { option: shape.option, card: current.card, under: shape.under })
      .catch((e) => refuse((e as Error).message))
      .finally(() => setFlying(null));
  };

  const says = tableSays(table, mySeat);
  const alarm = table.boutEnd === 'taken' || (!!table.result && !table.result.draw);
  const seated = table.seats.filter((s) => s.memberId).length;
  const hand = (you?.cards ?? []).filter((card) => card !== flying);
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
  const myScore = table.score.find((row) => row.name === table.seats[mySeat ?? -1]?.name);

  return (
    <div
      className="durak"
      ref={scene}
      data-phase={table.phase}
      data-bout={table.boutEnd ?? undefined}
      data-full={targetFull ? 'true' : undefined}
    >
      <div className="durak-bar">
        <div className="durak-mode">
          <b>{modeName(table.mode)} дурак</b>
          <small>
            {table.deckSize} карт{table.trumpSuit ? ` · козыри ${trumpName(table)}` : ''} ·{' '}
            {table.turnSeconds} с
          </small>
        </div>
        <span className="durak-says" data-alarm={alarm || !!refusal || undefined} role="status">
          {refusal || says}
        </span>
        <span className="durak-bar-spacer" />
        <Scoreboard table={table} onOpen={() => setSheet('score')} />
        {host && table.phase !== 'bout' && (
          <button className="button primary" onClick={() => command('durak.deal')}>
            <Play size={16} /> Раздать
          </button>
        )}
        <IconButton
          label="Настройки стола"
          onClick={() => setSheet(sheet === 'settings' ? null : 'settings')}
        >
          <Settings2 size={17} />
        </IconButton>
        <IconButton label={full ? 'Свернуть стол' : 'Развернуть стол'} onClick={toggleFull}>
          {full ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
        </IconButton>
        {mySeat !== null && (
          <IconButton label="Встать из-за стола" onClick={() => command('durak.stand')}>
            <LogOut size={17} />
          </IconButton>
        )}
      </div>

      <GameTurn meeting={meeting} deadline={table.deadline} active={!!you?.turn} label={refusal || says} />
      {mySeat === null && table.seats.some((seat) => !seat.memberId) && (
        <button
          className="button primary game-seat-action"
          disabled={!table.seatingOpen}
          onClick={() => command('durak.sit')}
        >
          Сесть за стол
        </button>
      )}
      <div className="durak-table">
        <div className="durak-arena" ref={tableGeometry.ref}>
          {/*
          Сукно — оно же зона сброса «на стол».

          Одна зона на весь овал, а не аккуратный прямоугольник в центре: человек бросает карту
          примерно туда, куда смотрит, и промахнуться мимо стола он не должен.
        */}
          <div className="durak-felt" data-drop="table">
            <CardMotion meeting={meeting} events={table.visualEvents} spots={spots} />
            <Stock table={table} />
            <Discard count={table.discarded} />
            <div
              className="durak-mat"
              data-armed={!!drag || !!picked || undefined}
              onClick={picked ? () => place({ kind: 'table' }) : undefined}
            >
              {picked && (
                <button
                  className="button durak-place"
                  onClick={(event) => {
                    event.stopPropagation();
                    place({ kind: 'table' });
                  }}
                >
                  Положить на стол
                </button>
              )}
              {table.phase === 'bout' && (
                <div
                  className="durak-bout"
                  data-end={table.boutEnd ?? undefined}
                  style={{ '--bout-ms': `${BOUT_MS}ms` } as CSSProperties}
                >
                  {table.table.map((pair, index) => (
                    <div
                      className="durak-pair"
                      key={`${pair.attack}-${index}`}
                      data-drop="pair"
                      data-under={pair.attack}
                      data-open={(!pair.beat && !table.boutEnd) || undefined}
                    >
                      {picked ? (
                        <button
                          className="durak-attack"
                          onClick={(event) => {
                            event.stopPropagation();
                            place({ kind: 'beat', under: pair.attack });
                          }}
                          aria-label={`Побить ${faceOf(pair.attack).label}`}
                        >
                          <Card card={pair.attack} />
                        </button>
                      ) : (
                        <span className="durak-attack">
                          <Card card={pair.attack} />
                        </span>
                      )}
                      {pair.beat && (
                        <span className="durak-defence">
                          <Card card={pair.beat} />
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {table.phase !== 'bout' && (
                <div className="durak-center">
                  <p>
                    {table.phase === 'over'
                      ? 'Партия сыграна'
                      : seated < 2
                        ? 'Нужен ещё игрок'
                        : host
                          ? 'Все на местах'
                          : 'Ждём, пока раздадут'}
                  </p>
                  {host && seated >= 2 && (
                    <button className="button primary" onClick={() => command('durak.deal')}>
                      <Play size={17} /> Раздать
                    </button>
                  )}
                </div>
              )}
            </div>
            {spots.map((spot) => {
              const seat = table.seats.find((seat) => seat.index === spot.index)!;
              return (
                <Seat
                  key={seat.index}
                  seat={seat}
                  spot={spot}
                  table={table}
                  mine={seat.index === mySeat}
                  meeting={meeting}
                  tile={tracks.find((t) => t.participantId === seat.memberId && t.source === 'camera')}
                  avatar={snapshot.participants.find((p) => p.id === seat.memberId)?.avatar ?? null}
                />
              );
            })}
            {sheet === 'settings' && (
              <Settings table={table} host={host} onSend={command} onClose={() => setSheet(null)} />
            )}
            {sheet === 'result' && table.result && <Result table={table} onClose={() => setSheet(null)} />}
            {sheet === 'score' && <Score table={table} onClose={() => setSheet(null)} />}
          </div>
          {/*
          Рука лежит поверх сукна, у нижнего края: карты в руках человека, сидящего за столом, а
          не в полосе под ним. Отсюда их и тащат в центр — одним движением, без границы.
        */}
        </div>
        <div className="durak-hand-band">
          {handOverflow && (
            <button
              className="durak-hand-scroll is-left"
              aria-label="Карты левее"
              onClick={() => handScroller.current?.scrollBy({ left: -180 })}
            >
              ‹
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
              const face = faceOf(card);
              return (
                <button
                  key={card}
                  className="durak-hand-card"
                  data-held={drag?.card === card || undefined}
                  data-picked={picked === card || undefined}
                  disabled={!canPlay}
                  onClick={(event) => {
                    if (event.detail === 0) setPicked(picked === card ? null : card);
                  }}
                  onPointerDown={(event) => lift(card, event)}
                  onPointerMove={move}
                  onPointerUp={drop}
                  onPointerCancel={() => setDrag(null)}
                  aria-label={face.label}
                  style={
                    {
                      '--angle': `${angle}deg`,
                      '--lift': raise,
                      animationDuration: `${DEAL_MS}ms`,
                      animationDelay: `${index * DEAL_STEP_MS - Math.max(0, meeting.serverNow() - table.dealtAt)}ms`,
                    } as CSSProperties
                  }
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
              onClick={() => handScroller.current?.scrollBy({ left: 180 })}
            >
              ›
            </button>
          )}
        </div>
      </div>

      <Controls table={table} score={myScore} feed={<Feed table={table} />} onSend={command} />
      {/*
        Карта в полёте живёт вне стола: `position: fixed` и никакого `overflow`, который мог бы её
        обрезать. Нажатия она не ловит — иначе точка под пальцем читалась бы как сама карта.
      */}
      {drag && (
        <div
          className="durak-flying"
          style={
            {
              left: `${drag.x}px`,
              top: `${drag.y}px`,
              width: `${drag.width}px`,
              rotate: `${drag.angle}deg`,
            } as CSSProperties
          }
          aria-hidden="true"
        >
          <Card card={drag.card} />
        </div>
      )}
    </div>
  );
}

/**
 * Колода с козырной картой под ней.
 *
 * Главный ориентир стола: он отвечает сразу на два вопроса — какая масть козырная и сколько
 * осталось тянуть. Колода кончилась — козырь остаётся один и загорается: «козыри пошли» за столом
 * объявляют вслух, и здесь это видно без слов.
 */
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

/** Отбой: стопка, в которую больше никто не смотрит. Поэтому без подписи и небрежная. */
function Discard({ count }: { count: number }) {
  if (!count) return null;
  return (
    <div className="durak-discard" aria-label={`В отбое ${plural(count, 'карта', 'карты', 'карт')}`}>
      {Array.from({ length: Math.min(5, count) }, (_, index) => (
        <Card key={index} />
      ))}
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
function Card({ card }: { card?: string }) {
  const face = card ? faceOf(card) : null;
  return (
    <span className="durak-card" data-red={face?.red || undefined} data-back={!face || undefined}>
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

/** Место за столом: лицо, имя, роль в бою и сколько карт на руках. */
function Seat({
  seat,
  spot,
  table,
  mine,
  tile,
  avatar,
  meeting,
}: {
  meeting: Meeting;
  seat: DurakSeat;
  spot: { x: number; y: number; side: string };
  table: Table;
  mine?: boolean;
  tile?: MediaTile;
  avatar: string | null;
}) {
  const acting = table.acting.includes(seat.index);
  const style = { left: `${spot.x}%`, top: `${spot.y}%` } as CSSProperties;
  if (!seat.memberId) return null;
  const role = seat.fool
    ? 'дурак'
    : seat.out
      ? `вышел ${seat.place}-м`
      : seat.defender
        ? table.taking
          ? 'берёт'
          : 'отбивается'
        : seat.passed
          ? 'бито'
          : seat.attacker
            ? 'ходит'
            : '';
  return (
    <div
      className="durak-seat"
      data-game-seat={seat.index}
      data-side={spot.side}
      data-role={seat.defender ? 'defender' : seat.attacker ? 'attacker' : undefined}
      data-away={seat.away || undefined}
      data-out={seat.out || undefined}
      data-passed={seat.passed || undefined}
      data-mine={mine || undefined}
      data-acting={acting || undefined}
      style={style}
    >
      <DurakReactions meeting={meeting} table={table} seat={seat.index} mine={mine}>
        <span className="durak-seat-face">
          {acting && <TurnRing table={table} now={meeting.serverNow()} />}
          {tile ? <SeatCamera tile={tile} /> : <Avatar name={seat.name} src={avatar} />}
          {seat.held > 0 && <b className="durak-seat-count">{seat.held}</b>}
        </span>
      </DurakReactions>
      <span className="durak-seat-name" title={seat.name}>
        {mine ? `${seat.name} — вы` : seat.name}
      </span>
      <span className="durak-seat-role">{role}</span>
    </div>
  );
}

/**
 * Кольцо хода.
 *
 * Чистая CSS-анимация: длительность — всё время на ход, отрицательная задержка — сколько его уже
 * прошло. Ни одного кадра не считает JavaScript, и поэтому кольцо не дёргается, когда браузер
 * занят видео, и стоит в одном месте у всех шестерых.
 */
function TurnRing({ table, now }: { table: Table; now: number }) {
  const total = Math.max(1, table.deadline - table.actionAt);
  const elapsed = Math.max(0, now - table.actionAt);
  return (
    <svg className="durak-ring" viewBox="0 0 100 100" aria-hidden="true">
      <circle className="durak-ring-track" cx="50" cy="50" r="46" />
      <circle
        className="durak-ring-run"
        cx="50"
        cy="50"
        r="46"
        style={
          {
            animationDuration: `${total}ms`,
            animationDelay: `${-elapsed}ms`,
            '--turn-duration': `${total}ms`,
            '--turn-delay': `${-elapsed}ms`,
          } as CSSProperties
        }
      />
    </svg>
  );
}

/** Камера человека в кружке его места — та же дорожка, что в плитке встречи. */
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

/**
 * Две кнопки, и обе — про отказ ходить.
 *
 * «Беру» и «Бито» — единственное, чего нельзя сделать картой, поэтому только у них и есть кнопка.
 * Зайти, подкинуть, отбиться, перевести — это движение карты на стол.
 */
function Controls({
  table,
  score,
  feed,
  onSend,
}: {
  table: Table;
  score?: { games: number; fools: number };
  feed: React.ReactNode;
  onSend: (type: Parameters<Meeting['command']>[0], extra?: Parameters<Meeting['command']>[3]) => void;
}) {
  const you = table.you;
  return (
    <div className="durak-controls" data-turn={you?.turn || undefined}>
      <div className="durak-controls-side">{feed}</div>
      {you?.actions.includes('take') && (
        <button
          className="durak-act"
          data-kind="take"
          onClick={() => onSend('durak.act', { option: 'take' })}
        >
          Беру
        </button>
      )}
      {you?.actions.includes('pass') && (
        <button
          className="durak-act"
          data-kind="pass"
          onClick={() => onSend('durak.act', { option: 'pass' })}
        >
          Бито
        </button>
      )}
      <div className="durak-controls-side durak-controls-mine">
        {score && score.games > 0 && (
          <span className="durak-mine-score">
            {plural(score.games, 'партия', 'партии', 'партий')} · дурак {score.fools}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Счёт беседы у края стола.
 *
 * Одно число на человека — сколько раз он был дураком. Это то, что за столом и спрашивают, не
 * вставая; всё остальное живёт в истории, которую открывают, когда вечер кончился.
 */
function Scoreboard({ table, onOpen }: { table: Table; onOpen: () => void }) {
  if (table.score.length < 2) return null;
  return (
    <button className="durak-score" onClick={onOpen} aria-label="Счёт беседы">
      {table.score.slice(0, 4).map((row) => (
        <span key={row.name}>
          <i>{row.name}</i>
          <b>{row.fools}</b>
        </span>
      ))}
    </button>
  );
}

/** Счёт беседы целиком: та же таблица, но со всеми числами. */
function Score({ table, onClose }: { table: Table; onClose: () => void }) {
  return (
    <div className="durak-sheet" role="region" aria-label="Счёт беседы">
      <div className="durak-sheet-body">
        <div className="durak-sheet-row">
          <h3>Счёт беседы</h3>
          <IconButton label="Закрыть" onClick={onClose}>
            <X size={17} />
          </IconButton>
        </div>
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
      </div>
    </div>
  );
}

/**
 * Настройки стола и проверка раздачи.
 *
 * Внутри сцены, а не в панели справа, и роль здесь `region`, а не `dialog`: стол за спиной
 * продолжает играть, и уводить человека из-за него ради переключателя незачем.
 */
function Settings({
  table,
  host,
  onSend,
  onClose,
}: {
  table: Table;
  host: boolean;
  onSend: (type: Parameters<Meeting['command']>[0], extra?: Parameters<Meeting['command']>[3]) => void;
  onClose: () => void;
}) {
  const set = (option: string, chips?: number) => onSend('durak.settings', { option, chips });
  const live = table.phase === 'bout';
  return (
    <div className="durak-sheet" role="region" aria-label="Настройки стола">
      <div className="durak-sheet-body">
        <div className="durak-sheet-row">
          <h3>Стол</h3>
          <IconButton label="Закрыть" onClick={onClose}>
            <X size={17} />
          </IconButton>
        </div>
        {host ? (
          <>
            <div className="durak-sheet-row">
              <label>
                Колода
                <small>{live ? 'Меняется между партиями' : 'Без джокеров'}</small>
              </label>
              <div className="durak-choice">
                {[36, 52].map((size) => (
                  <button
                    key={size}
                    data-active={table.deckSize === size || undefined}
                    disabled={live}
                    onClick={() => set('deck', size)}
                  >
                    {size}
                  </button>
                ))}
              </div>
            </div>
            <div className="durak-sheet-row">
              <label>
                Правила
                <small>Первый кон не переводят</small>
              </label>
              <div className="durak-choice">
                <button
                  data-active={table.mode === 'podkidnoy' || undefined}
                  disabled={live}
                  onClick={() => set('rules', 0)}
                >
                  Подкидной
                </button>
                <button
                  data-active={table.mode === 'perevodnoy' || undefined}
                  disabled={live}
                  onClick={() => set('rules', 1)}
                >
                  Переводной
                </button>
              </div>
            </div>
            <div className="durak-sheet-row">
              <label>
                Подкидывают
                <small>За большим столом бой легче держать вдвоём</small>
              </label>
              <div className="durak-choice">
                <button data-active={!table.neighbours || undefined} onClick={() => set('neighbours')}>
                  Все
                </button>
                <button data-active={table.neighbours || undefined} onClick={() => set('neighbours')}>
                  Соседи
                </button>
              </div>
            </div>
            <div className="durak-sheet-row">
              <label>
                Первый бой
                <small>Поблажка заходящему</small>
              </label>
              <div className="durak-choice">
                <button data-active={!table.firstFive || undefined} onClick={() => set('first-five')}>
                  6 карт
                </button>
                <button data-active={table.firstFive || undefined} onClick={() => set('first-five')}>
                  5 карт
                </button>
              </div>
            </div>
            <div className="durak-sheet-row">
              <label>
                Секунд на ход
                <small>От 15 до 120</small>
              </label>
              <div className="durak-choice">
                {[20, 40, 60].map((seconds) => (
                  <button
                    key={seconds}
                    data-active={table.turnSeconds === seconds || undefined}
                    onClick={() => set('turn', seconds)}
                  >
                    {seconds}
                  </button>
                ))}
              </div>
            </div>
            <div className="durak-sheet-row">
              <label>
                Посадка
                <small>{table.seatingOpen ? 'Свободные места открыты' : 'Новых не пускаем'}</small>
              </label>
              <div className="durak-choice">
                <button data-active={table.seatingOpen || undefined} onClick={() => set('seating')}>
                  {table.seatingOpen ? 'Открыта' : 'Закрыта'}
                </button>
              </div>
            </div>
            <button className="button ghost full" onClick={() => onSend('durak.close')}>
              <X size={16} /> Убрать стол из встречи
            </button>
          </>
        ) : (
          <p className="form-footnote">Раздаёт и настраивает тот, кто принёс стол, и ведущий встречи.</p>
        )}
      </div>
    </div>
  );
}

/** Итог сыгранной партии. */
function Result({ table, onClose }: { table: Table; onClose: () => void }) {
  const result = table.result!;
  return (
    <div className="durak-sheet" role="region" aria-label="Итог партии">
      <div className="durak-sheet-body">
        <div className="durak-over" data-draw={result.draw || undefined}>
          <b>{result.draw ? 'Ничья' : `${result.foolName} — дурак`}</b>
          <span className="durak-hint">
            {plural(result.bouts, 'бой', 'боя', 'боёв')} ·{' '}
            {result.draw ? 'карт не осталось ни у кого' : 'карты кончились у всех, кроме одного'}
          </span>
          {result.places.length > 0 && (
            <ol className="durak-places">
              {result.places.map((name, index) => (
                <li key={`${name}-${index}`}>
                  <span>{index + 1}</span>
                  {name}
                </li>
              ))}
            </ol>
          )}
        </div>
        <button className="button primary full" onClick={onClose}>
          <Hand size={16} /> К столу
        </button>
      </div>
    </div>
  );
}

/**
 * Лента стола.
 *
 * Две последние строки, и не больше: за столом помнят последний ход и то, чем кончился прошлый
 * бой. Всё, что было раньше, обсуждают голосом — на то и встреча.
 */
function Feed({ table }: { table: Table }) {
  const notes = table.log.slice(-2);
  if (!notes.length) return null;
  return (
    <div className="durak-feed" aria-hidden="true">
      {notes.map((note, index) => (
        <span key={`${note.at}-${index}`}>{note.text}</span>
      ))}
    </div>
  );
}
