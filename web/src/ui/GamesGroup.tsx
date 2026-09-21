import { useState } from 'react';
import { ArrowLeft, ChevronDown, Coins, Play, Spade, Timer, TrendingUp, Users, X } from 'lucide-react';
import type { Meeting } from '../core/meeting';
import type { PokerMode } from '../api/types';
import { blindsFor, chips, MAX_STACK, MIN_STACK, POKER_MODES } from '../core/poker';
import { useStore } from './primitives';

/**
 * Игры в панели интеграций.
 *
 * СПИСОК, А НЕ СТРАНИЦА НА ИГРУ. Покер здесь первый, но не последний, и отдельный экран под
 * каждую новую игру — это десяток разных экранов через год, в которых одно и то же называется
 * по-разному. Поэтому здесь список: у каждой игры строка, по нажатию она раскрывается прямо в
 * списке — режим, настройки, кнопка, — и раскрытой остаётся одна.
 *
 * Сама игра живёт на сцене: в узкой колонке стол превратился бы в таблицу с номерами мест.
 * Панели остаётся то, для чего она и нужна, — принести, настроить и убрать.
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
  const [error, setError] = useState('');
  const blinds = blindsFor(mode, stack);
  const send = (type: Parameters<Meeting['command']>[0], extra?: Parameters<Meeting['command']>[3]) => {
    setError('');
    void meeting.command(type, undefined, undefined, extra).catch((e) => setError((e as Error).message));
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
                <ChevronDown
                  size={18}
                  style={{ transform: expanded ? 'rotate(180deg)' : undefined, flex: '0 0 auto' }}
                />
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
                    <p className="form-footnote">
                      Стол открыт на сцене. Свободное место занимают нажатием на стул, а выйти из-за стола
                      можно в любой момент — фишки останутся до конца встречи.
                    </p>
                    {dealer ? (
                      <>
                        {table.phase === 'lobby' && (
                          <button className="button primary full" onClick={() => send('poker.deal')}>
                            <Play size={17} /> Раздать
                          </button>
                        )}
                        <label className="games-toggle">
                          <input
                            type="checkbox"
                            checked={table.seatingOpen}
                            onChange={() =>
                              send('poker.settings', {
                                option: table.seatingOpen ? 'seating-locked' : 'seating-open',
                              })
                            }
                          />
                          <span>
                            <b>Пускать новых за стол</b>
                            <small>
                              Выключено — сыграть до конца игры не получится никому, кроме тех, кто уже сидит.
                            </small>
                          </span>
                        </label>
                        <label className="games-toggle">
                          <input
                            type="checkbox"
                            checked={table.autoDeal}
                            onChange={() => send('poker.settings', { option: 'auto-deal' })}
                          />
                          <span>
                            <b>Раздавать подряд</b>
                            <small>Выключено — каждую раздачу начинаете вы.</small>
                          </span>
                        </label>
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
                    {/*
                      Стек выбирают одним числом, а блайнды считаются от него: глубина режима
                      сохраняется, и «раздайте по десять тысяч» не превращается в игру, где
                      первая ставка ничего не решает.
                    */}
                    <div className="games-stack">
                      <div className="games-stack-head">
                        <span>
                          Стартовый стек <b>{chips(stack)}</b>
                        </span>
                        <small>
                          блайнды {chips(blinds.small)}/{chips(blinds.big)}
                        </small>
                      </div>
                      <input
                        className="slider"
                        type="range"
                        min={MIN_STACK}
                        max={Math.min(MAX_STACK, preset.stack * 10)}
                        step={Math.max(50, Math.round(preset.stack / 50))}
                        value={Math.min(stack, Math.min(MAX_STACK, preset.stack * 10))}
                        onChange={(event) => setStack(Number(event.target.value))}
                        aria-label="Стартовый стек"
                      />
                      <div className="games-quick">
                        {STACK_STEPS.map((step) => {
                          const value = Math.round(preset.stack * step);
                          return (
                            <button
                              key={step}
                              data-active={stack === value || undefined}
                              onClick={() => setStack(value)}
                            >
                              {chips(value)}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    {canUse ? (
                      <button
                        className="button primary full"
                        onClick={() => send('poker.open', { option: mode, chips: stack })}
                      >
                        <Spade size={17} /> Открыть стол
                      </button>
                    ) : (
                      <p className="form-footnote">Добавление интеграций ограничено организатором.</p>
                    )}
                    <p className="form-footnote">
                      Фишки — игровые: ни ставок на деньги, ни счетов здесь нет. Музыка столу не мешает и
                      может играть одновременно; кинозал — нет, сцена у них одна.
                    </p>
                  </div>
                ))}
            </section>
          );
        })}
      </div>
      <p className="form-footnote">Здесь появятся и другие игры — список для того и сделан.</p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
