import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  ChevronDown,
  Coins,
  History,
  Play,
  Spade,
  Timer,
  TrendingUp,
  Users,
  X,
} from 'lucide-react';
import type { Meeting } from '../core/meeting';
import type { PokerMode } from '../api/types';
import {
  blindsFor,
  chips,
  gameTitle,
  MAX_STACK,
  MIN_STACK,
  plural,
  POKER_MODES,
  winnerOf,
} from '../core/poker';
import { GameResult } from './PokerResult';
import { useStore } from './primitives';

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
type GameId = 'poker';

const GAMES: {
  id: GameId;
  name: string;
  hint: string;
  accent: string;
}[] = [{ id: 'poker', name: 'Покер', hint: 'Безлимитный холдем, до десяти игроков', accent: '#8a5cf6' }];

/** Во сколько раз стартовый стек больше или меньше обычного для режима. */
const STACK_STEPS = [0.5, 1, 2, 5];

export function GamesGroup({ meeting, onBack }: { meeting: Meeting; onBack: () => void }) {
  const snapshot = useStore(meeting.snapshot);
  const self = snapshot.participants.find((p) => p.id === meeting.admission.participantId);
  const canUse = !!self && (self.owner || snapshot.integrationsAllowed !== false);
  const table = snapshot.poker;
  const dealer = !!table && (table.hostId === self?.id || !!self?.owner);
  // Стол уже стоит — значит, открыта его строка; иначе открывается та, на которую нажали.
  const [open, setOpen] = useState<GameId | null>(table ? 'poker' : null);
  const [mode, setMode] = useState<PokerMode>('friendly');
  const preset = POKER_MODES.find((item) => item.id === mode) ?? POKER_MODES[0]!;
  const [stack, setStack] = useState(preset.stack);
  /*
    Правила додепа задаются заранее, вместе со стеком: «сколько раз можно взять фишки заново» —
    это про условия игры, а не про настройку по ходу. Дружеская игра пускает без ограничений,
    турнир — ни разу; дальше это решение ведущего, и менять его можно и потом.
  */
  const [rebuys, setRebuys] = useState<number | null>(null);
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
        <ArrowLeft size={16} /> Группы интеграций
      </button>
      <div className="games-list">
        {GAMES.map((game) => {
          const live = game.id === 'poker' && !!table;
          const expanded = open === game.id;
          return (
            <section
              key={game.id}
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
                  <Spade size={20} />
                </span>
                <b>
                  {game.name}
                  {live && (
                    <span className="games-state" data-live="true">
                      За столом {table.seats.filter((seat) => seat.memberId).length}
                    </span>
                  )}
                </b>
                {/*
                  Стрелка стоит в своей колонке и по центру всей строки, а не по центру первой её
                  строки: подпись под названием сдвигала её вверх, и выглядело это как съехавшая
                  вёрстка. Поворот — классом, чтобы он был с переходом, а не прыжком.
                */}
                <ChevronDown className="games-chevron" size={18} data-open={expanded || undefined} />
                <small>
                  {live
                    ? `${table.modeName} · блайнды ${chips(table.smallBlind)}/${chips(table.bigBlind)}`
                    : game.hint}
                </small>
              </button>
              {expanded &&
                (live ? (
                  <div className="games-body">
                    <ul className="games-facts">
                      <li>
                        <Users size={14} /> За столом {table.seats.filter((seat) => seat.memberId).length} из
                        10
                      </li>
                      <li>
                        <Coins size={14} /> Стартовый стек {chips(table.startingStack)}
                      </li>
                      <li>
                        <Timer size={14} /> {table.turnSeconds} секунд на ход
                      </li>
                      {table.levelUpAt > 0 && (
                        <li>
                          <TrendingUp size={14} /> Уровень {table.level}
                        </li>
                      )}
                    </ul>
                    {dealer ? (
                      <>
                        {table.phase === 'lobby' && (
                          <button className="button primary full" onClick={() => send('poker.deal')}>
                            <Play size={17} /> Раздать
                          </button>
                        )}
                        <button className="button ghost full" onClick={() => send('poker.close')}>
                          <X size={17} /> Убрать стол из встречи
                        </button>
                      </>
                    ) : (
                      <p className="form-footnote">Раздаёт тот, кто принёс стол, и ведущий встречи.</p>
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
                          <b>{item.name}</b>
                          <small>{item.hint}</small>
                        </button>
                      ))}
                    </div>
                    <StackChoice preset={preset.stack} stack={stack} blinds={blinds} onChange={setStack} />
                    <RebuyChoice limit={limit} stack={stack} onChange={setRebuys} />
                    {canUse ? (
                      <button className="button primary full" onClick={() => void bring()}>
                        <Spade size={17} /> Открыть стол
                      </button>
                    ) : (
                      <p className="form-footnote">Добавление интеграций ограничено организатором.</p>
                    )}
                  </div>
                ))}
            </section>
          );
        })}
      </div>
      <GameHistory meeting={meeting} />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
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
const REBUY_CHOICES: { value: number; label: string }[] = [
  { value: 0, label: 'Без додепов' },
  { value: 1, label: '1' },
  { value: 3, label: '3' },
  { value: -1, label: 'Без ограничений' },
];

function RebuyChoice({
  limit,
  stack,
  onChange,
}: {
  limit: number;
  stack: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="games-stack games-rebuys">
      <div className="games-stack-head">
        <label>
          Додепы на человека
          <small>по {chips(stack)}</small>
        </label>
      </div>
      <div className="games-quick">
        {REBUY_CHOICES.map((choice) => (
          <button
            key={choice.value}
            data-active={limit === choice.value || undefined}
            onClick={() => onChange(choice.value)}
          >
            {choice.label}
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
          Стартовый стек
          <input
            className="games-stack-input"
            type="text"
            inputMode="numeric"
            value={typed ?? chips(stack)}
            onChange={(event) => setTyped(event.target.value)}
            onBlur={(event) => accept(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                accept((event.target as HTMLInputElement).value);
              }
              if (event.key === 'Escape') setTyped(null);
            }}
            aria-label="Стартовый стек, фишки"
          />
        </label>
        <small>
          блайнды {chips(blinds.small)}/{chips(blinds.big)}
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
        aria-label="Стартовый стек"
      />
      <div className="games-quick">
        {STACK_STEPS.map((step) => {
          const value = Math.round(preset * step);
          return (
            <button key={step} data-active={stack === value || undefined} onClick={() => onChange(value)}>
              {chips(value)}
            </button>
          );
        })}
      </div>
    </div>
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
  if (!list.length) return null;
  return (
    <section className="games-history">
      <h4>
        <History size={15} /> История игр
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
                <b>{gameTitle(game)}</b>
                <ChevronDown className="games-chevron" size={18} data-open={expanded || undefined} />
                <small>
                  {game.modeName} · {plural(game.hands, 'раздача', 'раздачи', 'раздач')}
                  {winner ? ` · впереди ${winner.name}` : ''}
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
