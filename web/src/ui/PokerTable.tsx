import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Track, TrackEvent } from 'livekit-client';
import { Menu } from '@base-ui/react/menu';
import {
  Check,
  Coins,
  Crown,
  Hand,
  LogOut,
  Pause,
  Play,
  Plus,
  ListOrdered,
  ScrollText,
  Settings2,
  ShieldCheck,
  Timer,
  TrendingUp,
  Trophy,
  X,
  Zap,
} from 'lucide-react';
import type { Meeting } from '../core/meeting';
import type { PokerAction, PokerSeat, PokerTable as Table } from '../api/types';
import type { MediaTile } from '../media/session';
import { signal } from '../core/sounds';
import { isTyping } from '../core/hotkeys';
import {
  actionLabel,
  betSpot,
  betSteps,
  blindSeats,
  callShare,
  cardFace,
  celebration,
  chipColumns,
  chipPile,
  chips,
  COLLECT_MS,
  COLUMN_HEIGHT,
  DEAL_MS,
  deadCards,
  dealDelay,
  HAND_RANKS,
  phaseLabel,
  playing,
  seatLayout,
  verifyDeal,
  type SeatSpot,
  type Verdict,
} from '../core/poker';
import { GameResult, GameCrown } from './PokerResult';
import { readPreferences, savePreferences } from '../core/preferences';
import { Avatar, useStore } from './primitives';

/**
 * Покерный стол на сцене встречи.
 *
 * ПОЧЕМУ ЗДЕСЬ ПОЧТИ НЕТ ТАЙМЕРОВ. Всё, что движется, — раздача карт, кольцо хода, обратный отсчёт
 * до следующей раздачи — считается от **серверных меток** в снимке: когда началась раздача, когда
 * начался ход, когда он кончится. Анимация запускается с отрицательной задержкой, равной уже
 * прошедшему времени, поэтому у десяти человек карты летят в один и тот же момент, а тот, кто
 * открыл вкладку в середине раздачи, видит их уже на местах, а не заново. Ни одного сообщения
 * «начать анимацию» в комнату не отправляется — их и нечем было бы синхронизировать.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Правил. Что законно нажать, сколько стоит повышение и кто выиграл — решает
 * ядро и присылает готовым ({@code you.actions}). Вторая копия правил в браузере означала бы, что
 * однажды кнопка и стол разойдутся во мнениях, и права будет кнопка.
 */
export default function PokerTable({ meeting, table }: { meeting: Meeting; table: Table }) {
  const tracks = useStore(meeting.media.tracks);
  const preferences = useStore(meeting.media.preferences);
  const snapshot = useStore(meeting.snapshot);
  const me = meeting.admission.participantId;
  const you = table.you;
  const mySeat = you ? you.seat : null;
  const spots = useMemo(() => seatLayout(mySeat), [mySeat]);
  const dealer = table.hostId === me || !!snapshot.participants.find((p) => p.id === me)?.owner;
  const cheer = celebration(table.result);
  const [error, setError] = useState('');
  /*
    Шпаргалка и итоги живут ЗДЕСЬ, внутри сцены, а не в панели справа.

    Раньше «комбинации» уводили в панель интеграций: человек за столом нажимал кнопку и
    оказывался в другом месте приложения, рядом с настройками музыки, — а стол в этот момент
    продолжал играть без него. Обе панели полупрозрачные и лежат поверх сукна: они закрывают
    часть стола, но не забирают его.
  */
  const [help, setHelp] = useState(false);
  const [results, setResults] = useState(false);
  const summary = table.summary;
  // Игра кончилась — итоги открываются сами: это тот единственный момент, когда их и ждут.
  const shown = useRef('');
  useEffect(() => {
    if (!summary || shown.current === summary.id) return;
    shown.current = summary.id;
    setResults(true);
  }, [summary]);

  const send = (type: Parameters<Meeting['command']>[0], extra?: Parameters<Meeting['command']>[3]) => {
    setError('');
    void meeting.command(type, undefined, undefined, extra).catch((e) => setError((e as Error).message));
  };

  /*
    Свой ход слышно. Человек за столом почти всегда занят чем-то ещё — разговором, чужой
    камерой, — и «ваш ход» без звука означает ход, проигранный по часам. Сигнал звучит один раз
    на ход: снимок приходит на каждое чужое действие, и без этой отметки он бы повторялся.
  */
  const announced = useRef(0);
  useEffect(() => {
    if (!you?.turn) return;
    if (announced.current === table.actionAt) return;
    announced.current = table.actionAt;
    signal('turn');
  }, [you?.turn, table.actionAt]);

  const celebrated = useRef(0);
  useEffect(() => {
    const result = table.result;
    if (!result || celebrated.current === result.at) return;
    celebrated.current = result.at;
    if (mySeat !== null && result.awards.some((award) => award.seat === mySeat)) signal('win');
  }, [table.result, mySeat]);

  // Фишки, летящие по столу: в банк в конце круга и из банка победителю. Считать их можно
  // только по разнице снимков — в новом ставок уже нет, а в старом ещё нет победителя.
  const flights = useChipFlights(table, spots);
  /*
    Что на вскрытии уже не играет. За настоящим столом лишние карты не подсвечивают — их
    убирают из виду и называют комбинацию вслух; здесь они гаснут, и смотреть остаётся ровно
    на то, чем выиграли.
  */
  const dead = useMemo(() => deadCards(table), [table]);
  const blinds = useMemo(() => blindSeats(table), [table]);
  const showdown = table.phase === 'showdown';
  const winners = useMemo(
    () => new Set((table.result?.awards ?? []).map((award) => award.seat)),
    [table.result],
  );
  const pot =
    showdown && table.result
      ? table.result.pot
      : table.pot + table.seats.reduce((sum, seat) => sum + seat.bet, 0);
  const beat = usePotBeat(pot);

  return (
    <div className="poker" data-phase={table.phase} data-drama={cheer?.level}>
      <TableBar
        meeting={meeting}
        table={table}
        dealer={dealer}
        onSend={send}
        help={help}
        onHelp={() => setHelp((open) => !open)}
        results={!!summary}
        onResults={() => setResults(true)}
      />
      <div className="poker-felt-wrap">
        <div className="poker-felt">
          {/* Борт, дорожка и сукно — три слоя одного стола, как у настоящего. */}
          <div className="poker-rail" aria-hidden="true" />
          <div className="poker-cloth" aria-hidden="true">
            {/*
              Знак заведения на сукне — и заведение здесь одно, Cord. Те же три полосы и то же
              слово, что в шапке приложения, только вытканные в зелень: видно, что раздача идёт
              на своём столе, а не на картинке из интернета. Выше него не ложится ничего, кроме
              карт и фишек, — потому он и приглушён до тени.
            */}
            <span className="poker-mark">
              <i />
              <i />
              <i />
              <em>cord</em>
            </span>
          </div>
          <div className="poker-line" aria-hidden="true" />
          {playing(table) && <span className="poker-deck" aria-hidden="true" />}
          <div className="poker-center">
            <div className="poker-board" aria-label="Карты стола">
              {table.board.map((card, index) => (
                <PlayingCard
                  key={`${table.handNumber}-${card}`}
                  card={card}
                  dead={dead.has(card)}
                  highlight={showdown && !dead.has(card)}
                  delay={index * 120 - Math.max(0, meeting.serverNow() - table.streetAt)}
                />
              ))}
            </div>
            <div className="poker-pot-line">
              {/*
                Банк растёт на глазах. Ключ здесь — не оптимизация, а наоборот: он нарочно
                пересобирает пилюлю банка на каждом приросте, и CSS проигрывает толчок заново.
                Без него банк молча менял число, и «мои фишки уехали в банк» приходилось
                достраивать в уме.
              */}
              {pot > 0 && (
                <span className="poker-pot" key={beat}>
                  <ChipColumns amount={pot} columns={4} size={11} />
                  <b>{chips(pot)}</b>
                </span>
              )}
              {/*
                Побочные банки показываются только тогда, когда они и правда есть: пока никто
                не пошёл ва-банк, «побочным» выглядел бы обычный неуравненный блайнд, и стол
                рассказывал бы про сложность, которой в нём нет.
              */}
              {table.pots.length > 1 && table.seats.some((seat) => seat.allIn) && (
                <span className="poker-sidepots">
                  {table.pots.map((side, index) => (
                    <b key={index}>
                      {index === 0 ? 'Основной' : `Побочный ${index}`} {chips(side.amount)}
                    </b>
                  ))}
                </span>
              )}
              <span className="poker-street">{phaseLabel(table.phase)}</span>
            </div>
            {/* Пауза посреди раздачи: часы стоят, ходить нельзя — и это должно быть видно. */}
            {table.paused && playing(table) && (
              <div className="poker-waiting is-paused" role="status">
                <Pause size={18} /> <b>Пауза</b>
                <small>Часы остановлены</small>
              </div>
            )}
            <Waiting
              meeting={meeting}
              table={table}
              dealer={dealer}
              onSend={send}
              onResults={() => setResults(true)}
            />
            {/*
              Срок пустого стола — вслух.

              Стол, за которым десять минут никого, заканчивает игру сам, и исчезнуть без
              предупреждения он не вправе: это выглядело бы как потерянная игра, а не как уборка.
              Число приезжает в снимке, поэтому у всех оно одно и то же.
            */}
            {table.closesAt > 0 && !playing(table) && (
              <span className="poker-linger" role="status">
                За столом никого: игра закончится через{' '}
                <Countdown meeting={meeting} until={table.closesAt} minutes />. Сядьте за стол, и отсчёт
                остановится.
              </span>
            )}
          </div>
          {spots.map((spot) => {
            const seat = table.seats[spot.index];
            if (!seat) return null;
            return (
              <SeatView
                key={spot.index}
                spot={spot}
                seat={seat}
                table={table}
                meeting={meeting}
                tracks={tracks}
                dead={dead}
                blind={blinds?.small === spot.index ? 'SB' : blinds?.big === spot.index ? 'BB' : null}
                winner={winners.has(spot.index)}
                mine={spot.index === mySeat}
                avatar={snapshot.participants.find((p) => p.id === seat.memberId)?.avatar ?? null}
                onSit={() => send('poker.sit', { seat: spot.index })}
              />
            );
          })}
          {flights.map((flight) => (
            <span
              key={`${flight.batch}-${flight.id}`}
              className="poker-flight"
              style={
                {
                  '--fx': `${flight.from.x}%`,
                  '--fy': `${flight.from.y}%`,
                  '--tx': `${flight.to.x}%`,
                  '--ty': `${flight.to.y}%`,
                  animationDelay: `${flight.delay}ms`,
                } as CSSProperties
              }
              aria-hidden="true"
            >
              <i style={{ background: flight.tone }} />
            </span>
          ))}
          {/*
            Свет гаснет на всём, кроме выигравшего. Это и есть «вскрытие»: смотреть в этот
            момент нужно на две карты и на пять, а не на десять кружков по кругу.
          */}
          {showdown && <div className="poker-dim" aria-hidden="true" />}
          {cheer && table.result && <Cheer table={table} cheer={cheer} spots={spots} />}
        </div>
        {preferences.pokerFeed && <Feed table={table} />}
        {help && <Combinations onClose={() => setHelp(false)} />}
        {results && summary && <Results game={summary} onClose={() => setResults(false)} />}
      </div>
      <Controls table={table} dealer={dealer} onSend={send} error={error} hints={preferences.pokerHints} />
    </div>
  );
}

/**
 * Фишки суммой, а не числом.
 *
 * ПОЧЕМУ СТОЛБИКИ, А НЕ ОДНА СТОПКА. Стопка отвечает на «сколько фишек», а за столом спрашивают
 * «сколько денег»: пять единиц — это пять белых кружков, пять тысяч — не пять тысяч кружков, а
 * жёлтый номинал в две стопки. Размен считает {@link chipColumns}, здесь остаётся только рисование:
 * столбик на номинал, не выше {@link COLUMN_HEIGHT} дисков, а сколько их там на самом деле —
 * подписывается числом. Точная сумма всё равно стоит рядом цифрами, поэтому врать этим нельзя.
 */
function ChipColumns({ amount, columns = 3, size = 7 }: { amount: number; columns?: number; size?: number }) {
  const piles = useMemo(() => chipColumns(amount, columns), [amount, columns]);
  if (!piles.length) return null;
  return (
    <span className="chip-columns" style={{ '--chip': `${size}px` } as CSSProperties} aria-hidden="true">
      {piles.map((pile) => (
        <i key={pile.value} data-count={pile.count > COLUMN_HEIGHT ? pile.count : undefined}>
          {Array.from({ length: Math.min(pile.count, COLUMN_HEIGHT) }, (_, index) => (
            <b key={index} style={{ background: pile.tone, bottom: `calc(var(--chip) * ${index * 0.26})` }} />
          ))}
        </i>
      ))}
    </span>
  );
}

/**
 * Толчок банка при каждом приросте.
 *
 * Считается по разнице снимков: в самом снимке «банк вырос» не написано, а без этого банк молча
 * менял число — фишки улетали в середину стола, и там ничего не происходило.
 */
function usePotBeat(pot: number): number {
  const [beat, setBeat] = useState(0);
  const previous = useRef(pot);
  useEffect(() => {
    if (pot > previous.current) setBeat((count) => count + 1);
    previous.current = pot;
  }, [pot]);
  return beat;
}

/** Верхняя полоса: чем играем, какие блайнды и что может сделать раздающий. */
function TableBar({
  meeting,
  table,
  dealer,
  onSend,
  help,
  onHelp,
  results,
  onResults,
}: {
  meeting: Meeting;
  table: Table;
  dealer: boolean;
  onSend: (type: Parameters<Meeting['command']>[0], extra?: Parameters<Meeting['command']>[3]) => void;
  help: boolean;
  onHelp: () => void;
  results: boolean;
  onResults: () => void;
}) {
  const seated = table.seats.filter((seat) => seat.memberId).length;
  const preferences = useStore(meeting.media.preferences);
  // Вид стола — своё у каждого, поэтому пишется в настройки устройства, а не в комнату.
  const toggle = (key: 'pokerHints' | 'pokerFeed') =>
    savePreferences({ ...readPreferences(), [key]: !preferences[key] });
  return (
    <header className="poker-bar">
      <span className="poker-mode">
        <b>{table.modeName}</b>
        <small>
          Блайнды {chips(table.smallBlind)}/{chips(table.bigBlind)}
          {table.ante > 0 && ` · анте ${chips(table.ante)}`}
          {table.handNumber > 0 && ` · раздача №${table.handNumber}`}
        </small>
      </span>
      {table.levelUpAt > 0 && table.phase !== 'over' && (
        <span className="poker-level" title="Когда вырастут блайнды">
          <TrendingUp size={14} /> Уровень {table.level} ·{' '}
          <Countdown meeting={meeting} until={table.levelUpAt} />
        </span>
      )}
      <span className="poker-seated">
        {seated} из 10 мест{table.seatingOpen ? '' : ' · посадка закрыта'}
      </span>
      <Menu.Root>
        <Menu.Trigger className="button secondary small poker-view" aria-label="Вид стола">
          <Settings2 size={15} /> Вид
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner className="menu-layer" side="bottom" align="end" sideOffset={8}>
            <Menu.Popup className="action-menu">
              <Menu.Item onClick={() => toggle('pokerHints')}>
                {preferences.pokerHints ? <Check size={18} /> : <span style={{ width: 18 }} />}
                Подсказки: что у меня собралось
              </Menu.Item>
              <Menu.Item onClick={() => toggle('pokerFeed')}>
                {preferences.pokerFeed ? <Check size={18} /> : <ScrollText size={18} />}
                Лента игры
              </Menu.Item>
              <Menu.Item onClick={onHelp}>
                {help ? <Check size={18} /> : <ListOrdered size={18} />}
                Комбинации
              </Menu.Item>
              {results && (
                <Menu.Item onClick={onResults}>
                  <Trophy size={18} /> Итоги игры
                </Menu.Item>
              )}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {dealer && (
        <div className="poker-host-actions">
          {table.phase === 'lobby' && (
            <button
              className="button primary small"
              disabled={seated < 2}
              onClick={() => onSend('poker.deal')}
            >
              <Play size={15} /> Раздать
            </button>
          )}
          {table.phase !== 'over' && (
            <button
              className="button secondary small"
              onClick={() => onSend('poker.settings', { option: table.paused ? 'resume' : 'pause' })}
            >
              {table.paused ? <Play size={15} /> : <Pause size={15} />}
              {table.paused ? 'Продолжить' : 'Пауза'}
            </button>
          )}
          <button
            className="button secondary small"
            onClick={() =>
              onSend('poker.settings', {
                option: table.seatingOpen ? 'seating-locked' : 'seating-open',
              })
            }
          >
            {table.seatingOpen ? 'Закрыть посадку' : 'Открыть посадку'}
          </button>
          <button className="button ghost small" onClick={() => onSend('poker.close')}>
            <X size={15} /> Убрать стол
          </button>
        </div>
      )}
    </header>
  );
}

/** Что стол говорит, когда карты не раздаются: кого ждём и сколько. */
function Waiting({
  meeting,
  table,
  dealer,
  onSend,
  onResults,
}: {
  meeting: Meeting;
  table: Table;
  dealer: boolean;
  onSend: (type: Parameters<Meeting['command']>[0], extra?: Parameters<Meeting['command']>[3]) => void;
  onResults: () => void;
}) {
  if (table.phase === 'over') {
    const winner = table.seats.find((seat) => seat.place === 1);
    return (
      <div className="poker-waiting is-over" role="status">
        <Crown size={22} />
        <b>{winner ? `${winner.name} забирает всё` : 'Игра окончена'}</b>
        <button className="button secondary small" onClick={onResults}>
          <Trophy size={15} /> Итоги игры
        </button>
        {dealer && (
          <button
            className="button primary small"
            onClick={() => {
              onSend('poker.close');
              setTimeout(() => onSend('poker.open', { option: table.mode, chips: table.startingStack }), 250);
            }}
          >
            Собрать заново
          </button>
        )}
      </div>
    );
  }
  if (table.phase !== 'lobby') return null;
  const ready = table.seats.filter((seat) => seat.memberId && seat.stack > 0 && !seat.away).length;
  return (
    <div className="poker-waiting" role="status">
      {table.paused ? (
        <>
          <Pause size={18} /> <b>Пауза</b>
          <small>Раздающий остановил игру</small>
        </>
      ) : ready < 2 ? (
        <>
          <Hand size={18} /> <b>Нужен ещё игрок</b>
          <small>Займите место за столом — кнопки на свободных стульях</small>
        </>
      ) : table.deadline > 0 ? (
        <>
          <Timer size={18} />{' '}
          <b>
            Раздаём через <Countdown meeting={meeting} until={table.deadline} />
          </b>
        </>
      ) : (
        <>
          <Hand size={18} /> <b>Ждём раздающего</b>
        </>
      )}
    </div>
  );
}

/** Место за столом: человек, его фишки, карты и ставка. */
function SeatView({
  spot,
  seat,
  table,
  meeting,
  tracks,
  dead,
  blind,
  winner,
  mine,
  avatar,
  onSit,
}: {
  spot: SeatSpot;
  seat: PokerSeat;
  table: Table;
  meeting: Meeting;
  tracks: MediaTile[];
  dead: Set<string>;
  blind: 'SB' | 'BB' | null;
  winner: boolean;
  mine: boolean;
  avatar: string | null;
  onSit: () => void;
}) {
  const active = table.actor === seat.index && playing(table);
  const camera = tracks.find(
    (tile) => tile.participantId === seat.memberId && tile.source === Track.Source.Camera && !tile.muted,
  );
  const speaking = useStore(meeting.media.speaking).includes(seat.memberId ?? '');
  // Откуда прилетают карты: из середины стола. Направление — вектор к центру, в долях ширины
  // стола (высоту из него пересчитывает CSS через `--felt-ratio`).
  const style = {
    left: `${spot.x}%`,
    top: `${spot.y}%`,
    '--dx': 50 - spot.x,
    '--dyp': 50 - spot.y,
  } as CSSProperties;
  if (!seat.memberId)
    return (
      <div className="poker-seat is-empty" style={style} data-side={spot.side}>
        <button className="poker-sit" onClick={onSit} disabled={!table.seatingOpen}>
          <Plus size={16} />
          <span>{table.seatingOpen ? 'Сесть' : 'Закрыто'}</span>
        </button>
      </div>
    );
  const won = table.result?.awards.filter((award) => award.seat === seat.index) ?? [];
  const showdown = table.phase === 'showdown';
  return (
    <div
      className="poker-seat"
      style={style}
      data-side={spot.side}
      data-active={active || undefined}
      data-folded={seat.folded || undefined}
      data-allin={seat.allIn || undefined}
      data-busted={seat.busted || undefined}
      data-away={seat.away || undefined}
      data-waiting={seat.waiting || undefined}
      data-winner={winner || undefined}
      data-speaking={speaking || undefined}
      data-mine={mine || undefined}
    >
      <div className="poker-person">
        <div className="poker-face">
          {camera ? <SeatCamera tile={camera} /> : <Avatar name={seat.name} src={avatar} />}
          {/* На паузе кольца нет: срока нет, и кольцо, домотанное до конца, врало бы. */}
          {active && !table.paused && (
            <TurnRing table={table} elapsed={meeting.serverNow() - table.actionAt} />
          )}
          {winner && <span className="poker-rays" aria-hidden="true" />}
          {table.button === seat.index && (
            <span className="poker-puck is-dealer" title="Дилер">
              D
            </span>
          )}
          {blind && !seat.folded && playing(table) && (
            <span className="poker-puck is-blind" title={blind === 'SB' ? 'Малый блайнд' : 'Большой блайнд'}>
              {blind}
            </span>
          )}
        </div>
        {/*
          Фишки человека — рядом с человеком.

          Одно число говорит, сколько у него денег, но не показывает этого: две тысячи и двадцать
          тысяч выглядят одинаково, пока их не прочитаешь. Здесь рядом с числом лежит его размен
          (см. {@link chipColumns}) — столбики по номиналам, которые растут и таят вместе со
          стеком, так что «у кого сколько» видно по столу, а не по чтению цифр.
        */}
        <div className="poker-name">
          <span>{seat.name}</span>
          <b>
            {seat.busted ? (
              `${seat.place} место`
            ) : (
              <>
                <ChipColumns amount={seat.stack} columns={3} size={9} />
                {chips(seat.stack)}
              </>
            )}
          </b>
        </div>
        {active && !table.paused && (
          <span className="poker-remaining">
            <Countdown meeting={meeting} until={table.deadline} />
          </span>
        )}
      </div>
      <div className="poker-hand">
        {seat.cards.length > 0
          ? seat.cards.map((card, index) => (
              <PlayingCard
                key={`${table.handNumber}-${seat.index}-${index}`}
                card={card}
                small
                dead={dead.has(`${seat.index}:${card}`)}
                highlight={showdown && seat.handCards.includes(card)}
                delay={dealDelay(table, seat, index, meeting.serverNow())}
              />
            ))
          : Array.from({ length: seat.held }, (_, index) => (
              <PlayingCard
                key={`${table.handNumber}-${seat.index}-back-${index}`}
                small
                dead={seat.folded}
                delay={dealDelay(table, seat, index, meeting.serverNow())}
              />
            ))}
      </div>
      {seat.bet > 0 && (
        <span className="poker-bet">
          <ChipColumns amount={seat.bet} columns={3} size={10} />
          {chips(seat.bet)}
        </span>
      )}
      {seat.lastAction && !seat.folded && seat.lastAction !== 'check' && playing(table) && (
        <span className="poker-bubble">{actionLabel(seat.lastAction, seat.lastActionAmount)}</span>
      )}
      {seat.folded && <span className="poker-bubble is-quiet">Пас</span>}
      {seat.waiting && <span className="poker-bubble is-quiet">Ждёт раздачу</span>}
      {seat.away && !seat.busted && <span className="poker-bubble is-quiet">Отошёл</span>}
      {seat.handName && showdown && <span className="poker-combo">{seat.handName}</span>}
      {won.length > 0 && (
        <span className="poker-won">+{chips(won.reduce((sum, award) => sum + award.amount, 0))}</span>
      )}
      {seat.busted && <span className="poker-out">Вылет</span>}
    </div>
  );
}

/**
 * Камера человека в кружке его места.
 *
 * Та же дорожка, что и в плитке встречи: LiveKit разрешает показывать её в нескольких местах
 * сразу, и второй подписки это не стоит. Своё изображение зеркалится — человек привык к
 * отражению.
 */
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
  return (
    <video
      ref={ref}
      className="poker-camera"
      autoPlay
      playsInline
      muted
      aria-label={`Камера: ${tile.name}`}
    />
  );
}

/**
 * Кольцо хода.
 *
 * Это чистая CSS-анимация с отрицательной задержкой: длительность — всё время на ход, сдвиг —
 * сколько его уже прошло. Ни одного кадра не считает JavaScript, и именно поэтому кольцо не
 * дёргается, когда браузер занят видео, и одинаково у всех за столом.
 */
function TurnRing({ table, elapsed }: { table: Table; elapsed: number }) {
  const total = Math.max(1, table.deadline - table.actionAt);
  return (
    <svg className="poker-ring" viewBox="0 0 100 100" aria-hidden="true">
      <circle className="poker-ring-track" cx="50" cy="50" r="46" />
      <circle
        className="poker-ring-run"
        cx="50"
        cy="50"
        r="46"
        style={{ animationDuration: `${total}ms`, animationDelay: `${-Math.max(0, elapsed)}ms` }}
      />
    </svg>
  );
}

/** Карта. Рубашка — та же карта без лица: так переворот остаётся одним элементом. */
function PlayingCard({
  card,
  small,
  highlight,
  dead,
  delay = 0,
}: {
  card?: string;
  small?: boolean;
  highlight?: boolean;
  dead?: boolean;
  delay?: number;
}) {
  const face = card ? cardFace(card) : null;
  return (
    <span
      className="playing-card"
      data-small={small || undefined}
      data-red={face?.red || undefined}
      data-back={!face || undefined}
      data-highlight={(highlight && !dead) || undefined}
      data-dead={dead || undefined}
      style={{ animationDelay: `${Math.round(delay)}ms`, animationDuration: `${DEAL_MS}ms` }}
    >
      {face && (
        <>
          <b>{face.rank}</b>
          <i>{face.suit}</i>
          <u>{face.suit}</u>
        </>
      )}
    </span>
  );
}

/**
 * Секунды, которые тикают сами по себе и никого вокруг не перерисовывают.
 *
 * Долгие сроки считаются минутами: «540 с» до закрытия стола — это число, которое нужно делить в
 * уме, а отвечает оно на вопрос «успею ли я вернуться».
 */
function Countdown({ meeting, until, minutes }: { meeting: Meeting; until: number; minutes?: boolean }) {
  const [left, setLeft] = useState(() => Math.max(0, Math.ceil((until - meeting.serverNow()) / 1000)));
  useEffect(() => {
    const update = () => setLeft(Math.max(0, Math.ceil((until - meeting.serverNow()) / 1000)));
    update();
    const timer = setInterval(update, 250);
    return () => clearInterval(timer);
  }, [meeting, until]);
  return <>{minutes && left > 90 ? `${Math.ceil(left / 60)} мин` : `${left} с`}</>;
}

/** Кнопки хода. Что здесь законно — прислало ядро; здесь только размеры и подписи. */
function Controls({
  table,
  dealer,
  onSend,
  error,
  hints,
}: {
  table: Table;
  dealer: boolean;
  onSend: (type: Parameters<Meeting['command']>[0], extra?: Parameters<Meeting['command']>[3]) => void;
  error: string;
  hints: boolean;
}) {
  const you = table.you;
  const [raising, setRaising] = useState(false);
  const [amount, setAmount] = useState(0);
  const [sent, setSent] = useState(0);
  const steps = useMemo(() => betSteps(table), [table]);
  const share = callShare(table);
  const turn = !!you?.turn && sent !== table.actionAt;
  useEffect(() => {
    if (!you?.turn) {
      setRaising(false);
      return;
    }
    setAmount(you.minRaiseTo);
  }, [you?.turn, you?.minRaiseTo, table.actionAt]);

  const act = (action: PokerAction, chipsTo?: number) => {
    setSent(table.actionAt);
    setRaising(false);
    onSend('poker.act', { option: action, chips: chipsTo });
  };
  /*
    Клавиши для тех, кто играет часто: пас, колл, повышение, ва-банк. Ставить их нужно
    осторожно — в той же встрече есть чат и горячая клавиша микрофона, поэтому набор текста и
    открытые диалоги выключают их целиком.
  */
  useEffect(() => {
    if (!turn || !you) return;
    const keys = (event: KeyboardEvent) => {
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTyping(event.target) || document.querySelector('[role="dialog"]')) return;
      const key = event.key.toLowerCase();
      if ((key === 'f' || key === 'а') && you.actions.includes('fold')) act('fold');
      else if ((key === 'c' || key === 'с') && you.actions.includes('check')) act('check');
      else if ((key === 'c' || key === 'с') && you.actions.includes('call')) act('call');
      else if ((key === 'r' || key === 'к') && (you.actions.includes('raise') || you.actions.includes('bet')))
        setRaising(true);
      else if ((key === 'a' || key === 'ф') && you.actions.includes('allin')) act('allin');
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, [turn, you]);

  const seat = you ? table.seats[you.seat] : null;
  const seated = !!seat;
  return (
    <div className="poker-controls" data-turn={turn || undefined}>
      <div className="poker-mine">
        {seat && seat.cards.length > 0 ? (
          <div className="poker-mine-cards">
            {seat.cards.map((card, index) => (
              <PlayingCard
                key={`${table.handNumber}-mine-${index}`}
                card={card}
                highlight={table.phase === 'showdown' && seat.handCards.includes(card)}
              />
            ))}
          </div>
        ) : (
          <span className="poker-mine-hint">
            {seated ? 'Ждём следующую раздачу' : 'Нажмите свободное место, чтобы сесть'}
          </span>
        )}
        {seat && (
          <span className="poker-mine-stack">
            <ChipColumns amount={seat.stack} columns={4} size={13} />
            <b>{chips(seat.stack)}</b>
            {/* Что собралось — словами. Считает ядро и только по вашим картам. */}
            {hints && you?.hand && seat.cards.length > 0 ? (
              <small className="poker-mine-hand">{you.hand}</small>
            ) : (
              <small>
                {seat.timeBankMs > 0
                  ? `банк времени ${Math.round(seat.timeBankMs / 1000)} с`
                  : 'банк времени истрачен'}
              </small>
            )}
          </span>
        )}
      </div>
      {turn && you ? (
        raising ? (
          <div className="poker-sizer">
            <div className="poker-steps">
              {steps.map((step) => (
                <button
                  key={step.id}
                  className="poker-step"
                  onClick={() => setAmount(step.amount)}
                  data-active={amount === step.amount || undefined}
                >
                  <b>{step.label}</b>
                  <small>{chips(step.amount)}</small>
                </button>
              ))}
            </div>
            <div className="poker-sizer-row">
              <input
                className="slider"
                type="range"
                min={you.minRaiseTo}
                max={you.maxRaiseTo}
                step={Math.max(1, table.smallBlind)}
                value={Math.min(you.maxRaiseTo, Math.max(you.minRaiseTo, amount))}
                onChange={(event) => setAmount(Number(event.target.value))}
                aria-label="Размер ставки"
              />
              <button
                className="button primary"
                onClick={() => act(amount >= you.maxRaiseTo ? 'allin' : 'raise', amount)}
              >
                {amount >= you.maxRaiseTo ? 'Ва-банк' : `Повысить до ${chips(amount)}`}
              </button>
              <button
                className="button ghost"
                onClick={() => setRaising(false)}
                aria-label="Отменить повышение"
              >
                <X size={18} />
              </button>
            </div>
          </div>
        ) : (
          <div className="poker-actions">
            {you.actions.includes('fold') && (
              <button className="poker-action is-fold" onClick={() => act('fold')}>
                Пас <kbd>F</kbd>
              </button>
            )}
            {you.actions.includes('check') && (
              <button className="poker-action is-check" onClick={() => act('check')}>
                Чек <kbd>C</kbd>
              </button>
            )}
            {you.actions.includes('call') && (
              <button className="poker-action is-call" onClick={() => act('call')}>
                <span>
                  Колл {chips(you.callAmount)}
                  {hints && share !== null && <small>{share}% банка</small>}
                </span>
                <kbd>C</kbd>
              </button>
            )}
            {(you.actions.includes('raise') || you.actions.includes('bet')) && (
              <button className="poker-action is-raise" onClick={() => setRaising(true)}>
                {you.actions.includes('bet') ? 'Ставка' : 'Повысить'} <kbd>R</kbd>
              </button>
            )}
            {you.actions.includes('allin') &&
              !you.actions.includes('raise') &&
              !you.actions.includes('bet') && (
                <button className="poker-action is-allin" onClick={() => act('allin')}>
                  <Zap size={16} /> Ва-банк {chips(you.maxRaiseTo)} <kbd>A</kbd>
                </button>
              )}
          </div>
        )
      ) : (
        <div className="poker-idle">
          {seated && seat && (
            <>
              {seat.stack === 0 && table.rebuy && !seat.inHand && (
                <button className="button primary small" onClick={() => onSend('poker.rebuy')}>
                  <Coins size={15} /> Докупиться до {chips(table.startingStack)}
                </button>
              )}
              {table.phase === 'showdown' && seat.cards.length > 0 && !table.result?.showdown && (
                <button className="button secondary small" onClick={() => onSend('poker.reveal')}>
                  Показать карты
                </button>
              )}
              <button className="button ghost small" onClick={() => onSend('poker.stand')}>
                <LogOut size={15} /> Встать из-за стола
              </button>
            </>
          )}
          {!seated && dealer && table.phase === 'lobby' && (
            <span className="poker-idle-hint">Раздать можно, когда за столом двое</span>
          )}
          <Fairness table={table} />
        </div>
      )}
      {error && (
        <p className="form-error poker-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Кнопка «проверить раздачу».
 *
 * Стол объявляет отпечаток колоды <b>до</b> раздачи и показывает зерно после неё. Эта кнопка
 * пересобирает колоду у себя и сверяет её с тем, что легло на стол. Она нужна не потому, что
 * сервер подозревают, а потому, что играют на чужой машине: проверяемое обещание — единственная
 * разница между «нам сказали, что честно» и «мы посмотрели».
 */
function Fairness({ table }: { table: Table }) {
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => setVerdict(null), [table.handNumber, table.seed]);
  if (!table.seed) return null;
  return (
    <span className="poker-fair">
      <button
        className="text-button"
        disabled={checking}
        onClick={() => {
          setChecking(true);
          void verifyDeal(table)
            .then(setVerdict)
            .finally(() => setChecking(false));
        }}
      >
        <ShieldCheck size={14} /> Проверить раздачу
      </button>
      {verdict && (
        <small data-state={verdict.state}>
          {verdict.state === 'ok'
            ? `Совпало: ${verdict.cards} карт легли ровно так, как обещал отпечаток`
            : verdict.reason}
        </small>
      )}
    </span>
  );
}

/**
 * Лента стола.
 *
 * Сплошной строкой она читалась как бегущий текст, в котором «Алекс уравнивает 200» и «Флоп»
 * выглядят одинаково. Теперь это список: у каждой записи свой знак и свой цвет, раздачи
 * разделены, а суммы стоят справа отдельным столбцом — глазами находится то, что ищут, а не
 * всё подряд.
 */
const FEED_MARKS: Record<string, string> = {
  hand: '•',
  street: '•',
  blind: '◦',
  ante: '◦',
  action: '',
  win: '★',
  bust: '✕',
  over: '★',
  sit: '+',
  stand: '−',
  rebuy: '+',
  settings: '·',
  reveal: '◇',
  level: '↑',
  open: '·',
};

function Feed({ table }: { table: Table }) {
  const items = table.log.slice(-6).reverse();
  if (!items.length) return null;
  return (
    <aside className="poker-log" aria-label="События стола">
      <b>Лента игры</b>
      <ol>
        {items.map((note, index) => (
          <li key={`${note.at}-${index}`} data-kind={note.kind}>
            <i aria-hidden="true">{FEED_MARKS[note.kind] ?? ''}</i>
            <span>{note.text}</span>
            {note.amount > 0 && <u>{chips(note.amount)}</u>}
          </li>
        ))}
      </ol>
    </aside>
  );
}

/**
 * Полупрозрачная панель поверх сукна.
 *
 * ПОЧЕМУ ВНУТРИ СЦЕНЫ, А НЕ В ПАНЕЛИ СПРАВА. И шпаргалка, и итоги — это вопросы к столу: «флеш
 * старше стрита?», «сколько я в итоге проиграл?». Уводить с ними в панель интеграций, к настройкам
 * музыки, значило бы выйти из игры, чтобы о ней спросить. Панель выезжает поверх стола, оставляет
 * его видимым сквозь себя и закрывается тем же движением — Escape или крестиком.
 *
 * Роль здесь не {@code dialog} намеренно: стол за спиной продолжает играть, и горячие клавиши хода
 * (они выключаются любым открытым диалогом) должны работать.
 */
function Sheet({
  label,
  wide,
  head,
  children,
  onClose,
}: {
  label: string;
  wide?: boolean;
  head: ReactNode;
  children: ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, [onClose]);
  return (
    <aside className="poker-sheet" data-wide={wide || undefined} role="region" aria-label={label}>
      <header className="poker-sheet-head">
        {head}
        <button className="poker-sheet-close" onClick={onClose} aria-label="Закрыть">
          <X size={16} />
        </button>
      </header>
      <div className="poker-sheet-body">{children}</div>
    </aside>
  );
}

/** Лестница комбинаций — там же, где играют, а не в панели справа. */
function Combinations({ onClose }: { onClose: () => void }) {
  return (
    <Sheet
      label="Комбинации"
      onClose={onClose}
      head={
        <span className="poker-sheet-title">
          <ListOrdered size={16} />
          <b>Комбинации</b>
          <small>Сверху сильные, снизу слабые</small>
        </span>
      }
    >
      <ol className="hand-ranks">
        {HAND_RANKS.map((rank, index) => (
          <li key={rank.name}>
            <b>
              <i>{index + 1}</i> {rank.name}
            </b>
            <span className="hand-ranks-cards" aria-hidden="true">
              {rank.cards.map((card) => {
                const face = cardFace(card);
                return (
                  <em key={card} data-red={face.red || undefined}>
                    {face.rank}
                    {face.suit}
                  </em>
                );
              })}
            </span>
            <small>{rank.hint}</small>
          </li>
        ))}
      </ol>
      <p className="poker-sheet-note">
        Рука собирается из пяти карт: две свои и пять общих, любые пять из семи. Равные комбинации делят банк,
        а спорит между ними кикер — старшая из оставшихся карт.
      </p>
    </Sheet>
  );
}

/** Итоги игры — сразу, как она кончилась, и сколько стоит стол. */
function Results({ game, onClose }: { game: NonNullable<Table['summary']>; onClose: () => void }) {
  return (
    <Sheet label="Итоги игры" wide onClose={onClose} head={<GameCrown game={game} />}>
      <GameResult game={game} />
      <p className="poker-sheet-note">Эти итоги останутся в истории беседы — в панели «Игры».</p>
    </Sheet>
  );
}

/**
 * Праздник.
 *
 * Уровень выбирает сервер, а не браузер: «крупный банк» должен быть крупным у всех сразу, и
 * считать его каждому по своим числам означало бы, что у одного салют, а у другого ничего.
 */
function Cheer({
  table,
  cheer,
  spots,
}: {
  table: Table;
  cheer: NonNullable<ReturnType<typeof celebration>>;
  spots: SeatSpot[];
}) {
  const result = table.result!;
  const winners = result.awards;
  // Дождь фишек раскладывается по столу псевдослучайно, но одинаково у всех: зерно — момент
  // итога по серверным часам.
  const rain = useMemo(() => {
    let state = Math.max(1, result.at % 2147483647);
    const next = () => (state = (state * 48271) % 2147483647) / 2147483647;
    const count = cheer.level === 'huge' ? 34 : cheer.level === 'big' ? 18 : 0;
    const tones = ['#f0c04a', '#e04b4b', '#1f9d63', '#f2f4f8', '#8a5cf6'];
    return Array.from({ length: count }, () => ({
      x: next() * 100,
      delay: next() * 900,
      spin: next() * 720 - 360,
      tone: tones[Math.floor(next() * tones.length)] ?? '#f0c04a',
    }));
  }, [result.at, cheer.level]);
  return (
    <div className="poker-cheer" data-level={cheer.level} aria-live="polite">
      {cheer.label && <span className="poker-ribbon">{cheer.label}</span>}
      {/*
        Имя победителя крупно — только когда банк того стоит. У обычной раздачи над местом и
        так всплывает выигранная сумма, и вторая подпись поверх неё превращает победу в шум.
      */}
      {cheer.level !== 'normal' &&
        winners.map((award) => (
          <span
            key={award.seat}
            className="poker-cheer-name"
            style={{ left: `${spots[award.seat]?.x ?? 50}%`, top: `${spots[award.seat]?.y ?? 50}%` }}
          >
            <b>{award.name}</b>
            <i>{award.handName || (award.split ? 'делит банк' : 'забирает банк')}</i>
          </span>
        ))}
      {rain.map((chip, index) => (
        <i
          key={index}
          className="poker-rain"
          style={
            {
              left: `${chip.x}%`,
              background: chip.tone,
              animationDelay: `${chip.delay}ms`,
              '--spin': `${chip.spin}deg`,
            } as CSSProperties
          }
          aria-hidden="true"
        />
      ))}
    </div>
  );
}

interface Flight {
  id: number;
  /** Номер партии: он же и ключ. Без него React оставил бы прежний узел, и анимация не повторилась. */
  batch: number;
  from: { x: number; y: number };
  to: { x: number; y: number };
  delay: number;
  tone: string;
}

/**
 * Фишки, летящие по столу.
 *
 * ТРИ ПЕРЕЛЁТА, И ВСЕ ТРИ — ЭТО ОДНО ДВИЖЕНИЕ ДЕНЕГ. Человек ставит: фишки уезжают из его стека к
 * линии ставок. Круг кончился: всё, что лежит на линии, сгребают в середину — банк растёт. Раздача
 * сыграна: банк уезжает победителю. Ни одного из трёх нельзя нарисовать по одному снимку: в том,
 * где ставок уже нет, банк их съел, а в том, где есть победитель, ставок нет и подавно. Поэтому
 * здесь помнится предыдущее состояние — ровно по числу на место — и по разнице собирается перелёт.
 *
 * Сколько фишек летит, а не сколько их поставили: три-пять дисков читаются как «фишки поехали», а
 * сорок — как рябь. Номиналы берутся у самой суммы ({@link chipPile}), поэтому крупная ставка и
 * летит крупными цветами.
 */
function useChipFlights(table: Table, spots: SeatSpot[]): Flight[] {
  const [flights, setFlights] = useState<Flight[]>([]);
  const previous = useRef({
    streetAt: table.streetAt,
    handNumber: table.handNumber,
    bets: table.seats.map((seat) => seat.bet),
    resultAt: 0,
  });
  const batch = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    const bets = table.seats.map((seat) => seat.bet);
    const street = table.streetAt !== previous.current.streetAt;
    const fresh = table.handNumber !== previous.current.handNumber;
    const next: Flight[] = [];
    const group = ++batch.current;
    let id = 0;
    const fly = (
      from: { x: number; y: number },
      to: { x: number; y: number },
      amount: number,
      limit: number,
      delay: number,
      step: number,
    ) => {
      for (const [index, disc] of chipPile(amount, limit).entries())
        next.push({ id: id++, batch: group, from, to, delay: delay + index * step, tone: disc.tone });
    };
    if (fresh)
      /*
        Блайнды — это тоже брошенные фишки, и лететь они обязаны.

        Считаются они от нуля, а не от предыдущего снимка: в нём лежит прошлая раздача, и
        разница с ней ничего не значит. Летят с задержкой, сравнимой с раздачей карт, — чтобы
        не спорить с ними за внимание в первую же секунду.
      */
      bets.forEach((bet, index) => {
        const spot = spots[index];
        if (bet > 0 && spot) fly(spot, betSpot(spot), bet, 3, 180, 60);
      });
    else if (street)
      // Круг кончился: ставки со всего стола уезжают в банк — оттуда, где они лежали.
      previous.current.bets.forEach((bet, index) => {
        const spot = spots[index];
        if (bet > 0 && spot) fly(betSpot(spot), { x: 50, y: 50 }, bet, 3, index * 40, 70);
      });
    else
      bets.forEach((bet, index) => {
        // Ставка: только прирост, иначе доложенная разница выглядела бы новой ставкой целиком.
        const added = bet - (previous.current.bets[index] ?? 0);
        const spot = spots[index];
        if (added > 0 && spot) fly(spot, betSpot(spot), added, 3, 0, 60);
      });
    const result = table.result;
    if (result && result.at !== previous.current.resultAt)
      result.awards.forEach((award, index) => {
        const spot = spots[award.seat];
        if (spot) fly({ x: 50, y: 50 }, spot, award.amount, 5, 260 + index * 120, 80);
      });
    previous.current = {
      streetAt: table.streetAt,
      handNumber: table.handNumber,
      bets,
      resultAt: result?.at ?? previous.current.resultAt,
    };
    if (!next.length) return;
    setFlights(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setFlights([]), COLLECT_MS + 1200);
  }, [table, spots]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return flights;
}
