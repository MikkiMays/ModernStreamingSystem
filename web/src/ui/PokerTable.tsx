import '../game-polish.css';
import { occupiedSeatLayout } from '../core/game-layout';
import { CardMotion, GameTurn, useTableRatio } from './GamePresentation';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Track, TrackEvent } from 'livekit-client';
import {
  Check,
  ChevronRight,
  Crown,
  Eye,
  LogOut,
  Pause,
  Play,
  ListOrdered,
  Maximize2,
  Minimize2,
  Settings2,
  ShieldCheck,
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
  cardKey,
  celebration,
  chipColumns,
  chipPile,
  chips,
  COLLECT_MS,
  COLUMN_HEIGHT,
  DEAL_MS,
  dealDelay,
  HAND_RANKS,
  phaseLabel,
  playing,
  readyCount,
  showdownCards,
  verdictText,
  verifyDeal,
  type CardState,
  type SeatSpot,
  type Verdict,
} from '../core/poker';
import { GameResult, GameCrown } from './PokerResult';
import { useFullscreen } from '../core/fullscreen';
import { allowed } from '../core/permissions';
import { readPreferences, savePreferences } from '../core/preferences';
import { IntegrationBarSlot, StageExitButton } from './IntegrationBar';
import { useStageExit } from './stage-context';
import { Avatar, IconButton, useMediaQuery, useStore } from './primitives';
import { CordMark, CordWordmark } from './brand/Logo';
import { FaceZoomButton, useFaceZoom } from './FaceZoom';
import { useVoiceTier } from './useVoice';
import { TurnRing } from './TurnRing';
import { tableStatus, type TableStatus } from './poker/table-status';
import { useCardSounds, usePokerChipSounds, useTurnTicks } from './useGameSounds';
import { modalOpen } from './modal';

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
/** Какой лист лежит поверх сукна. Одновременно — ровно один. */
type SheetKind = 'settings' | 'help' | 'results' | null;

export default function PokerTable({ meeting, table }: { meeting: Meeting; table: Table }) {
  const { t } = useTranslation();
  const tracks = useStore(meeting.media.tracks);
  const preferences = useStore(meeting.media.preferences);
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
  const dealer = allowed({ ...snapshot, poker: table }, me, 'poker.manage');
  const cheer = celebration(t, table.result);
  const [error, setError] = useState('');
  /*
    Шпаргалка и итоги живут ЗДЕСЬ, внутри сцены, а не в панели справа.

    Раньше «комбинации» уводили в панель интеграций: человек за столом нажимал кнопку и
    оказывался в другом месте приложения, рядом с настройками музыки, — а стол в этот момент
    продолжал играть без него. Обе панели полупрозрачные и лежат поверх сукна: они закрывают
    часть стола, но не забирают его.
  */
  const [sheet, setSheet] = useState<SheetKind>(null);
  const summary = table.summary;
  // Игра кончилась — итоги открываются сами: это тот единственный момент, когда их и ждут.
  const shown = useRef('');
  useEffect(() => {
    if (!summary || shown.current === summary.id) return;
    shown.current = summary.id;
    setSheet('results');
  }, [summary]);
  /*
    Полный экран — тот же, что у кинозала, и по той же причине: стол это то, на что смотрят, а
    вокруг него шапка встречи, лента зрителей и пульт звонка. На телефоне без него играть
    почти невозможно — овал ужимается до трети экрана.
  */
  const scene = useRef<HTMLDivElement>(null);
  const { full, targetFull, toggle: toggleFull } = useFullscreen(scene);
  const { play, under } = useUnderHeight();

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

  // Карты и фишки звучат от тех же событий, от которых летят; часы тикают в конце своего хода.
  useCardSounds(meeting, 'poker', table.visualEvents);
  usePokerChipSounds(meeting, table);
  useTurnTicks(meeting, 'poker', table.deadline, !!you?.turn && !table.paused);

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
    Что светится на вскрытии, а что гаснет. За настоящим столом лишние карты не подсвечивают —
    их убирают из виду и называют комбинацию вслух; здесь остаётся гореть ровно победная
    пятёрка, а весь остальной борд и чужие руки уходят в серое.
  */
  const show = useMemo(() => showdownCards(table), [table.phase, table.revision]);
  const blinds = useMemo(() => blindSeats(table), [table.revision]);
  const showdown = table.phase === 'showdown';
  const winners = useMemo(
    () => new Set((table.result?.awards ?? []).map((award) => award.seat)),
    [table.result],
  );
  // Телефон решает не таблица стилей, а сам стол: кнопку, которой там не место, он просто не
  // рисует — вместо того, чтобы нарисовать и спрятать правилом с подкрученным весом.
  const compact = useMediaQuery('(max-width: 560px)');
  const pot =
    showdown && table.result
      ? table.result.pot
      : table.pot + table.seats.reduce((sum, seat) => sum + seat.bet, 0);
  const beat = usePotBeat(pot);
  // Между раздачами шапка сама говорит, что со столом (R46): ждём игроков, раздаём, закрываемся.
  const status = tableStatus(table, dealer);

  return (
    <div
      className="poker"
      ref={scene}
      data-phase={table.phase}
      data-drama={cheer?.level}
      data-full={targetFull ? 'true' : undefined}
    >
      <TableBar
        meeting={meeting}
        table={table}
        dealer={dealer}
        onSend={send}
        sheet={sheet}
        onSheet={setSheet}
        compact={compact}
        full={full}
        onFull={toggleFull}
      >
        {/*
          Чей ход — строкой в полосе стола, а не отдельной полосой над сукном.

          Отдельная полоса забирала у стола полсотни пикселей высоты, а стол на широком экране
          упирается именно в высоту: овал от этого сжимался целиком. Здесь ей хватает места в
          той же строке, где режим и блайнды, и видно её оттуда же, откуда смотрят на банк.
          На телефоне строка одна, поэтому там остаётся только «Ваш ход» — кольцо на месте и
          подсвеченная панель говорят остальное.
        */}
        {status ? (
          <TableStatusLabel meeting={meeting} status={status} />
        ) : (
          (!compact || (you?.turn && !table.paused)) && (
            <GameTurn
              meeting={meeting}
              deadline={table.deadline}
              active={!!you?.turn && !table.paused}
              label={
                table.paused
                  ? t(($) => $.poker.paused)
                  : you?.turn
                    ? compact
                      ? t(($) => $.poker.turn.yours)
                      : you.callAmount > 0
                        ? t(($) => $.poker.turn.yoursCall, { amount: chips(t, you.callAmount) })
                        : t(($) => $.poker.turn.yoursCheck)
                    : table.seats.find((seat) => seat.index === table.actor)?.name
                      ? t(($) => $.poker.turn.acting, {
                          name: table.seats.find((seat) => seat.index === table.actor)?.name,
                        })
                      : phaseLabel(t, table.phase)
              }
            />
          )
        )}
      </TableBar>
      <div className="poker-felt-wrap" ref={play}>
        <div className="poker-felt" ref={tableGeometry.ref}>
          <CardMotion meeting={meeting} events={table.visualEvents} spots={spots} />
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
              <CordMark className="poker-mark-sign" />
              <CordWordmark className="poker-mark-word" />
            </span>
          </div>
          <div className="poker-line" aria-hidden="true" />
          {playing(table) && <span className="poker-deck" aria-hidden="true" />}
          <div className="poker-center">
            <div className="poker-board" aria-label={t(($) => $.poker.board)}>
              {table.board.map((card, index) => (
                <PlayingCard
                  key={`${table.handNumber}-${card}`}
                  card={card}
                  state={show.get(cardKey(card))}
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
                  <b>{chips(t, pot)}</b>
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
                      {index === 0 ? t(($) => $.poker.pots.main) : t(($) => $.poker.pots.side, { index })}{' '}
                      {chips(t, side.amount)}
                    </b>
                  ))}
                </span>
              )}
              {/* Улица — только пока идёт раздача; между раздачами состояние говорит шапка (R46). */}
              {(playing(table) || showdown) && (
                <span className="poker-street">{phaseLabel(t, table.phase)}</span>
              )}
            </div>
            {/* Пауза посреди раздачи: часы стоят, ходить нельзя — и это должно быть видно. */}
            {table.paused && playing(table) && (
              <div className="poker-waiting is-paused" role="status">
                <Pause size={16} /> <b>{t(($) => $.poker.paused)}</b>
                <small>{t(($) => $.poker.pause.clocks)}</small>
              </div>
            )}
            {/*
              Между раздачами на сукне ничего не лежит (R27, R46): «нужен ещё игрок», «раздаём
              через…» и срок пустого стола говорит шапка. Здесь остаётся только итог игры.
            */}
            {table.phase === 'over' && (
              <GameOver table={table} dealer={dealer} onSend={send} onResults={() => setSheet('results')} />
            )}
          </div>
          {spots.map((spot) => {
            const seat = table.seats.find((seat) => seat.index === spot.index);
            if (!seat) return null;
            return (
              <SeatView
                key={spot.index}
                spot={spot}
                seat={seat}
                table={table}
                meeting={meeting}
                tracks={tracks}
                show={show}
                blind={blinds?.small === spot.index ? 'SB' : blinds?.big === spot.index ? 'BB' : null}
                winner={winners.has(spot.index)}
                mine={spot.index === mySeat}
                avatar={snapshot.participants.find((p) => p.id === seat.memberId)?.avatar ?? null}
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
        {sheet === 'help' && <Combinations onClose={() => setSheet(null)} />}
        {sheet === 'settings' && (
          <GameSettings
            meeting={meeting}
            table={table}
            dealer={dealer}
            onSend={send}
            onHelp={() => setSheet('help')}
            onClose={() => setSheet(null)}
          />
        )}
        {sheet === 'results' && summary && <Results game={summary} onClose={() => setSheet(null)} />}
        {/*
          Своя рука — сразу под столом, а не у нижнего края сцены.

          Раньше панель стояла третьей строкой сетки и прижималась к пульту звонка, а стол
          центрировался в оставшемся месте: на широком окне между ними лежала пустая полоса, и
          глаза ходили от своих карт к банку через неё. Теперь панель — продолжение стола: они
          стоят одной группой по центру, а высоту панели стол вычитает из своей (`--poker-under`
          меряет сама панель), поэтому высокая полоса додепа не залезает под пульт, а просто
          делает овал чуть меньше.
        */}
        <div className="poker-under" ref={under}>
          {mySeat === null && table.seats.some((seat) => !seat.memberId) && (
            <button
              className="button primary game-seat-action"
              disabled={!table.seatingOpen}
              onClick={() => send('poker.sit')}
            >
              {t(($) => $.poker.sit)}
            </button>
          )}
          <Controls table={table} show={show} onSend={send} error={error} hints={preferences.pokerHints} />
        </div>
      </div>
    </div>
  );
}

/**
 * Высота слота под столом — в переменную `--poker-under` на области стола.
 *
 * Ширина овала считается из высоты области минус эта панель: только так стол и своя рука
 * помещаются одной группой без прокрутки, какой бы высоты панель ни стала (ход, додеп, зритель
 * без места). Замкнутого круга «стол сжался → панель стала уже → выросла в высоту» здесь нет:
 * лоток шириной со стол, но не уже строки хода (`.poker-under`), поэтому переносов, которые
 * меняли бы его высоту вслед за столом, не бывает.
 */
function useUnderHeight() {
  const play = useRef<HTMLDivElement>(null);
  const under = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = play.current;
    const slot = under.current;
    if (!host || !slot) return;
    const apply = () => host.style.setProperty('--poker-under', `${Math.ceil(slot.offsetHeight)}px`);
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(slot);
    return () => observer.disconnect();
  }, []);
  return { play, under };
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
  sheet,
  onSheet,
  compact,
  full,
  onFull,
  children,
}: {
  meeting: Meeting;
  table: Table;
  dealer: boolean;
  onSend: (type: Parameters<Meeting['command']>[0], extra?: Parameters<Meeting['command']>[3]) => void;
  sheet: SheetKind;
  onSheet: (sheet: SheetKind) => void;
  compact: boolean;
  full: boolean;
  onFull: () => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const seated = table.seats.filter((seat) => seat.memberId).length;
  const ready = readyCount(table);
  const showdown = table.phase === 'showdown';
  return (
    <header className="poker-bar">
      <span className="poker-mode">
        <b>{table.modeName}</b>
        <small>
          {t(($) => $.poker.bar.blinds, { small: chips(t, table.smallBlind), big: chips(t, table.bigBlind) })}
          {table.ante > 0 && t(($) => $.poker.bar.ante, { amount: chips(t, table.ante) })}
          {table.handNumber > 0 && t(($) => $.poker.bar.hand, { number: table.handNumber })}
        </small>
      </span>
      {table.levelUpAt > 0 && table.phase !== 'over' && (
        <span className="poker-level" title={t(($) => $.poker.bar.levelTitle)}>
          <TrendingUp size={12} /> {t(($) => $.poker.bar.level, { level: table.level })}{' '}
          <Countdown meeting={meeting} until={table.levelUpAt} />
        </span>
      )}
      <span className="poker-seated">
        {t(($) => $.poker.bar.seated, { seated })}
        {table.seatingOpen ? '' : t(($) => $.poker.bar.seatingClosed)}
      </span>
      {/*
        Одна кнопка вместо меню «Вид».

        В меню лежали и настройки, и справка, и итоги — то есть всё, что не поместилось в
        полосу, и называлось это «Вид». Теперь это «Настройки игры»: лист поверх стола, где
        переключатели стоят справа, как им и положено, а комбинации с итогами открываются
        оттуда же.
      */}
      <button
        className="button secondary small poker-view"
        aria-label={t(($) => $.poker.settings.title)}
        aria-pressed={sheet === 'settings'}
        onClick={() => onSheet(sheet === 'settings' ? null : 'settings')}
      >
        {/* На телефоне от кнопки остаётся один значок: подпись в два слова забирала там
            половину строки, а имя для клавиатуры и озвучки остаётся в `aria-label`. */}
        <Settings2 size={16} /> <span className="poker-view-label">{t(($) => $.poker.settings.title)}</span>
      </button>
      {table.summary && (
        <button className="button secondary small" onClick={() => onSheet('results')}>
          <Trophy size={16} /> {t(($) => $.poker.bar.results)}
        </button>
      )}
      {children}
      {/* Музыка во встрече — мини-плеером в этой полосе, справа перед кнопками ведущего (R128). */}
      <IntegrationBarSlot />
      {dealer && (
        <div className="poker-host-actions">
          {/*
            ТЕМП ДЕРЖИТ ВЕДУЩИЙ. Вскрытие стоит на столе, пока его не уберут: «Продолжить»
            прибирает карты, «Раздать» прибирает и сдаёт сразу. Обе кнопки на одном месте,
            чтобы не искать их глазами после каждой раздачи.
          */}
          {table.awaiting && (
            <button className="button primary small" onClick={() => onSend('poker.next')}>
              <Check size={16} /> {t(($) => $.poker.bar.next)}
            </button>
          )}
          {(table.phase === 'lobby' || showdown) && (
            <button
              className={showdown ? 'button secondary small' : 'button primary small'}
              disabled={ready < 2}
              // Почему недоступна — подсказкой и для экранной читалки, а не строкой под столом (R45).
              title={ready < 2 ? t(($) => $.poker.bar.dealNeedsTwo) : undefined}
              aria-describedby={ready < 2 && table.phase === 'lobby' ? STATUS_ID : undefined}
              onClick={() => onSend('poker.deal')}
            >
              <Play size={16} /> {t(($) => $.poker.bar.deal)}
            </button>
          )}
          {/*
            Пауза остаётся в полосе на большом экране и прячется на телефоне: там у полосы есть
            ровно одна строка, и занимать её должно то, что нажимают каждую раздачу. Убрать стол
            и вовсе переехало в настройки — это действие редкое и необратимое.
          */}
          {table.phase !== 'over' && !compact && (
            <button
              className="button secondary small"
              onClick={() => onSend('poker.settings', { option: table.paused ? 'resume' : 'pause' })}
            >
              {table.paused ? <Play size={16} /> : <Pause size={16} />}
              {table.paused ? t(($) => $.poker.bar.resume) : t(($) => $.poker.bar.pause)}
            </button>
          )}
        </div>
      )}
      {/* Выход к участникам (R121) — рядом с полным экраном: обе кнопки про вид, а не про игру. */}
      <StageExitButton variant="bar" />
      {/* Условия вокруг кнопки нет намеренно: замену полному экрану там, где его не бывает,
          держит сам `useFullscreen` — снаружи разницы никакой. */}
      <IconButton
        label={full ? t(($) => $.poker.bar.exitFull) : t(($) => $.poker.bar.full)}
        className="poker-full"
        onClick={onFull}
      >
        {full ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
      </IconButton>
    </header>
  );
}

/**
 * Настройки игры.
 *
 * ПЕРЕКЛЮЧАТЕЛИ, А НЕ ГАЛОЧКИ, И СПРАВА. Галочка в меню отвечает на вопрос «выбрано ли», а здесь
 * вопрос другой — «включено ли»; и рука на телефоне тянется к правому краю строки, а не к левому.
 * Каждый переключатель — настоящая кнопка с ролью `switch`: её видно с клавиатуры и слышно
 * программе чтения с экрана, чего скрытый `checkbox` с нарисованным поверх ползунком не даёт.
 *
 * ДВА РАЗДЕЛА, И ЭТО ГРАНИЦА ПРАВ. Верхний — про то, как стол выглядит у вас: хранится на
 * устройстве и никого больше не касается. Нижний — про то, как идёт игра: это решения ведущего
 * стола, они уезжают в комнату и меняют её для всех.
 */
function GameSettings({
  meeting,
  table,
  dealer,
  onSend,
  onHelp,
  onClose,
}: {
  meeting: Meeting;
  table: Table;
  dealer: boolean;
  onSend: (type: Parameters<Meeting['command']>[0], extra?: Parameters<Meeting['command']>[3]) => void;
  onHelp: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const preferences = useStore(meeting.media.preferences);
  // Вид стола — своё у каждого, поэтому пишется в настройки устройства, а не в комнату.
  const toggle = (key: 'pokerHints' | 'pokerFeed') =>
    savePreferences({ ...readPreferences(), [key]: !preferences[key] });
  return (
    <Sheet
      label={t(($) => $.poker.settings.title)}
      onClose={onClose}
      head={
        <span className="poker-sheet-title">
          <Settings2 size={16} />
          <b>{t(($) => $.poker.settings.title)}</b>
          <small>
            {dealer ? t(($) => $.poker.settings.scopeDealer) : t(($) => $.poker.settings.scopeSelf)}
          </small>
        </span>
      }
    >
      <div className="poker-settings">
        <Toggle
          on={preferences.pokerHints}
          title={t(($) => $.poker.settings.hints.title)}
          hint={t(($) => $.poker.settings.hints.hint)}
          onChange={() => toggle('pokerHints')}
        />
        <Toggle
          on={preferences.pokerFeed}
          title={t(($) => $.poker.feed.title)}
          hint={t(($) => $.poker.settings.feedHint)}
          onChange={() => toggle('pokerFeed')}
        />
        <SettingsAction
          icon={<ListOrdered size={16} />}
          title={t(($) => $.poker.combinations.title)}
          hint={t(($) => $.poker.combinations.hint)}
          onClick={onHelp}
        />
        {/* Проверка честности — здесь, а не строкой под столом (R45): нужна она редко, и всем. */}
        <Fairness table={table} />
      </div>
      {dealer && (
        <div className="poker-settings" data-host="true">
          <p className="poker-settings-head">{t(($) => $.poker.settings.table)}</p>
          <Toggle
            on={table.autoDeal}
            title={t(($) => $.poker.settings.autoDeal.title)}
            hint={
              table.autoDeal
                ? t(($) => $.poker.settings.autoDeal.on)
                : t(($) => $.poker.settings.autoDeal.off)
            }
            onChange={() => onSend('poker.settings', { option: 'auto-deal' })}
          />
          <Toggle
            on={table.seatingOpen}
            title={t(($) => $.poker.settings.seating.title)}
            hint={
              table.seatingOpen
                ? t(($) => $.poker.settings.seating.on)
                : t(($) => $.poker.settings.seating.off)
            }
            onChange={() =>
              onSend('poker.settings', {
                option: table.seatingOpen ? 'seating-locked' : 'seating-open',
              })
            }
          />
          {/*
            Правила додепа — тем же языком, что и при открытии стола: сколько раз можно взять
            фишки заново. Размер додепа остаётся равным первому входу; менять его по ходу игры
            означало бы, что стол у вошедших и у доигрывающих разный.
          */}
          <div className="poker-settings-choice">
            <span>
              <b>{t(($) => $.poker.settings.rebuys.title)}</b>
              <small>
                {table.rebuyLimit < 0
                  ? t(($) => $.poker.settings.rebuys.unlimited, { amount: chips(t, table.rebuyChips) })
                  : table.rebuyLimit === 0
                    ? t(($) => $.poker.settings.rebuys.none)
                    : t(($) => $.poker.settings.rebuys.limited, {
                        count: table.rebuyLimit,
                        amount: chips(t, table.rebuyChips),
                      })}
              </small>
            </span>
            <span className="poker-settings-steps">
              {[0, 1, 3, -1].map((value) => (
                <button
                  key={value}
                  data-active={table.rebuyLimit === value || undefined}
                  onClick={() =>
                    onSend('poker.settings', {
                      option: 'rebuy-limit',
                      chips: value < 0 ? undefined : value,
                    })
                  }
                >
                  {value < 0 ? '∞' : value === 0 ? t(($) => $.poker.settings.rebuys.zero) : value}
                </button>
              ))}
            </span>
          </div>
          {table.phase !== 'over' && (
            <SettingsAction
              icon={table.paused ? <Play size={16} /> : <Pause size={16} />}
              title={table.paused ? t(($) => $.poker.settings.resume) : t(($) => $.poker.settings.pause)}
              hint={t(($) => $.poker.settings.pauseHint)}
              onClick={() => onSend('poker.settings', { option: table.paused ? 'resume' : 'pause' })}
            />
          )}
          <SettingsAction
            icon={<X size={16} />}
            title={t(($) => $.poker.settings.close.title)}
            hint={t(($) => $.poker.settings.close.hint)}
            danger
            onClick={() => onSend('poker.close')}
          />
        </div>
      )}
    </Sheet>
  );
}

/** Строка настроек, которая не переключает, а ведёт: значок, подпись и пояснение. */
function SettingsAction({
  icon,
  title,
  hint,
  danger,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  hint: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button className={danger ? 'poker-settings-link is-danger' : 'poker-settings-link'} onClick={onClick}>
      {icon} <b>{title}</b>
      <small>{hint}</small>
    </button>
  );
}

/** Переключатель: подпись слева, ползунок справа. */
function Toggle({
  on,
  title,
  hint,
  onChange,
}: {
  on: boolean;
  title: string;
  hint?: string;
  onChange: () => void;
}) {
  return (
    <button className="poker-toggle" role="switch" aria-checked={on} onClick={onChange}>
      <span>
        <b>{title}</b>
        {hint && <small>{hint}</small>}
      </span>
      <i aria-hidden="true" />
    </button>
  );
}

/** Игра кончилась: кто забрал всё, итоги и «собрать заново» — у ведущего. */
function GameOver({
  table,
  dealer,
  onSend,
  onResults,
}: {
  table: Table;
  dealer: boolean;
  onSend: (type: Parameters<Meeting['command']>[0], extra?: Parameters<Meeting['command']>[3]) => void;
  onResults: () => void;
}) {
  const { t } = useTranslation();
  const winner = table.seats.find((seat) => seat.place === 1);
  return (
    <div className="poker-waiting is-over" role="status">
      <Crown size={24} />
      <b>{winner ? t(($) => $.poker.waiting.winner, { name: winner.name }) : t(($) => $.poker.gameOver)}</b>
      <button className="button secondary small" onClick={onResults}>
        <Trophy size={16} /> {t(($) => $.poker.results.title)}
      </button>
      {dealer && (
        <button
          className="button primary small"
          onClick={() => {
            onSend('poker.close');
            setTimeout(() => onSend('poker.open', { option: table.mode, chips: table.startingStack }), 250);
          }}
        >
          {t(($) => $.poker.waiting.again)}
        </button>
      )}
    </div>
  );
}

/**
 * Состояние стола между раздачами — словами в шапке (R46), там же, где во время раздачи стоит
 * «Ходит Аня». Отсчёт — от метки ядра (`deadline`, `closesAt`), как у всех за столом.
 */
function TableStatusLabel({ meeting, status }: { meeting: Meeting; status: TableStatus }) {
  const { t } = useTranslation();
  return (
    <div className="game-turn poker-status" data-table-status={status.kind}>
      <strong id={STATUS_ID} role="status">
        {status.kind === 'closing' ? (
          <Trans
            i18nKey={($) => $.poker.bar.status.closing}
            components={{ time: <Countdown meeting={meeting} until={status.until} minutes /> }}
          />
        ) : status.kind === 'dealing' ? (
          <Trans
            i18nKey={($) => $.poker.bar.status.dealing}
            components={{ time: <Countdown meeting={meeting} until={status.until} /> }}
          />
        ) : status.kind === 'waiting' ? (
          t(($) => $.poker.bar.status.waiting, { ready: status.ready, need: status.need })
        ) : status.kind === 'paused' ? (
          t(($) => $.poker.paused)
        ) : status.kind === 'ready' ? (
          t(($) => $.poker.bar.status.ready)
        ) : (
          t(($) => $.poker.bar.status.dealer)
        )}
      </strong>
    </div>
  );
}

/** По этой метке «Раздать» объясняет, почему он пока недоступен. */
const STATUS_ID = 'poker-table-status';

/** Место за столом: человек, его фишки, карты и ставка. */
function SeatView({
  spot,
  seat,
  table,
  meeting,
  tracks,
  show,
  blind,
  winner,
  mine,
  avatar,
}: {
  spot: SeatSpot;
  seat: PokerSeat;
  table: Table;
  meeting: Meeting;
  tracks: MediaTile[];
  show: Map<string, CardState>;
  blind: 'SB' | 'BB' | null;
  winner: boolean;
  mine: boolean;
  avatar: string | null;
}) {
  const { t } = useTranslation();
  const active = table.actor === seat.index && playing(table);
  const camera = tracks.find(
    (tile) => tile.participantId === seat.memberId && tile.source === Track.Source.Camera && !tile.muted,
  );
  const voice = useVoiceTier(meeting, seat.memberId);
  const zoom = useFaceZoom('poker', seat.memberId);
  // Откуда прилетают карты: из середины стола. Направление — вектор к центру, в долях ширины
  // стола (высоту из него пересчитывает CSS через `--felt-ratio`).
  const style = {
    left: `${spot.x}%`,
    top: `${spot.y}%`,
    '--dx': 50 - spot.x,
    '--dyp': 50 - spot.y,
  } as CSSProperties;
  if (!seat.memberId) return null;
  const won = table.result?.awards.filter((award) => award.seat === seat.index) ?? [];
  const showdown = table.phase === 'showdown';
  return (
    <div
      className="poker-seat"
      data-game-seat={seat.index}
      style={style}
      data-side={spot.side}
      data-active={active || undefined}
      data-folded={seat.folded || undefined}
      data-allin={seat.allIn || undefined}
      data-busted={seat.busted || undefined}
      data-away={seat.away || undefined}
      data-waiting={seat.waiting || undefined}
      data-winner={winner || undefined}
      data-speaking={voice > 0 || undefined}
      data-voice={voice || undefined}
      data-mine={mine || undefined}
    >
      <div className="poker-person">
        <div className="poker-face" style={zoom.style}>
          {camera ? <SeatCamera tile={camera} /> : <Avatar name={seat.name} src={avatar} />}
          <FaceZoomButton zoom={zoom.zoom} name={seat.name} onCycle={zoom.cycle} />
          {/* На паузе кольца нет: срока нет, и кольцо, домотанное до конца, врало бы. */}
          {active && !table.paused && (
            <TurnRing meeting={meeting} actionAt={table.actionAt} deadline={table.deadline} />
          )}
          {winner && <span className="poker-rays" aria-hidden="true" />}
          {table.button === seat.index && (
            <span className="poker-puck is-dealer" title={t(($) => $.poker.seat.dealer)}>
              D
            </span>
          )}
          {blind && !seat.folded && playing(table) && (
            <span
              className="poker-puck is-blind"
              title={blind === 'SB' ? t(($) => $.poker.seat.smallBlind) : t(($) => $.poker.seat.bigBlind)}
            >
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
          <span title={seat.name}>{seat.name}</span>
          <b>
            {seat.busted ? (
              t(($) => $.poker.seat.place, { place: seat.place })
            ) : (
              <>
                <ChipColumns amount={seat.stack} columns={3} size={9} />
                {chips(t, seat.stack)}
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
                state={show.get(cardKey(card, seat.index))}
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
          {chips(t, seat.bet)}
        </span>
      )}
      {seat.lastAction && !seat.folded && seat.lastAction !== 'check' && playing(table) && (
        <span className="poker-bubble">{actionLabel(t, seat.lastAction, seat.lastActionAmount)}</span>
      )}
      {seat.folded && <span className="poker-bubble is-quiet">{t(($) => $.poker.seat.folded)}</span>}
      {seat.waiting && <span className="poker-bubble is-quiet">{t(($) => $.poker.seat.waiting)}</span>}
      {seat.away && !seat.busted && (
        <span className="poker-bubble is-quiet">{t(($) => $.poker.seat.away)}</span>
      )}
      {seat.handName && showdown && <span className="poker-combo">{seat.handName}</span>}
      {won.length > 0 && (
        <span className="poker-won">
          +
          {chips(
            t,
            won.reduce((sum, award) => sum + award.amount, 0),
          )}
        </span>
      )}
      {seat.busted && <span className="poker-out">{t(($) => $.poker.seat.busted)}</span>}
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
    <video
      ref={ref}
      className="poker-camera"
      autoPlay
      playsInline
      muted
      aria-label={t(($) => $.poker.camera, { name: tile.name })}
    />
  );
}

/**
 * Карта. Рубашка — та же карта без лица: так переворот остаётся одним элементом.
 *
 * Состояние на вскрытии приходит одним значением, а не парой флагов: «светится» и «погашена»
 * исключают друг друга, и защищаться здесь от того, что пришло и то и другое, больше не нужно.
 */
function PlayingCard({
  card,
  small,
  state,
  dead,
  delay = 0,
}: {
  card?: string;
  small?: boolean;
  state?: CardState;
  /** Сброшенная рубашка гаснет и без вскрытия: это про руку, а не про комбинацию. */
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
      data-highlight={state === 'winning' || undefined}
      data-dead={state === 'dead' || dead || undefined}
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
  const { t } = useTranslation();
  const [left, setLeft] = useState(() => Math.max(0, Math.ceil((until - meeting.serverNow()) / 1000)));
  useEffect(() => {
    const update = () => setLeft(Math.max(0, Math.ceil((until - meeting.serverNow()) / 1000)));
    update();
    const timer = setInterval(update, 250);
    return () => clearInterval(timer);
  }, [meeting, until]);
  return (
    <>
      {minutes && left > 90
        ? t(($) => $.poker.countdown.minutes, { minutes: Math.ceil(left / 60) })
        : t(($) => $.poker.countdown.seconds, { seconds: left })}
    </>
  );
}

/** Кнопки хода. Что здесь законно — прислало ядро; здесь только размеры и подписи. */
function Controls({
  table,
  show,
  onSend,
  error,
  hints,
}: {
  table: Table;
  show: Map<string, CardState>;
  onSend: (type: Parameters<Meeting['command']>[0], extra?: Parameters<Meeting['command']>[3]) => void;
  error: string;
  hints: boolean;
}) {
  const { t } = useTranslation();
  const you = table.you;
  const [raising, setRaising] = useState(false);
  const [amount, setAmount] = useState(0);
  const [sent, setSent] = useState(0);
  const steps = useMemo(() => betSteps(t, table), [t, table]);
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
  /** Зритель ушёл к участникам (R121): стол спрятан, и «F» над сеткой — не пас. */
  const { away } = useStageExit();
  useEffect(() => {
    if (!turn || !you || away) return;
    const keys = (event: KeyboardEvent) => {
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTyping(event.target) || modalOpen()) return;
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
  }, [turn, you, away]);

  const seat = you ? table.seats.find((seat) => seat.index === you.seat) : null;
  const seated = !!seat;
  /*
    Не севшему под столом нечего показать (R45): «Сесть за стол» стоит рядом, а «сядьте, чтобы
    играть» и «раздать можно, когда за столом двое» повторяли его и шапку. Остаётся только отказ
    сервера, если он был.
  */
  if (!seat)
    return error ? (
      <p className="form-error poker-error" role="alert">
        {error}
      </p>
    ) : null;
  /*
    ФИШКИ КОНЧИЛИСЬ — ЭТО СОБЫТИЕ, А НЕ КНОПКА В РЯДУ ДРУГИХ.

    Раньше здесь стояло «Докупиться до 5 000», и одно случайное нажатие молча добавляло фишки:
    человек ещё не понял, что вылетел, а стол уже выдал ему новый стек. Теперь это отдельная
    красная полоса поверх кнопок хода — с суммой, которую видно, и подтверждением движением, а
    не касанием. Показывает её сервер: {@code you.rebuy} — это и «можно», и «сколько».
  */
  if (you && you.rebuy > 0 && seat)
    return (
      <div className="poker-controls" data-out="true">
        <Rebuy you={you} table={table} onSend={onSend} error={error} />
      </div>
    );
  return (
    <div className="poker-controls" data-turn={turn || undefined}>
      <div className="poker-mine">
        {seat && seat.cards.length > 0 ? (
          <div className="poker-mine-cards">
            {seat.cards.map((card, index) => (
              <PlayingCard
                key={`${table.handNumber}-mine-${index}`}
                card={card}
                state={show.get(cardKey(card, seat.index))}
              />
            ))}
          </div>
        ) : (
          <span className="poker-mine-hint">{t(($) => $.poker.controls.waitNext)}</span>
        )}
        {seat && (
          <span className="poker-mine-stack">
            <ChipColumns amount={seat.stack} columns={4} size={13} />
            <b>{chips(t, seat.stack)}</b>
            {/* Что собралось — словами. Считает ядро и только по вашим картам. */}
            {hints && you?.hand && seat.cards.length > 0 ? (
              <small className="poker-mine-hand">{you.hand}</small>
            ) : (
              <small>
                {seat.timeBankMs > 0
                  ? t(($) => $.poker.controls.timeBank, { seconds: Math.round(seat.timeBankMs / 1000) })
                  : t(($) => $.poker.controls.timeBankSpent)}
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
                  <small>{chips(t, step.amount)}</small>
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
                aria-label={t(($) => $.poker.controls.betSize)}
              />
              <button
                className="button primary"
                onClick={() => act(amount >= you.maxRaiseTo ? 'allin' : 'raise', amount)}
              >
                {amount >= you.maxRaiseTo
                  ? t(($) => $.poker.actions.allin)
                  : t(($) => $.poker.controls.raiseTo, { amount: chips(t, amount) })}
              </button>
              <button
                className="button ghost"
                onClick={() => setRaising(false)}
                aria-label={t(($) => $.poker.controls.cancelRaise)}
              >
                <X size={20} />
              </button>
            </div>
          </div>
        ) : (
          <div className="poker-actions">
            {you.actions.includes('fold') && (
              <button className="poker-action is-fold" onClick={() => act('fold')}>
                {t(($) => $.poker.actions.fold)} <kbd>F</kbd>
              </button>
            )}
            {you.actions.includes('check') && (
              <button className="poker-action is-check" onClick={() => act('check')}>
                {t(($) => $.poker.actions.check)} <kbd>C</kbd>
              </button>
            )}
            {you.actions.includes('call') && (
              <button className="poker-action is-call" onClick={() => act('call')}>
                <span>
                  {t(($) => $.poker.controls.call, { amount: chips(t, you.callAmount) })}
                  {hints && share !== null && <small>{t(($) => $.poker.controls.share, { share })}</small>}
                </span>
                <kbd>C</kbd>
              </button>
            )}
            {(you.actions.includes('raise') || you.actions.includes('bet')) && (
              <button className="poker-action is-raise" onClick={() => setRaising(true)}>
                {you.actions.includes('bet')
                  ? t(($) => $.poker.actions.bet)
                  : t(($) => $.poker.controls.raise)}{' '}
                <kbd>R</kbd>
              </button>
            )}
            {you.actions.includes('allin') &&
              !you.actions.includes('raise') &&
              !you.actions.includes('bet') && (
                <button className="poker-action is-allin" onClick={() => act('allin')}>
                  <Zap size={16} />{' '}
                  {t(($) => $.poker.controls.allinAmount, { amount: chips(t, you.maxRaiseTo) })} <kbd>A</kbd>
                </button>
              )}
          </div>
        )
      ) : (
        <div className="poker-idle">
          {seated && seat && (
            <>
              {/*
                Показать карты — право, а не обязанность, и предлагается оно там, где им
                пользуются: на вскрытии. Раньше кнопка появлялась только у раздач, кончившихся
                без вскрытия, и пропадала ровно в тот момент, когда за столом как раз и говорят
                «а что у тебя было». Тот, кого вскрыли принудительно, её не видит вовсе:
                `revealed` приезжает с сервера, и второй раз нажимать нечего.
              */}
              {table.phase === 'showdown' && seat.cards.length > 0 && !seat.revealed && (
                <button className="button secondary small" onClick={() => onSend('poker.reveal')}>
                  <Eye size={16} /> {t(($) => $.poker.controls.reveal)}
                </button>
              )}
              <button className="button ghost small" onClick={() => onSend('poker.stand')}>
                <LogOut size={16} /> {t(($) => $.poker.controls.stand)}
              </button>
            </>
          )}
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
 * Фишки кончились: взять заново или встать.
 *
 * ПОЧЕМУ ДВИЖЕНИЕМ, А НЕ НАЖАТИЕМ. Это единственное действие за столом, которое меняет не ход
 * игры, а её условия: у человека появляется стек, которого не было. Нажатие такого веса
 * случается мимо воли — палец на телефоне, привычка добивать кнопки после проигранной раздачи, —
 * и раньше оно так и происходило: фишки добавлялись молча, одним касанием. Движение слева
 * направо случайным не бывает; так же подтверждают оплату, и объяснять этот жест никому не нужно.
 *
 * Сумму человек выбирает сам, но не больше того, что даёт стол ({@code you.rebuy}), а правила
 * считает сервер: сколько додепов осталось, идёт ли раздача, пуст ли стек.
 */
function Rebuy({
  you,
  table,
  onSend,
  error,
}: {
  you: NonNullable<Table['you']>;
  table: Table;
  onSend: (type: Parameters<Meeting['command']>[0], extra?: Parameters<Meeting['command']>[3]) => void;
  error: string;
}) {
  const { t } = useTranslation();
  const most = you.rebuy;
  const least = Math.min(most, Math.max(200, table.bigBlind * 10));
  const [amount, setAmount] = useState(most);
  const left = you.rebuysLeft;
  return (
    <div className="poker-rebuy" role="alert">
      <span className="poker-rebuy-head">
        <b>{t(($) => $.poker.rebuy.title)}</b>
        <small>
          {left < 0 ? t(($) => $.poker.rebuy.unlimited) : t(($) => $.poker.rebuy.left, { count: left })}
        </small>
      </span>
      {most > least && (
        <label className="poker-rebuy-amount">
          <span>
            <Trans
              i18nKey={($) => $.poker.rebuy.pick}
              values={{ amount: chips(t, amount) }}
              components={{ b: <b /> }}
            />
          </span>
          <input
            className="slider"
            type="range"
            min={least}
            max={most}
            step={Math.max(1, table.bigBlind)}
            value={Math.min(most, Math.max(least, amount))}
            onChange={(event) => setAmount(Number(event.target.value))}
            aria-label={t(($) => $.poker.rebuy.amount)}
          />
        </label>
      )}
      <Slide
        label={t(($) => $.poker.rebuy.take, { amount: chips(t, amount) })}
        onConfirm={() => onSend('poker.rebuy', { chips: amount })}
      />
      <button className="text-button poker-rebuy-out" onClick={() => onSend('poker.stand')}>
        <LogOut size={16} /> {t(($) => $.poker.controls.stand)}
      </button>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Подтверждение движением.
 *
 * Ползунок, который нужно дотянуть до конца: до девяти десятых пути он возвращается назад, а
 * дойдя — срабатывает один раз. Пальцем и мышью это одно и то же событие указателя, поэтому
 * отдельной ветки для телефона здесь нет.
 *
 * С КЛАВИАТУРЫ ЭТО ОБЫЧНАЯ КНОПКА. Жест, без которого действие недоступно, — это действие,
 * недоступное половине людей: `Enter` и пробел подтверждают сразу, потому что случайными они не
 * бывают тем более.
 */
export function Slide({ label, onConfirm }: { label: string; onConfirm: () => void }) {
  const { t } = useTranslation();
  const track = useRef<HTMLDivElement>(null);
  const [part, setPart] = useState(0);
  const done = useRef(false);
  const pointer = useRef<number | null>(null);
  const finish = () => {
    if (done.current) return;
    done.current = true;
    setPart(1);
    onConfirm();
  };
  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    if (pointer.current !== event.pointerId || event.buttons === 0 || done.current) return;
    const box = track.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    const next = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
    setPart(next);
    if (next >= 0.9) finish();
  };
  const release = (event: React.PointerEvent<HTMLDivElement>) => {
    if (pointer.current !== event.pointerId) return;
    if (track.current?.hasPointerCapture(event.pointerId))
      track.current.releasePointerCapture(event.pointerId);
    pointer.current = null;
    if (!done.current) setPart(0);
  };
  return (
    <div
      className="poker-slide"
      ref={track}
      data-done={part >= 0.9 || undefined}
      onPointerMove={move}
      onPointerUp={release}
      onPointerCancel={release}
    >
      <span className="poker-slide-label">{t(($) => $.poker.slide, { label })}</span>
      <button
        className="poker-slide-knob"
        style={{ left: `calc(${(part * 100).toFixed(1)}% - ${(part * 48).toFixed(1)}px)` }}
        aria-label={label}
        onPointerDown={(event) => {
          if (event.button !== 0 || event.isPrimary === false) return;
          pointer.current = event.pointerId;
          track.current?.setPointerCapture(event.pointerId);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') finish();
        }}
      >
        <ChevronRight size={20} />
      </button>
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
  const { t } = useTranslation();
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => setVerdict(null), [table.handNumber, table.seed]);
  if (!table.seed) return null;
  return (
    <button
      className="poker-settings-link poker-fair"
      disabled={checking}
      onClick={() => {
        setChecking(true);
        void verifyDeal(table)
          .then(setVerdict)
          .finally(() => setChecking(false));
      }}
    >
      <ShieldCheck size={16} /> <b>{t(($) => $.poker.fair.check)}</b>
      {verdict && <small data-state={verdict.state}>{verdictText(t, verdict)}</small>}
    </button>
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
  const { t } = useTranslation();
  const items = table.log.slice(-6).reverse();
  if (!items.length) return null;
  return (
    <aside className="poker-log" aria-label={t(($) => $.poker.feed.label)}>
      <b>{t(($) => $.poker.feed.title)}</b>
      <ol>
        {items.map((note, index) => (
          <li key={`${note.at}-${index}`} data-kind={note.kind}>
            <i aria-hidden="true">{FEED_MARKS[note.kind] ?? ''}</i>
            <span>{note.text}</span>
            {note.amount > 0 && <u>{chips(t, note.amount)}</u>}
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
  const { t } = useTranslation();
  /*
    Escape закрывает лист, и слушатель ставится один раз.

    `onClose` приходит стрелкой из разметки, то есть новой на каждый снимок стола, — а снимки
    идут на каждое чужое действие. С ним в зависимостях слушатель снимался и ставился заново
    несколько раз в секунду; ссылка на свежий обработчик живёт в `ref` и решает это без
    договорённостей на стороне вызывающего.
  */
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close.current();
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, []);
  return (
    <aside className="poker-sheet" data-wide={wide || undefined} role="region" aria-label={label}>
      <header className="poker-sheet-head">
        {head}
        <button className="poker-sheet-close" onClick={onClose} aria-label={t(($) => $.common.close)}>
          <X size={16} />
        </button>
      </header>
      <div className="poker-sheet-body">{children}</div>
    </aside>
  );
}

/** Лестница комбинаций — там же, где играют, а не в панели справа. */
function Combinations({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Sheet
      label={t(($) => $.poker.combinations.title)}
      onClose={onClose}
      head={
        <span className="poker-sheet-title">
          <ListOrdered size={16} />
          <b>{t(($) => $.poker.combinations.title)}</b>
          <small>{t(($) => $.poker.combinations.order)}</small>
        </span>
      }
    >
      <ol className="hand-ranks">
        {HAND_RANKS.map((rank, index) => (
          <li key={rank.id}>
            <b>
              <i>{index + 1}</i> {t(($) => $.poker.handRanks[rank.id].name)}
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
            <small>{t(($) => $.poker.handRanks[rank.id].hint)}</small>
          </li>
        ))}
      </ol>
      <p className="poker-sheet-note">{t(($) => $.poker.combinations.note)}</p>
    </Sheet>
  );
}

/** Итоги игры — сразу, как она кончилась, и сколько стоит стол. */
function Results({ game, onClose }: { game: NonNullable<Table['summary']>; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Sheet label={t(($) => $.poker.results.title)} wide onClose={onClose} head={<GameCrown game={game} />}>
      <GameResult game={game} />
      <p className="poker-sheet-note">{t(($) => $.poker.results.note)}</p>
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
  const { t } = useTranslation();
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
            style={{
              left: `${spots.find((spot) => spot.index === award.seat)?.x ?? 50}%`,
              top: `${spots.find((spot) => spot.index === award.seat)?.y ?? 50}%`,
            }}
          >
            <b>{award.name}</b>
            <i>
              {award.handName ||
                (award.split ? t(($) => $.poker.cheer.split) : t(($) => $.poker.cheer.takes))}
            </i>
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
        const spot = spots.find((spot) => spot.index === table.seats[index]?.index);
        if (bet > 0 && spot) fly(spot, betSpot(spot), bet, 3, 180, 60);
      });
    else if (street)
      // Круг кончился: ставки со всего стола уезжают в банк — оттуда, где они лежали.
      previous.current.bets.forEach((bet, index) => {
        const spot = spots.find((spot) => spot.index === table.seats[index]?.index);
        if (bet > 0 && spot) fly(betSpot(spot), { x: 50, y: 50 }, bet, 3, index * 40, 70);
      });
    else
      bets.forEach((bet, index) => {
        // Ставка: только прирост, иначе доложенная разница выглядела бы новой ставкой целиком.
        const added = bet - (previous.current.bets[index] ?? 0);
        const spot = spots.find((spot) => spot.index === table.seats[index]?.index);
        if (added > 0 && spot) fly(spot, betSpot(spot), added, 3, 0, 60);
      });
    const result = table.result;
    if (result && result.at !== previous.current.resultAt)
      result.awards.forEach((award, index) => {
        const spot = spots.find((spot) => spot.index === award.seat);
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
