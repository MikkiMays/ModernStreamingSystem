import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { TrackEvent } from 'livekit-client';
import { Hand, LogOut, Maximize2, Minimize2, Play, Settings2, ShieldCheck, X } from 'lucide-react';
import type { Meeting } from '../core/meeting';
import type { DurakSeat, DurakTable as Table } from '../api/types';
import type { MediaTile } from '../media/session';
import { signal } from '../core/sounds';
import {
  BOUT_MS,
  DEAL_MS,
  DEAL_STEP_MS,
  faceOf,
  fanAngle,
  modeName,
  plural,
  roomLeft,
  seatLayout,
  tableSays,
  trumpName,
  verifyDeal,
  type Verdict,
} from '../core/durak';
import { useFullscreen } from '../core/fullscreen';
import { Avatar, IconButton, useStore } from './primitives';

/**
 * Стол дурака на сцене встречи.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Правил. Что законно нажать и — в отличие от покера — **какой картой**, решает
 * ядро и присылает готовым: `you.attacks`, `you.beats`, `you.transfers`. Здесь нет ни одной
 * строчки вида «бьёт ли дама валета»: карта, которую нельзя положить, просто не поднимается с
 * руки.
 *
 * ПОЧЕМУ ЗДЕСЬ ПОЧТИ НЕТ ТАЙМЕРОВ. Всё, что движется, — прилёт карт, кольцо хода, уход боя —
 * это CSS с длительностью из снимка и отрицательной задержкой, равной уже прошедшему времени.
 * Единственный настоящий таймер — секунды в подписи, и он не перерисовывает ничего вокруг.
 */
type SheetKind = 'settings' | 'result' | null;

export default function DurakTable({ meeting, table }: { meeting: Meeting; table: Table }) {
  const tracks = useStore(meeting.media.tracks);
  const snapshot = useStore(meeting.snapshot);
  const me = meeting.admission.participantId;
  const you = table.you;
  const mySeat = you ? you.seat : null;
  const spots = useMemo(() => seatLayout(mySeat), [mySeat]);
  const host = table.hostId === me || !!snapshot.participants.find((p) => p.id === me)?.owner;
  const [error, setError] = useState('');
  const [sheet, setSheet] = useState<SheetKind>(null);
  /*
    Выбранная карта — единственное состояние, которое браузер держит сам.

    Оно нужно ровно для одного случая: защитник выбрал карту, а побить ею можно две разные
    атаки. Тогда карта поднимается, подходящие атаки на столе обводятся, и второе нажатие
    выбирает цель. Во всех остальных случаях ход уходит с первого нажатия.
  */
  const [picked, setPicked] = useState<string | null>(null);

  const scene = useRef<HTMLDivElement>(null);
  const { full, toggle: toggleFull } = useFullscreen(scene);

  const send = (type: Parameters<Meeting['command']>[0], extra?: Parameters<Meeting['command']>[3]) => {
    setError('');
    setPicked(null);
    void meeting.command(type, undefined, undefined, extra).catch((e) => setError((e as Error).message));
  };

  // Карта, которой перестали быть должны, не должна оставаться поднятой.
  useEffect(() => {
    if (picked && !you?.cards.includes(picked)) setPicked(null);
  }, [picked, you?.cards]);

  /*
    Свой ход слышно. Человек за столом почти всегда занят ещё и разговором, и «ваш ход» без
    звука означает ход, проигранный по часам. Сигнал звучит один раз на ход: снимок приходит на
    каждое чужое действие, и без этой отметки он повторялся бы.
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

  const says = tableSays(table, mySeat);
  const alarm = table.boutEnd === 'taken' || (!!table.result && !table.result.draw);
  const seated = table.seats.filter((seat) => seat.memberId).length;
  const canPlay = table.phase === 'bout' && !table.boutEnd;
  /* Чем ещё можно побить — приходит списком «под какую карту»; здесь он только разворачивается. */
  const targetsFor = (card: string) =>
    (you?.beats ?? []).filter((beat) => beat.cards.includes(card)).map((beat) => beat.under);

  const playCard = (card: string) => {
    if (!you || !canPlay) return;
    const targets = targetsFor(card);
    const transferable = you.transfers.includes(card);
    // Одно нажатие там, где выбор один. Второе — только когда его действительно два.
    if (targets.length === 1 && !transferable) {
      send('durak.act', { option: 'beat', card, under: targets[0]! });
      return;
    }
    if (!targets.length && !transferable && you.attacks.includes(card)) {
      send('durak.act', { option: 'attack', card });
      return;
    }
    setPicked(picked === card ? null : card);
  };

  const legal = (card: string) =>
    !!you &&
    canPlay &&
    (you.attacks.includes(card) || !!targetsFor(card).length || you.transfers.includes(card));

  const pickedTargets = picked ? targetsFor(picked) : [];

  return (
    <div className="durak" ref={scene} data-phase={table.phase} data-bout={table.boutEnd ?? undefined}>
      <div className="durak-bar">
        <div className="durak-mode">
          <b>{modeName(table.mode)} дурак</b>
          <small>
            {table.deckSize} карт{table.trumpSuit ? ` · козыри ${trumpName(table)}` : ''} ·{' '}
            {table.turnSeconds} с на ход
          </small>
        </div>
        <span className="durak-says" data-alarm={alarm || undefined} role="status">
          {says}
        </span>
        <span className="durak-bar-spacer" />
        {host && table.phase !== 'bout' && (
          <button className="button primary" onClick={() => send('durak.deal')}>
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
          <IconButton label="Встать из-за стола" onClick={() => send('durak.stand')}>
            <LogOut size={17} />
          </IconButton>
        )}
      </div>

      <div className="durak-table">
        <div className="durak-felt">
          <Stock table={table} />
          <Discard count={table.discarded} />
          {table.phase === 'bout' && (
            <div
              className="durak-bout"
              data-end={table.boutEnd ?? undefined}
              style={{ '--bout-ms': `${BOUT_MS}ms` } as CSSProperties}
            >
              {table.table.map((pair, index) => {
                const target = pickedTargets.includes(pair.attack);
                return (
                  <div
                    className="durak-pair"
                    key={`${pair.attack}-${index}`}
                    data-open={(!pair.beat && !table.boutEnd) || undefined}
                    data-target={target || undefined}
                    data-dim={(!!picked && !target && !pair.beat) || undefined}
                  >
                    {target ? (
                      <button
                        className="durak-attack"
                        onClick={() =>
                          send('durak.act', { option: 'beat', card: picked!, under: pair.attack })
                        }
                        aria-label={`Побить ${faceOf(pair.attack).label} картой ${faceOf(picked!).label}`}
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
                );
              })}
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
                      ? 'Все на местах — можно раздавать'
                      : 'Ждём, пока раздадут'}
              </p>
              {host && seated >= 2 && (
                <button className="button primary" onClick={() => send('durak.deal')}>
                  <Play size={17} /> Раздать
                </button>
              )}
            </div>
          )}
          {/*
            Своё место на сукне не рисуется вовсе: им стала рука внизу. Кружок с собственным
            лицом стоит рядом с веером, в полосе под столом, — иначе он ложится прямо на свои же
            карты и уезжает за нижний край.
          */}
          {table.seats.map((seat, index) =>
            index === mySeat ? null : (
              <Seat
                key={index}
                seat={seat}
                spot={spots[index]!}
                table={table}
                mine={false}
                tile={tracks.find((t) => t.participantId === seat.memberId && t.source === 'camera')}
                avatar={snapshot.participants.find((p) => p.id === seat.memberId)?.avatar ?? null}
                onSit={mySeat === null ? () => send('durak.sit', { seat: index }) : undefined}
              />
            ),
          )}
          <Feed table={table} />
          {sheet === 'settings' && (
            <Settings table={table} host={host} onSend={send} onClose={() => setSheet(null)} />
          )}
          {sheet === 'result' && table.result && <Result table={table} onClose={() => setSheet(null)} />}
        </div>
      </div>

      <div className="durak-mine">
        {mySeat !== null && (
          <MySeat
            seat={table.seats[mySeat]!}
            table={table}
            tile={tracks.find((t) => t.participantId === me && t.source === 'camera')}
            avatar={snapshot.participants.find((p) => p.id === me)?.avatar ?? null}
          />
        )}
        <div className="durak-hand" aria-label="Ваши карты">
          {you?.cards.map((card, index) => {
            const { angle, lift } = fanAngle(index, you.cards.length);
            const face = faceOf(card);
            const usable = legal(card);
            return (
              <button
                key={card}
                className="durak-hand-card"
                data-legal={usable}
                data-picked={picked === card || undefined}
                data-trump={face.suit === table.trumpSuit || undefined}
                disabled={!usable}
                onClick={() => playCard(card)}
                aria-label={`${face.label}${usable ? '' : ' — сейчас не ходит'}`}
                style={
                  {
                    '--angle': `${angle}deg`,
                    '--lift': lift,
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
        <Controls
          table={table}
          picked={picked}
          onSend={send}
          onSit={mySeat === null ? undefined : () => undefined}
        />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Колода с козырной картой под ней.
 *
 * Это главный ориентир стола, и он отвечает сразу на два вопроса: какая масть козырная и сколько
 * осталось тянуть. Когда колода кончилась, козырь остаётся один и загорается — «козыри пошли»
 * за столом объявляют вслух, и здесь это видно без слов.
 */
function Stock({ table }: { table: Table }) {
  // Козыря нет — значит, и раздачи не было: пустой стол не должен объявлять «колода пуста».
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
        <small>{table.deckLeft === 0 ? 'колода пуста' : 'в колоде'}</small>
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

/** Карта. Без аргумента — рубашка: так переворот остаётся одним элементом. */
function Card({ card }: { card?: string }) {
  const face = card ? faceOf(card) : null;
  return (
    <span className="durak-card" data-red={face?.red || undefined} data-back={!face || undefined}>
      {face && (
        <>
          <b className="durak-card-rank">{face.rank}</b>
          <i className="durak-card-suit">{face.glyph}</i>
          <u className="durak-card-pip">{face.glyph}</u>
        </>
      )}
    </span>
  );
}

/**
 * Своё место — рядом с рукой, а не на сукне.
 *
 * Здесь только то, чего не видно по собственным картам: лицо (та же дорожка, что в плитке
 * встречи), имя и роль в бою. Кольцо хода горит тут же — «ваш ход» должно быть видно, не
 * поднимая глаз от веера.
 */
function MySeat({
  seat,
  table,
  tile,
  avatar,
}: {
  seat: DurakSeat;
  table: Table;
  tile?: MediaTile;
  avatar: string | null;
}) {
  const acting = table.acting.includes(seat.index);
  return (
    <div
      className="durak-seat durak-seat-own"
      data-mine="true"
      data-role={seat.defender ? 'defender' : seat.attacker ? 'attacker' : undefined}
      data-out={seat.out || undefined}
    >
      <span className="durak-seat-face">
        {acting && <TurnRing table={table} />}
        {tile ? <SeatCamera tile={tile} /> : <Avatar name={seat.name} src={avatar} />}
      </span>
      <span className="durak-seat-name">{seat.name} — вы</span>
      <span className="durak-seat-role">
        {seat.fool
          ? 'дурак'
          : seat.out
            ? `вышли ${seat.place}-м`
            : seat.defender
              ? table.taking
                ? 'берёте'
                : 'отбиваетесь'
              : seat.passed
                ? 'бито'
                : seat.attacker
                  ? 'ходите'
                  : ''}
      </span>
    </div>
  );
}

/** Место за столом: человек, его роль в бою и рубашки его карт. */
function Seat({
  seat,
  spot,
  table,
  mine,
  tile,
  avatar,
  onSit,
}: {
  seat: DurakSeat;
  spot: { x: number; y: number; side: string };
  table: Table;
  mine: boolean;
  tile?: MediaTile;
  avatar: string | null;
  onSit?: () => void;
}) {
  const acting = table.acting.includes(seat.index);
  const role = seat.defender ? 'defender' : seat.attacker ? 'attacker' : undefined;
  const style = { left: `${spot.x}%`, top: `${spot.y}%` } as CSSProperties;
  if (!seat.memberId) {
    return (
      <div className="durak-seat is-empty" data-side={spot.side} style={style}>
        {/*
          Пустое место — это круг, а не надпись в воздухе. Без него «свободно» висело посреди
          сукна, ни к чему не привязанное, и дуга не читалась как шесть мест.
        */}
        <span className="durak-seat-face durak-seat-free" aria-hidden="true" />
        {onSit ? (
          <button className="durak-sit" onClick={onSit}>
            Сесть
          </button>
        ) : (
          <span className="durak-seat-role">свободно</span>
        )}
      </div>
    );
  }
  return (
    <div
      className="durak-seat"
      data-side={spot.side}
      data-role={role}
      data-away={seat.away || undefined}
      data-out={seat.out || undefined}
      data-passed={seat.passed || undefined}
      data-mine={mine || undefined}
      style={style}
    >
      <span className="durak-seat-face">
        {acting && <TurnRing table={table} />}
        {tile ? <SeatCamera tile={tile} /> : <Avatar name={seat.name} src={avatar} />}
        {/*
          Число карт на кружке — не дубль рубашек, а ответ на телефоне, где рубашек нет.
          «Сколько у него осталось» — главный вопрос второй половины партии, и считать веер
          из восьми полосок глазами никто не станет.
        */}
        {seat.held > 0 && <b className="durak-seat-count">{seat.held}</b>}
      </span>
      <span className="durak-seat-name">
        {seat.name}
        {mine ? ' — вы' : ''}
      </span>
      <span className="durak-seat-role">
        {seat.fool
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
                  : ''}
      </span>
      {!mine && (
        <span className="durak-seat-hand" aria-hidden="true">
          {Array.from({ length: Math.min(8, seat.held) }, (_, index) => (
            <Card key={index} />
          ))}
        </span>
      )}
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
function TurnRing({ table }: { table: Table }) {
  const total = Math.max(1, table.deadline - table.actionAt);
  const elapsed = Math.max(0, Date.now() - table.actionAt);
  return (
    <svg className="durak-ring" viewBox="0 0 100 100" aria-hidden="true">
      <circle className="durak-ring-track" cx="50" cy="50" r="46" />
      <circle
        className="durak-ring-run"
        cx="50"
        cy="50"
        r="46"
        style={{ animationDuration: `${total}ms`, animationDelay: `${-elapsed}ms` }}
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

/** Кнопки хода. Что здесь законно — прислало ядро; здесь только подписи. */
function Controls({
  table,
  picked,
  onSend,
}: {
  table: Table;
  picked: string | null;
  onSend: (type: Parameters<Meeting['command']>[0], extra?: Parameters<Meeting['command']>[3]) => void;
  onSit?: () => void;
}) {
  const you = table.you;
  if (!you) return <p className="durak-hint">Вы смотрите игру. Сядьте за свободное место, чтобы играть.</p>;
  const actions = you.actions;
  const canTransfer = !!picked && you.transfers.includes(picked);
  const left = roomLeft(table);
  return (
    <div className="durak-controls" data-turn={you.turn || undefined}>
      {actions.includes('take') && (
        <button
          className="durak-act"
          data-kind="take"
          onClick={() => onSend('durak.act', { option: 'take' })}
        >
          Беру
        </button>
      )}
      {canTransfer && (
        <button
          className="durak-act"
          data-kind="transfer"
          onClick={() => onSend('durak.act', { option: 'transfer', card: picked! })}
        >
          Перевести {faceOf(picked!).rank}
          {faceOf(picked!).glyph}
        </button>
      )}
      {actions.includes('pass') && (
        <button
          className="durak-act"
          data-kind="pass"
          onClick={() => onSend('durak.act', { option: 'pass' })}
        >
          Бито
        </button>
      )}
      {picked && !canTransfer && <span className="durak-hint">Выберите карту на столе, которую бьёте</span>}
      {!picked && actions.includes('attack') && table.table.length > 0 && left > 0 && (
        <span className="durak-hint">Можно подкинуть ещё {plural(left, 'карту', 'карты', 'карт')}</span>
      )}
    </div>
  );
}

/**
 * Настройки стола и проверка раздачи.
 *
 * ВНУТРИ СЦЕНЫ, А НЕ В ПАНЕЛИ СПРАВА, и роль здесь `region`, а не `dialog`: стол за спиной
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
                <small>Перевод — картой того же номинала</small>
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
        <Fairness table={table} />
      </div>
    </div>
  );
}

/**
 * Проверка раздачи.
 *
 * Стол объявляет отпечаток колоды <b>до</b> раздачи и показывает зерно после. Здесь колода
 * собирается заново прямо в браузере и сверяется с тем, что лежало на столе. Кнопка, которая
 * ничего не меняет, но отвечает на вопрос «а не подсуживает ли сервер».
 */
function Fairness({ table }: { table: Table }) {
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  return (
    <div className="durak-sheet-row">
      <label>
        Честность раздачи
        <small>
          {verdict
            ? verdict.state === 'ok'
              ? `Колода из ${verdict.cards} карт сошлась с обещанной`
              : verdict.reason
            : 'Отпечаток объявлен до раздачи'}
        </small>
      </label>
      <button className="durak-act" onClick={() => void verifyDeal(table).then(setVerdict)}>
        <ShieldCheck size={16} /> Проверить
      </button>
    </div>
  );
}

/** Итог партии: крупно тот, кто проиграл, и порядок, в котором выходили остальные. */
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
 * Три последние строки, и не больше: за столом помнят последний ход и то, чем кончился прошлый
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
