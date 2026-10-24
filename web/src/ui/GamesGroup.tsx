import '../game-polish.css';
import { useState, type CSSProperties } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  ChevronDown,
  Club,
  Crown,
  Coins,
  History,
  Layers,
  Play,
  Pencil,
  Shuffle,
  Spade,
  Timer,
  TrendingUp,
  Users,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Meeting } from '../core/meeting';
import type { DurakTable, PokerMode } from '../api/types';
import { blindsFor, chips, gameTitle, MAX_STACK, MIN_STACK, POKER_MODES, winnerOf } from '../core/poker';
import { allowed, type RoomAction } from '../core/permissions';
import { GameResult } from './PokerResult';
import { Modal, useStore } from './primitives';

/**
 * Игры в панели интеграций.
 *
 * СПИСОК, А НЕ СТРАНИЦА НА ИГРУ. Покер здесь первый, но не последний, и отдельный экран под
 * каждую новую игру — это десяток разных экранов через год, в которых одно и то же называется
 * по-разному. Поэтому здесь список: у каждой игры строка, по нажатию она раскрывается прямо в
 * списке — режим, настройки, кнопка, — и раскрытой остаётся одна.
 *
 * Сама игра живёт на сцене: в узкой колонке стол превратился бы в таблицу с номерами мест. Панели
 * остаётся то, для чего она и нужна, — принести, убрать и посмотреть, чем кончились прошлые игры.
 * Правила и шпаргалки сюда не переезжают: о столе спрашивают у стола.
 */
type GameId = 'poker' | 'durak' | 'chess' | 'gartic';

/** Название и подпись игры — в каталоге (`games.list[id]`). */
const GAMES: {
  id: GameId;
  accent: string;
  icon: typeof Spade;
}[] = [
  { id: 'poker', accent: '#8a5cf6', icon: Spade },
  { id: 'durak', accent: '#c9a227', icon: Club },
  { id: 'chess', accent: '#5271a3', icon: Crown },
  { id: 'gartic', accent: '#8d65c5', icon: Pencil },
];

const CHESS_PRESETS = ['untimed', '3-2', '5-0', '10-5', '15-10'] as const;

/** Во сколько раз стартовый стек больше или меньше обычного для режима. */
const STACK_STEPS = [0.5, 1, 2, 5];

export function GamesGroup({ meeting, onBack }: { meeting: Meeting; onBack: () => void }) {
  const { t } = useTranslation();
  const snapshot = useStore(meeting.snapshot);
  // Принести стол и распоряжаться им — ответы ядра (`you.can`), а не правило, пересчитанное здесь.
  const may = (action: RoomAction) => allowed(snapshot, meeting.admission.participantId, action);
  const table = snapshot.poker;
  const durak = snapshot.durak;
  const dealer = may('poker.manage');
  // Стол уже стоит — значит, открыта его строка; иначе открывается та, на которую нажали.
  const [open, setOpen] = useState<GameId | null>(
    table ? 'poker' : durak ? 'durak' : snapshot.chess ? 'chess' : snapshot.gartic ? 'gartic' : null,
  );
  const [chessPreset, setChessPreset] = useState('10-5');
  const [garticMode, setGarticMode] = useState('classic');
  /*
    Настройки дурака выбираются до того, как стол принесут: колода и правила перевода меняются
    только между партиями, и спрашивать о них после раздачи поздно. Дальше их всё равно можно
    поменять — но уже за столом, там же, где играют.
  */
  const [deck, setDeck] = useState(36);
  const [transfer, setTransfer] = useState(false);
  const [mode, setMode] = useState<PokerMode>('friendly');
  const preset = POKER_MODES.find((item) => item.id === mode) ?? POKER_MODES[0]!;
  const [stack, setStack] = useState(preset.stack);
  /*
    Правила додепа задаются заранее, вместе со стеком: «сколько раз можно взять фишки заново» —
    это про условия игры, а не про настройку по ходу. Дружеская игра пускает без ограничений,
    турнир — ни разу; дальше это решение ведущего, и менять его можно и потом.
  */
  const [rebuys, setRebuys] = useState<number | null>(null);
  const [history, setHistory] = useState(false);
  const [error, setError] = useState('');
  const limit = rebuys ?? (preset.id === 'friendly' ? -1 : 0);
  const blinds = blindsFor(mode, stack);
  const send = (type: Parameters<Meeting['command']>[0], extra?: Parameters<Meeting['command']>[3]) => {
    setError('');
    void meeting.command(type, undefined, undefined, extra).catch((e) => setError((e as Error).message));
  };
  /*
    Стол открывается одной командой, а правила додепа приезжают следующей.

    Конверт команды один на все типы, и совать в него третье и четвёртое число ради одного
    экрана настройки — значит расширять его для всех. Стол в этот момент пустой: между двумя
    командами с ним всё равно ничего не происходит, а если вторая не дойдёт, правила
    останутся режимными и их видно в настройках игры.
  */
  const bring = async () => {
    setError('');
    try {
      await meeting.command('poker.open', undefined, undefined, { option: mode, chips: stack });
      const fromMode = mode === 'friendly' ? -1 : 0;
      if (limit !== fromMode)
        await meeting.command('poker.settings', undefined, undefined, {
          option: 'rebuy-limit',
          chips: limit < 0 ? undefined : limit,
        });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const chooseMode = (next: PokerMode) => {
    const chosen = POKER_MODES.find((item) => item.id === next) ?? preset;
    // Стек переезжает вместе с режимом, сохраняя кратность: выбрали «вдвое больше обычного» —
    // он и останется вдвое большим, а не сбросится на пять тысяч.
    const ratio = stack / preset.stack;
    setMode(next);
    setStack(Math.round(chosen.stack * (Number.isFinite(ratio) ? ratio : 1)));
  };

  return (
    <div className="games-group">
      <button className="text-button cinema-back" onClick={onBack}>
        <ArrowLeft size={16} /> {t(($) => $.games.back)}
      </button>
      <div className="games-list">
        {GAMES.map((game) => {
          const live =
            game.id === 'poker'
              ? !!table
              : game.id === 'durak'
                ? !!durak
                : game.id === 'chess'
                  ? !!snapshot.chess
                  : !!snapshot.gartic;
          const expanded = open === game.id;
          const seated =
            game.id === 'poker'
              ? (table?.seats.filter((seat) => seat.memberId).length ?? 0)
              : game.id === 'durak'
                ? (durak?.seats.filter((seat) => seat.memberId).length ?? 0)
                : game.id === 'chess'
                  ? [snapshot.chess?.white, snapshot.chess?.black].filter(Boolean).length
                  : (snapshot.gartic?.players.filter((player) => player.active).length ?? 0);
          return (
            <section
              key={game.id}
              style={{ '--game-accent': game.accent } as CSSProperties}
              className="games-item"
              data-open={expanded || undefined}
              data-live={live || undefined}
            >
              <button
                className="games-head"
                aria-expanded={expanded}
                onClick={() => setOpen(expanded ? null : game.id)}
              >
                <span className="games-icon" style={{ background: game.accent }}>
                  {game.id === 'chess' || game.id === 'gartic' ? (
                    <game.icon size={26} aria-hidden="true" />
                  ) : (
                    <img
                      src={`/games/${game.id === 'poker' ? 'poker-hand' : 'card-joker'}.svg`}
                      alt=""
                      width="28"
                      height="28"
                      draggable={false}
                    />
                  )}
                </span>
                <b>
                  {t(($) => $.games.list[game.id].name)}
                  {live && (
                    <span className="games-state" data-live="true">
                      {t(($) => $.games.seated, { count: seated })}
                    </span>
                  )}
                </b>
                {/*
                  Стрелка стоит в своей колонке и по центру всей строки, а не по центру первой её
                  строки: подпись под названием сдвигала её вверх, и выглядело это как съехавшая
                  вёрстка. Поворот — классом, чтобы он был с переходом, а не прыжком.
                */}
                <ChevronDown className="games-chevron" size={18} data-open={expanded || undefined} />
              </button>
              {expanded && (game.id === 'chess' || game.id === 'gartic') && (
                <div className="games-body">
                  <p className="form-footnote">{t(($) => $.games.list[game.id].hint)}</p>
                  {live ? (
                    <>
                      <p>{t(($) => $.games.liveOnStage)}</p>
                      {may(game.id === 'chess' ? 'chess.manage' : 'gartic.manage') && (
                        <button
                          className="button ghost full"
                          onClick={() =>
                            send(game.id === 'chess' ? 'chess.close' : 'gartic.close', {
                              contentId: game.id === 'chess' ? snapshot.chess?.id : snapshot.gartic?.gameId,
                            })
                          }
                        >
                          <X size={16} /> {t(($) => $.games.closeGame)}
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      {game.id === 'chess' ? (
                        <label className="field">
                          {t(($) => $.games.timeControl)}
                          <select
                            aria-label={t(($) => $.games.timeControl)}
                            value={chessPreset}
                            onChange={(event) => setChessPreset(event.target.value)}
                          >
                            {CHESS_PRESETS.map((id) => (
                              <option key={id} value={id}>
                                {t(($) => $.games.chessPresets[id])}
                              </option>
                            ))}
                          </select>
                        </label>
                      ) : (
                        <div
                          className="games-quick"
                          role="group"
                          aria-label={t(($) => $.games.garticModes.group)}
                        >
                          <button
                            data-active={garticMode === 'classic' || undefined}
                            onClick={() => setGarticMode('classic')}
                          >
                            {t(($) => $.games.garticModes.classic)}
                          </button>
                          <button
                            data-active={garticMode === 'telephone' || undefined}
                            onClick={() => setGarticMode('telephone')}
                          >
                            {t(($) => $.games.garticModes.telephone)}
                          </button>
                        </div>
                      )}
                      {game.id === 'gartic' && (
                        <p className="form-footnote">
                          {garticMode === 'classic'
                            ? t(($) => $.games.garticModes.classicHint)
                            : t(($) => $.games.garticModes.telephoneHint)}
                        </p>
                      )}
                      {may(game.id === 'chess' ? 'chess.open' : 'gartic.open') ? (
                        <button
                          className="button primary full"
                          onClick={() =>
                            send(game.id === 'chess' ? 'chess.open' : 'gartic.open', {
                              option: game.id === 'chess' ? chessPreset : garticMode,
                            })
                          }
                        >
                          <game.icon size={17} />{' '}
                          {game.id === 'chess' ? t(($) => $.games.openChess) : t(($) => $.games.openGartic)}
                        </button>
                      ) : (
                        <p className="form-footnote">{t(($) => $.games.restricted)}</p>
                      )}
                    </>
                  )}
                </div>
              )}
              {expanded && game.id === 'durak' && (
                <DurakBody
                  table={durak}
                  canUse={may('durak.open')}
                  host={may('durak.manage')}
                  deck={deck}
                  transfer={transfer}
                  onDeck={setDeck}
                  onTransfer={setTransfer}
                  onSend={send}
                />
              )}
              {expanded &&
                game.id === 'poker' &&
                (live && table ? (
                  <div className="games-body">
                    <ul className="games-facts">
                      <li>
                        <Users size={14} />{' '}
                        {t(($) => $.games.table.seatedOf, {
                          count: table.seats.filter((seat) => seat.memberId).length,
                          total: 10,
                        })}
                      </li>
                      <li>
                        <Coins size={14} />{' '}
                        {t(($) => $.games.table.startingStack, { chips: chips(t, table.startingStack) })}
                      </li>
                      <li>
                        <Timer size={14} />{' '}
                        {t(($) => $.games.table.turnSeconds, { count: table.turnSeconds })}
                      </li>
                      {table.levelUpAt > 0 && (
                        <li>
                          <TrendingUp size={14} /> {t(($) => $.games.table.level, { level: table.level })}
                        </li>
                      )}
                    </ul>
                    {dealer ? (
                      <>
                        {table.phase === 'lobby' && (
                          <button className="button primary full" onClick={() => send('poker.deal')}>
                            <Play size={17} /> {t(($) => $.games.table.deal)}
                          </button>
                        )}
                        <button className="button ghost full" onClick={() => send('poker.close')}>
                          <X size={17} /> {t(($) => $.games.table.remove)}
                        </button>
                      </>
                    ) : (
                      <p className="form-footnote">{t(($) => $.games.table.dealerOnly)}</p>
                    )}
                  </div>
                ) : (
                  <div className="games-body">
                    <div className="games-modes">
                      {POKER_MODES.map((item) => (
                        <button
                          key={item.id}
                          className="games-mode"
                          data-active={mode === item.id ? 'true' : undefined}
                          onClick={() => chooseMode(item.id)}
                        >
                          <b>{t(($) => $.poker.modes[item.id].name)}</b>
                          <small>{t(($) => $.poker.modes[item.id].hint)}</small>
                        </button>
                      ))}
                    </div>
                    <StackChoice preset={preset.stack} stack={stack} blinds={blinds} onChange={setStack} />
                    <RebuyChoice limit={limit} stack={stack} onChange={setRebuys} />
                    {may('poker.open') ? (
                      <button className="button primary full" onClick={() => void bring()}>
                        <Spade size={17} /> {t(($) => $.games.table.open)}
                      </button>
                    ) : (
                      <p className="form-footnote">{t(($) => $.games.restricted)}</p>
                    )}
                  </div>
                ))}
            </section>
          );
        })}
      </div>
      <button className="button game-history-button" onClick={() => setHistory(true)}>
        <History size={17} /> {t(($) => $.games.history.open)}
      </button>
      <Modal open={history} onOpenChange={setHistory} title={t(($) => $.games.history.title)} wide>
        {history && (
          <>
            <GameHistory meeting={meeting} />
            <DurakHistory meeting={meeting} />
          </>
        )}
      </Modal>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Дурак в списке игр.
 *
 * ТЕЛО РАСКРЫТИЯ, А НЕ ОТДЕЛЬНЫЙ ЭКРАН. Список игр для того и сделан списком: у каждой игры своя
 * пара вопросов, и задавать их нужно там же, где выбирают игру. У дурака вопросов ровно два —
 * колода и перевод, — и оба меняются только между партиями, поэтому спрашиваются заранее.
 *
 * Всё остальное, что есть у стола (секунды на ход, посадка, соседи, первый бой), живёт на самой
 * сцене: об этом спрашивают, уже сидя за столом.
 */
function DurakBody({
  table,
  canUse,
  host,
  deck,
  transfer,
  onDeck,
  onTransfer,
  onSend,
}: {
  table: DurakTable | null;
  canUse: boolean;
  host: boolean;
  deck: number;
  transfer: boolean;
  onDeck: (value: number) => void;
  onTransfer: (value: boolean) => void;
  onSend: (type: Parameters<Meeting['command']>[0], extra?: Parameters<Meeting['command']>[3]) => void;
}) {
  const { t } = useTranslation();
  if (table) {
    const seated = table.seats.filter((seat) => seat.memberId).length;
    return (
      <div className="games-body">
        <ul className="games-facts">
          <li>
            <Users size={14} /> {t(($) => $.games.table.seatedOf, { count: seated, total: 6 })}
          </li>
          <li>
            <Layers size={14} /> {t(($) => $.games.table.deck, { count: table.deckSize })}
          </li>
          <li>
            <Shuffle size={14} /> {table.modeName}
          </li>
          <li>
            <Timer size={14} /> {t(($) => $.games.table.turnSeconds, { count: table.turnSeconds })}
          </li>
        </ul>
        {host ? (
          <>
            {table.phase !== 'bout' && (
              <button className="button primary full" onClick={() => onSend('durak.deal')}>
                <Play size={17} /> {t(($) => $.games.table.deal)}
              </button>
            )}
            <button className="button ghost full" onClick={() => onSend('durak.close')}>
              <X size={17} /> {t(($) => $.games.table.remove)}
            </button>
          </>
        ) : (
          <p className="form-footnote">{t(($) => $.games.table.dealerOnly)}</p>
        )}
      </div>
    );
  }
  return (
    <div className="games-body">
      <div className="games-stack">
        <div className="games-stack-head">
          <label>
            {t(($) => $.games.durak.deck)}
            <small>{t(($) => $.games.durak.noJokers)}</small>
          </label>
        </div>
        <div className="games-quick">
          {[36, 52].map((size) => (
            <button key={size} data-active={deck === size || undefined} onClick={() => onDeck(size)}>
              {t(($) => $.games.durak.deckSize, { count: size })}
            </button>
          ))}
        </div>
      </div>
      <div className="games-stack">
        <div className="games-stack-head">
          <label>
            {t(($) => $.games.durak.rules)}
            <small>{t(($) => $.games.durak.transferHint)}</small>
          </label>
        </div>
        <div className="games-quick">
          <button data-active={!transfer || undefined} onClick={() => onTransfer(false)}>
            {t(($) => $.games.durak.podkidnoy)}
          </button>
          <button data-active={transfer || undefined} onClick={() => onTransfer(true)}>
            {t(($) => $.games.durak.perevodnoy)}
          </button>
        </div>
      </div>
      {canUse ? (
        <button
          className="button primary full"
          onClick={() => onSend('durak.open', { option: transfer ? 'perevodnoy' : 'podkidnoy', chips: deck })}
        >
          <Club size={17} /> {t(($) => $.games.table.open)}
        </button>
      ) : (
        <p className="form-footnote">{t(($) => $.games.restricted)}</p>
      )}
    </div>
  );
}

/**
 * Сколько раз можно брать фишки заново.
 *
 * Три готовых ответа и «без ограничений» — потому что за домашним столом именно так и говорят:
 * «без додепов», «по одному», «по три», «сколько влезет». Ноль — это тоже ответ, а не
 * отсутствие настройки, поэтому он назван словом.
 */
const REBUY_CHOICES = [0, 1, 3, -1];

function RebuyChoice({
  limit,
  stack,
  onChange,
}: {
  limit: number;
  stack: number;
  onChange: (value: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="games-stack games-rebuys">
      <div className="games-stack-head">
        <label>
          {t(($) => $.games.rebuys.label)}
          <small>{t(($) => $.games.rebuys.each, { chips: chips(t, stack) })}</small>
        </label>
      </div>
      <div className="games-quick">
        {REBUY_CHOICES.map((choice) => (
          <button key={choice} data-active={limit === choice || undefined} onClick={() => onChange(choice)}>
            {choice === 0
              ? t(($) => $.games.rebuys.none)
              : choice < 0
                ? t(($) => $.games.rebuys.unlimited)
                : String(choice)}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Сколько фишек раздать.
 *
 * ТРИ СПОСОБА СКАЗАТЬ ОДНО ЧИСЛО, И ВСЕ ТРИ НУЖНЫ. Готовые стеки — для «как обычно»; ползунок —
 * когда хочется прикинуть на глаз; поле — когда число уже известно («раздай по двадцать пять
 * тысяч»), и добираться до него ползунком означало бы ловить его мышью. Раньше поля не было, и
 * ровно этот случай был единственным, который не получался.
 *
 * Границы стола — от двухсот фишек до миллиона: ниже не сыграешь, выше — уже не счёт. Написанное
 * приводится к ним молча, а блайнды считаются от стека и округляются до ровных чисел сами, поэтому
 * «двадцать пять тысяч триста» — законная просьба, а не ошибка ввода.
 */
function StackChoice({
  preset,
  stack,
  blinds,
  onChange,
}: {
  preset: number;
  stack: number;
  blinds: { small: number; big: number };
  onChange: (value: number) => void;
}) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState<string | null>(null);
  const accept = (text: string) => {
    const digits = Number(text.replace(/[^\d]/g, ''));
    setTyped(null);
    if (!digits) return;
    onChange(Math.min(MAX_STACK, Math.max(MIN_STACK, Math.round(digits))));
  };
  // Ползунок дотягивается до того, что вписали руками: иначе поле показывало бы одно число, а
  // ползунок стоял бы на другом.
  const top = Math.min(MAX_STACK, Math.max(preset * 10, stack));
  return (
    <div className="games-stack">
      <div className="games-stack-head">
        <label>
          {t(($) => $.games.stack.label)}
          <input
            className="games-stack-input"
            type="text"
            inputMode="numeric"
            value={typed ?? chips(t, stack)}
            onChange={(event) => setTyped(event.target.value)}
            onBlur={(event) => accept(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                accept((event.target as HTMLInputElement).value);
              }
              if (event.key === 'Escape') setTyped(null);
            }}
            aria-label={t(($) => $.games.stack.input)}
          />
        </label>
        <small>
          {t(($) => $.games.stack.blinds, { small: chips(t, blinds.small), big: chips(t, blinds.big) })}
        </small>
      </div>
      <input
        className="slider"
        type="range"
        min={MIN_STACK}
        max={top}
        step={Math.max(50, Math.round(preset / 50))}
        value={Math.min(stack, top)}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label={t(($) => $.games.stack.slider)}
      />
      <div className="games-quick">
        {STACK_STEPS.map((step) => {
          const value = Math.round(preset * step);
          return (
            <button key={step} data-active={stack === value || undefined} onClick={() => onChange(value)}>
              {chips(t, value)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Партии дурака этой беседы.
 *
 * СЧЁТ ВЕЧЕРА СТОИТ НАД СПИСКОМ, А НЕ ВНУТРИ НЕГО. За столом спрашивают «сколько у кого», а не
 * «чем кончилась третья партия» — поэтому первое видно сразу, а второе раскрывается. Счёт берётся
 * из последней записи: каждая партия несёт его на свой момент, и складывать список заново не
 * нужно.
 *
 * Перечитывается по метке снимка ({@code durakGamesAt}) — ровно та же ловушка, что у покера:
 * ключ от самого стола уводил запрос в миг окончания партии, то есть до того, как ядро успевало
 * её записать.
 */
function DurakHistory({ meeting }: { meeting: Meeting }) {
  const { t } = useTranslation();
  const snapshot = useStore(meeting.snapshot);
  const [open, setOpen] = useState<string | null>(null);
  const games = useQuery({
    queryKey: ['durak-games', meeting.admission.roomId, snapshot.durakGamesAt],
    queryFn: meeting.api.durakGames,
    placeholderData: keepPreviousData,
    staleTime: 10000,
  });
  const list = [...(games.data ?? [])].reverse();
  if (games.isPending) return <p role="status">{t(($) => $.games.history.loading)}</p>;
  if (games.isError)
    return (
      <p role="alert">
        {t(($) => $.games.history.failed)}{' '}
        <button className="text-button" onClick={() => void games.refetch()}>
          {t(($) => $.games.history.retry)}
        </button>
      </p>
    );
  if (!list.length) return <p className="muted">{t(($) => $.games.history.empty)}</p>;
  const score = [...(list[0]?.players ?? [])].sort(
    (a, b) => b.fools - a.fools || a.name.localeCompare(b.name),
  );
  return (
    <section className="games-history">
      <h4>
        <Club size={15} /> {t(($) => $.games.durakHistory.title)} ·{' '}
        {t(($) => $.games.durakHistory.games, { count: list.length })}
      </h4>
      {score.length > 1 && (
        <ul className="games-score">
          {score.map((player) => (
            <li key={player.name}>
              <b>{player.name}</b>
              <span>{t(($) => $.games.durakHistory.fools, { count: player.fools })}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="games-list">
        {list.map((game) => {
          const expanded = open === game.id;
          return (
            <article key={game.id} className="games-item" data-open={expanded || undefined}>
              <button
                className="games-head"
                aria-expanded={expanded}
                onClick={() => setOpen(expanded ? null : game.id)}
              >
                <span className="games-icon" style={{ background: '#2b3442' }}>
                  <Club size={18} />
                </span>
                <b>{t(($) => $.games.durakHistory.game, { number: game.number })}</b>
                <ChevronDown className="games-chevron" size={18} data-open={expanded || undefined} />
                {/* Ничьей нет (R111); без дурака — только запись прежнего ядра, и о нём просто молчим. */}
                <small>
                  {game.foolName ? `${t(($) => $.games.durakHistory.fool, { name: game.foolName })} · ` : ''}
                  {t(($) => $.games.durakHistory.bouts, { count: game.bouts })} ·{' '}
                  {game.modeName.toLowerCase()}
                </small>
              </button>
              {expanded && (
                <div className="games-body">
                  <table className="durak-score-table">
                    <thead>
                      <tr>
                        <th>{t(($) => $.games.durakHistory.columns.player)}</th>
                        <th>{t(($) => $.games.durakHistory.columns.fool)}</th>
                        <th>{t(($) => $.games.durakHistory.columns.took)}</th>
                        <th>{t(($) => $.games.durakHistory.columns.defended)}</th>
                        <th>{t(($) => $.games.durakHistory.columns.trumps)}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {game.players.map((player) => (
                        <tr key={player.name} data-fool={player.fool || undefined}>
                          <td>{player.name}</td>
                          <td>{player.fools}</td>
                          <td>{player.takes}</td>
                          <td>{player.defences}</td>
                          <td>{player.trumpsBurned}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {game.highlights.length > 0 && (
                    <ul className="games-highlights">
                      {game.highlights.map((line) => (
                        <li key={line.id}>
                          <b>{line.title}</b>
                          <span>
                            {line.name} — {line.value}
                          </span>
                          <small>{line.hint}</small>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

/**
 * История игр этой беседы.
 *
 * ИТОГ, А НЕ ЛОГ. Ход раздач не хранится вовсе: «кто что сходил на ривере» через день не нужно
 * никому. Остаётся то, с чем люди встали из-за стола, — кто играл, сколько докупался, сколько
 * поставил, кто сорвал самый крупный банк, — и спрашивается это отдельной ручкой, а не приезжает в
 * каждом снимке комнаты: десять таких таблиц в снимке означали бы килобайты на каждое чужое
 * повышение.
 *
 * СПИСОК ПЕРЕЧИТЫВАЕТСЯ ПО МЕТКЕ СНИМКА, А НЕ ПО ИСЧЕЗНОВЕНИЮ СТОЛА. Сначала здесь стоял ключ от
 * самого стола — и запрос уходил в тот самый миг, когда игра кончилась, то есть **до** того, как
 * ядро успело её записать: список приезжал пустым и больше не обновлялся. Метка {@code
 * pokerGamesAt} меняется ровно в момент записи, чем бы игра ни кончилась (победитель, убранный
 * стол, пустой стол, конец встречи), — по ней список и перечитывается.
 */
function GameHistory({ meeting }: { meeting: Meeting }) {
  const { t } = useTranslation();
  const snapshot = useStore(meeting.snapshot);
  const [open, setOpen] = useState<string | null>(null);
  const games = useQuery({
    queryKey: ['poker-games', meeting.admission.roomId, snapshot.pokerGamesAt],
    queryFn: meeting.api.games,
    // Новая игра меняет ключ, а список при этом не должен мигать пустотой: прошлые итоги
    // остаются на экране, пока не приедут новые.
    placeholderData: keepPreviousData,
    staleTime: 10000,
  });
  const list = [...(games.data ?? [])].reverse();
  if (games.isPending) return <p role="status">{t(($) => $.games.history.loading)}</p>;
  if (games.isError)
    return (
      <p role="alert">
        {t(($) => $.games.history.failed)}{' '}
        <button className="text-button" onClick={() => void games.refetch()}>
          {t(($) => $.games.history.retry)}
        </button>
      </p>
    );
  if (!list.length) return <p className="muted">{t(($) => $.games.history.empty)}</p>;
  return (
    <section className="games-history">
      <h4>
        <History size={15} /> {t(($) => $.games.pokerHistory.title)}
      </h4>
      <div className="games-list">
        {list.map((game) => {
          const expanded = open === game.id;
          const winner = winnerOf(game);
          return (
            <article key={game.id} className="games-item" data-open={expanded || undefined}>
              <button
                className="games-head"
                aria-expanded={expanded}
                onClick={() => setOpen(expanded ? null : game.id)}
              >
                <span className="games-icon" style={{ background: '#2b3442' }}>
                  <Spade size={18} />
                </span>
                <b>{gameTitle(t, game)}</b>
                <ChevronDown className="games-chevron" size={18} data-open={expanded || undefined} />
                <small>
                  {game.modeName} · {t(($) => $.games.pokerHistory.hands, { count: game.hands })}
                  {winner ? ` · ${t(($) => $.games.pokerHistory.leader, { name: winner.name })}` : ''}
                </small>
              </button>
              {expanded && (
                <div className="games-body">
                  <GameResult game={game} />
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
