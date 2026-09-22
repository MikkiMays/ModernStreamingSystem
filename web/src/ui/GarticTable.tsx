import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  BookOpen,
  Check,
  CheckCheck,
  Eye,
  LogOut,
  Palette,
  Pencil,
  Play,
  Send,
  Users,
  X,
} from 'lucide-react';
import type { Meeting } from '../core/meeting';
import type { GarticTable as Table } from '../api/types';
import { GamePeople, GamePerson } from './GamePeople';
import { GameTurn } from './GamePresentation';
import { AlbumReveal, ClassicResults } from './GarticResults';
import { IconButton, useStore } from './primitives';
import GarticCanvas, { GarticPicture, type GarticCanvasHandle } from './GarticCanvas';
import '../gartic.css';

type SendCommand = (
  type: Parameters<Meeting['command']>[0],
  text?: string,
  extra?: Parameters<Meeting['command']>[3],
) => Promise<unknown>;

export default function GarticTable({ meeting }: { meeting: Meeting }) {
  const snapshot = useStore(meeting.snapshot);
  const table = snapshot.gartic;
  if (!table) return null;
  const owner = !!snapshot.participants.find((person) => person.id === meeting.admission.participantId)
    ?.owner;
  return <GarticGame key={table.gameId} meeting={meeting} table={table} owner={owner} />;
}

function GarticGame({ meeting, table, owner }: { meeting: Meeting; table: Table; owner: boolean }) {
  const connection = useStore(meeting.control.state);
  const connected = connection === 'connected';
  const me = meeting.admission.participantId;
  const host = table.hostId === me || owner;
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const pendingAction = useRef(false);
  const phone = table.mode === 'telephone';
  const lobby = table.phase === 'lobby';
  const ended = table.phase === 'finished' || table.phase === 'reveal';
  const players = table.players.filter((player) => player.active && !player.away);
  const minimum = phone ? 3 : 2;
  const phaseKey = `${table.gameId}:${table.turnToken}`;
  const send: SendCommand = (type, text, extra) =>
    meeting.command(type, text, undefined, {
      contentId: table.gameId,
      positionMs: table.turnToken,
      ...extra,
    });
  const act = async (
    type: Parameters<Meeting['command']>[0],
    text?: string,
    extra?: Parameters<Meeting['command']>[3],
  ) => {
    if (pendingAction.current) return;
    pendingAction.current = true;
    setError('');
    setPending(true);
    try {
      await send(type, text, extra);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      pendingAction.current = false;
      setPending(false);
    }
  };
  const phaseLabel = lobby
    ? 'Собираемся за столом'
    : table.phase === 'choosing'
      ? table.you?.choices.length
        ? 'Выберите слово'
        : 'Художник выбирает слово'
      : table.phase === 'round-reveal'
        ? 'Слово раскрыто'
        : table.phase === 'finished'
          ? 'Игра завершена'
          : table.phase === 'reveal'
            ? 'Смотрим, что получилось'
            : table.you?.submitted
              ? 'Готово. Ждём остальных'
              : table.phase === 'prompt'
                ? table.you?.playing
                  ? 'Придумайте начало истории'
                  : 'Участники придумывают истории'
                : table.phase === 'describing'
                  ? table.you?.playing
                    ? 'Опишите рисунок'
                    : 'Участники описывают рисунки'
                  : table.you?.canDraw
                    ? 'Время рисовать'
                    : phone
                      ? 'Рисуем полученные фразы'
                      : 'Угадайте слово';

  return (
    <section className="gartic" aria-label="Gartic" data-phase={table.phase}>
      <header className="gartic-header">
        <div className="gartic-heading">
          <Palette size={23} />
          <div>
            <h2>Gartic</h2>
            <span>{phone ? 'Испорченный телефон' : 'Рисуй и угадывай'}</span>
          </div>
        </div>
        {!lobby && !(phone && ended) && (
          <span className="gartic-round">
            {phone
              ? `Шаг ${Math.min(table.step + 1, table.totalSteps)} из ${table.totalSteps}`
              : `Круг ${table.round} из ${table.rounds}`}
          </span>
        )}
        <div className="gartic-header-actions">
          <details className="gartic-rules">
            <summary>
              <BookOpen size={16} /> Правила
            </summary>
            <div>
              {phone ? (
                <p>
                  Каждый придумывает фразу, следующий её рисует, а следующий описывает рисунок. Вы видите
                  только предыдущий шаг. В конце ведущий показывает все истории.
                </p>
              ) : (
                <p>
                  По очереди выбирайте и рисуйте слово без букв и цифр. Остальные пишут ответы. Чем быстрее
                  угадаете, тем больше очков. Художник получает очки за каждый верный ответ.
                </p>
              )}
              <p>Голосовой разговор продолжается. Не произносите загаданное слово вслух.</p>
            </div>
          </details>
          {host && (
            <IconButton
              label="Закрыть Gartic"
              disabled={!connected || pending}
              onClick={() => void act('gartic.close')}
            >
              <X size={18} />
            </IconButton>
          )}
        </div>
      </header>
      {!connected && (
        <div className="gartic-connection" role="status">
          Восстанавливаем связь с игрой…
        </div>
      )}
      {error && (
        <div className="gartic-error" role="alert">
          {error}
        </div>
      )}
      <GameTurn
        meeting={meeting}
        deadline={table.deadline}
        active={!lobby && !ended && table.deadline > 0}
        label={phaseLabel}
      />

      {lobby ? (
        <div className="gartic-lobby">
          <div className="gartic-lobby-intro">
            <div className="gartic-sketch" aria-hidden="true">
              <Pencil size={42} strokeWidth={1.3} />
              <span>
                Нарисуйте.
                <br />
                Удивите друзей.
              </span>
            </div>
            <h3>{phone ? 'Одна фраза. Десяток неожиданных поворотов.' : 'Понятно без слов?'}</h3>
            <p>
              {phone
                ? 'Передавайте рисунки и описания по кругу, а потом вместе смотрите, во что превратилась первая идея.'
                : 'Кто-то рисует, остальные угадывают. Даже самые странные каракули могут принести победу.'}
            </p>
          </div>
          <div className="gartic-lobby-options">
            <div className="gartic-mode-picker" aria-label="Режим Gartic">
              <button
                type="button"
                aria-pressed={!phone}
                disabled={!host || pending || !connected}
                onClick={() => void act('gartic.settings', undefined, { option: 'classic' })}
              >
                <Palette size={20} />
                <b>Рисуй и угадывай</b>
                <span>От 2 игроков, очки за ответы</span>
              </button>
              <button
                type="button"
                aria-pressed={phone}
                disabled={!host || pending || !connected}
                onClick={() => void act('gartic.settings', undefined, { option: 'telephone' })}
              >
                <BookOpen size={20} />
                <b>Испорченный телефон</b>
                <span>От 3 игроков, общие истории</span>
              </button>
            </div>
            {!phone && (
              <div className="gartic-settings">
                <label>
                  Кругов
                  <select
                    value={table.rounds}
                    disabled={!host || pending || !connected}
                    onChange={(event) =>
                      void act('gartic.settings', undefined, {
                        option: 'rounds',
                        chips: Number(event.target.value),
                      })
                    }
                  >
                    {[2, 3, 4, 5].map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  На рисунок
                  <select
                    value={table.turnSeconds}
                    disabled={!host || pending || !connected}
                    onChange={(event) =>
                      void act('gartic.settings', undefined, {
                        option: 'turn-seconds',
                        chips: Number(event.target.value),
                      })
                    }
                  >
                    {[45, 60, 90].map((value) => (
                      <option key={value} value={value}>
                        {value} с
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            {phone && (
              <p className="gartic-small">
                45 секунд на фразу, 90 секунд на рисунок. Каждый участвует в каждой истории.
              </p>
            )}
            <div className="gartic-lobby-players">
              <Users size={17} />
              <b>{players.length} из 10 игроков</b>
              <span>{players.map((player) => player.name).join(', ') || 'Присоединитесь первым'}</span>
            </div>
            <div className="gartic-actions">
              {!table.you ? (
                <button
                  type="button"
                  className="button primary"
                  disabled={pending || !connected}
                  onClick={() => void act('gartic.join')}
                >
                  <Users size={17} /> Присоединиться
                </button>
              ) : (
                <span className="gartic-ready">
                  <Check size={17} /> Вы в игре
                </span>
              )}
              {host && (
                <button
                  type="button"
                  className="button primary"
                  disabled={pending || !connected || players.length < minimum}
                  onClick={() => void act('gartic.start')}
                >
                  <Play size={17} /> Начать игру
                </button>
              )}
            </div>
            {players.length < minimum && (
              <p className="gartic-small">
                Для старта нужно ещё {minimum - players.length}{' '}
                {minimum - players.length === 1 ? 'участник' : 'участника'}.
              </p>
            )}
            {!host && <p className="gartic-small">Игру запускает ведущий.</p>}
          </div>
        </div>
      ) : table.phase === 'reveal' ? (
        <AlbumReveal
          meeting={meeting}
          table={table}
          host={host}
          disabled={!connected || pending}
          pending={pending}
          onReveal={(album, entry) => void act('gartic.reveal', undefined, { chips: album, seat: entry })}
        />
      ) : table.phase === 'finished' ? (
        <ClassicResults table={table} meeting={meeting} />
      ) : (
        <div className={`gartic-play ${phone ? 'gartic-play-phone' : ''}`}>
          <div className="gartic-workspace">
            {phone ? (
              <PhoneTask key={phaseKey} meeting={meeting} table={table} send={send} connected={connected} />
            ) : (
              <ClassicTask key={phaseKey} table={table} send={send} connected={connected} />
            )}
          </div>
          <aside className="gartic-sidebar" aria-label={phone ? 'Прогресс игроков' : 'Ответы и счёт'}>
            <Scoreboard table={table} meeting={meeting} />
            {!phone && <GuessPanel key={phaseKey} table={table} send={send} connected={connected} />}
          </aside>
        </div>
      )}

      <footer className="gartic-footer">
        <div className="gartic-footer-state">
          {!table.you && !lobby && (
            <>
              <span>
                <Eye size={16} /> Вы наблюдаете
              </span>
              <button
                type="button"
                className="button secondary"
                disabled={!connected || pending}
                onClick={() => void act('gartic.join')}
              >
                Играть в следующей партии
              </button>
            </>
          )}
          {table.you && !table.you.playing && !lobby && !ended && (
            <span>
              <Check size={16} /> Вы присоединились к следующей партии
            </span>
          )}
          {table.you && (
            <button
              type="button"
              className="text-button"
              disabled={!connected || pending}
              onClick={() => void act('gartic.leave')}
            >
              <LogOut size={15} /> {lobby || ended ? 'Покинуть игру' : 'Стать зрителем'}
            </button>
          )}
          {host && ended && (
            <button
              type="button"
              className="button primary"
              disabled={!connected || pending}
              onClick={() => void act('gartic.start')}
            >
              <Play size={16} /> Сыграть снова
            </button>
          )}
          {!host && ended && <span>Следующую игру запускает ведущий</span>}
        </div>
        <GamePeople meeting={meeting} />
      </footer>
    </section>
  );
}

function ClassicTask({ table, send, connected }: { table: Table; send: SendCommand; connected: boolean }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const choosing = table.phase === 'choosing';
  const choices = table.you?.choices ?? [];
  const choose = async (index: number) => {
    setPending(true);
    setError('');
    try {
      await send('gartic.choose', undefined, { chips: index });
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <div className="gartic-word" aria-live="polite">
        <span>{table.answer ? 'Это было слово' : table.you?.canDraw ? 'Вы рисуете' : 'Угадайте слово'}</span>
        <strong>{table.answer ?? (table.you?.canDraw ? table.you.prompt : table.hint) ?? '…'}</strong>
        {table.you?.canDraw && <small>Слово видно только вам</small>}
      </div>
      {choosing && choices.length > 0 ? (
        <div className="gartic-choose">
          <Pencil size={34} strokeWidth={1.5} />
          <h3>Что будете рисовать?</h3>
          <p>Выберите одно из трёх слов.</p>
          <div>
            {choices.map((word, index) => (
              <button
                key={word}
                type="button"
                disabled={!connected || pending}
                onClick={() => void choose(index)}
              >
                {word}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <GarticCanvas
          strokes={table.canvas}
          editable={!!table.you?.canDraw}
          smoothRemote={table.phase === 'drawing' && !table.you?.canDraw}
          connected={connected}
          onDraw={(text) => send('gartic.draw', text)}
          onEdit={(option) => send('gartic.canvas', undefined, { option })}
        />
      )}
      {error && (
        <p className="gartic-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

function GuessPanel({ table, send, connected }: { table: Table; send: SendCommand; connected: boolean }) {
  const [guess, setGuess] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const log = useRef<HTMLOListElement>(null);
  const guessed = table.players.find((player) => player.memberId === table.you?.memberId)?.guessed;
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [table.guesses.length]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!guess.trim() || !table.you?.canGuess || pending) return;
    setPending(true);
    setError('');
    try {
      await send('gartic.guess', guess.trim());
      setGuess('');
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="gartic-guesses">
      <h3>Догадки</h3>
      <ol ref={log} role="log" aria-label="Догадки игроков" aria-live="polite" aria-relevant="additions">
        {table.guesses.map((entry) => (
          <li key={entry.id} data-correct={entry.correct || undefined}>
            <b>{entry.name}</b>
            <span>
              {entry.correct ? (
                <>
                  <Check size={14} /> Угадал слово
                </>
              ) : (
                entry.text
              )}
            </span>
          </li>
        ))}
        {!table.guesses.length && (
          <li className="gartic-empty-guesses">
            {table.phase === 'drawing' ? 'Первая догадка за вами' : 'Здесь будут ответы игроков'}
          </li>
        )}
      </ol>
      {table.you?.canGuess ? (
        <form onSubmit={(event) => void submit(event)}>
          <input
            aria-label="Ваша догадка"
            placeholder="Что нарисовано?"
            value={guess}
            maxLength={80}
            autoComplete="off"
            disabled={!connected || pending}
            onChange={(event) => setGuess(event.target.value)}
          />
          <button
            type="submit"
            aria-label="Отправить догадку"
            disabled={!connected || pending || !guess.trim()}
          >
            <Send size={18} />
          </button>
        </form>
      ) : guessed ? (
        <p className="gartic-guessed">
          <CheckCheck size={18} /> Вы угадали! Не подсказывайте остальным.
        </p>
      ) : (
        <p className="gartic-small">
          {table.you?.canDraw
            ? 'Рисуйте — ответы оставьте другим.'
            : 'Ответы доступны участникам, которые сейчас угадывают.'}
        </p>
      )}
      {error && (
        <p className="gartic-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function PhoneTask({
  table,
  send,
  connected,
  meeting,
}: {
  table: Table;
  send: SendCommand;
  connected: boolean;
  meeting: Meeting;
}) {
  const canvas = useRef<GarticCanvasHandle>(null);
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const you = table.you;
  if (!you?.playing)
    return (
      <div className="gartic-phone-wait">
        <Eye size={34} strokeWidth={1.3} />
        <h3>Истории пока в секрете</h3>
        <p>Участники рисуют и описывают их друг для друга. Когда закончат, посмотрим все альбомы вместе.</p>
      </div>
    );
  const drawing = table.phase === 'drawing';
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || !you.canSubmit || (!drawing && !text.trim())) return;
    setPending(true);
    setError('');
    try {
      if (drawing) await canvas.current?.flush();
      await send('gartic.submit', drawing ? undefined : text.trim());
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setPending(false);
    }
  };
  return (
    <form className="gartic-phone-task" onSubmit={(event) => void submit(event)}>
      {table.phase === 'prompt' ? (
        <div className="gartic-prompt-intro">
          <BookOpen size={34} strokeWidth={1.3} />
          <h3>С чего начнём историю?</h3>
          <p>
            Придумайте фразу, которую будет интересно нарисовать. Например: «Космонавт выгуливает улитку».
          </p>
        </div>
      ) : drawing ? (
        <div className="gartic-phone-prompt">
          <span>Нарисуйте эту фразу</span>
          <blockquote>{you.prompt ?? you.previous?.text ?? 'Предыдущий участник пропустил ход'}</blockquote>
        </div>
      ) : you.previous?.kind === 'drawing' ? (
        <GarticPicture strokes={you.previous.strokes} label="Рисунок, который нужно описать" />
      ) : (
        <div className="gartic-phone-wait">
          <Pencil size={28} />
          <p>Предыдущий участник не успел нарисовать. Придумайте, что здесь могло быть.</p>
        </div>
      )}
      {drawing ? (
        <GarticCanvas
          ref={canvas}
          strokes={table.canvas}
          editable={you.canDraw}
          locked={pending}
          connected={connected}
          interval={500}
          onDraw={(value) => send('gartic.draw', value)}
          onEdit={(option) => send('gartic.canvas', undefined, { option })}
        />
      ) : (
        <label className="gartic-text-entry">
          {table.phase === 'prompt' ? 'Ваша фраза' : 'Что здесь нарисовано?'}
          <textarea
            value={text}
            maxLength={120}
            rows={3}
            placeholder={
              table.phase === 'prompt' ? 'Одна неожиданная идея…' : 'Опишите рисунок одной фразой…'
            }
            disabled={!connected || pending || you.submitted}
            onChange={(event) => setText(event.target.value)}
          />
          <span>{text.length}/120</span>
        </label>
      )}
      <div className="gartic-submit-row">
        {you.submitted ? (
          <p className="gartic-ready" role="status">
            <CheckCheck size={20} /> Отправлено. Следующий шаг начнётся, когда все будут готовы.
          </p>
        ) : (
          <>
            <span className="gartic-small">
              После отправки изменить {drawing ? 'рисунок' : 'фразу'} нельзя.
            </span>
            <button
              type="submit"
              className="button primary"
              disabled={!connected || pending || !you.canSubmit || (!drawing && !text.trim())}
            >
              <Check size={18} /> {pending ? 'Отправляем…' : drawing ? 'Рисунок готов' : 'Отправить фразу'}
            </button>
          </>
        )}
      </div>
      {error && (
        <p className="gartic-error" role="alert">
          {error}
        </p>
      )}
      {you.previous && (
        <div className="gartic-assignment-author">
          <GamePerson
            meeting={meeting}
            memberId={you.previous.authorId}
            fallbackName={you.previous.authorName}
            label="Предыдущий шаг"
          />
        </div>
      )}
    </form>
  );
}

function playerStatus(player: Table['players'][number], table: Table) {
  if (player.away) return 'Нет связи';
  if (!player.active) return 'Зритель';
  if (player.memberId === table.drawerId)
    return table.phase === 'choosing'
      ? 'Выбирает слово'
      : table.phase === 'round-reveal'
        ? 'Рисовал'
        : 'Рисует';
  if (table.mode === 'telephone')
    return player.submitted ? 'Готово' : table.phase === 'drawing' ? 'Рисует' : 'Думает';
  return player.guessed
    ? 'Угадал'
    : table.phase === 'choosing'
      ? 'Ждёт слово'
      : table.phase === 'round-reveal'
        ? 'Ждёт следующий ход'
        : 'Угадывает';
}

function Scoreboard({ table, meeting }: { table: Table; meeting: Meeting }) {
  const phone = table.mode === 'telephone';
  const players = !phone ? [...table.players].sort((a, b) => b.score - a.score) : table.players;
  const active = players.filter((player) => player.active);
  const ready = active.filter((player) => player.submitted).length;
  return (
    <div className="gartic-scores">
      <h3>{phone ? `Готово ${ready} из ${active.length}` : 'Игроки'}</h3>
      {phone && (
        <progress
          className="gartic-player-completion"
          aria-label="Готовность игроков"
          value={ready}
          max={Math.max(1, active.length)}
        />
      )}
      <ol aria-label={phone ? 'Прогресс игроков' : 'Счёт игроков'}>
        {players.map((player) => (
          <li
            key={player.memberId}
            data-away={player.away || !player.active || undefined}
            data-current={player.memberId === table.drawerId || undefined}
          >
            <GamePerson
              meeting={meeting}
              memberId={player.memberId}
              fallbackName={player.name}
              label={playerStatus(player, table)}
            />
            {phone ? (
              <span className="gartic-player-progress" aria-hidden="true">
                {player.submitted ? <Check size={18} /> : <span className="gartic-waiting-dot" />}
              </span>
            ) : (
              <strong className="gartic-score" aria-label={`${player.score} очков`}>
                {player.score}
                {player.guessed && <Check size={14} />}
              </strong>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
