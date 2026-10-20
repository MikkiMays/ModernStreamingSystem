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
import { useTranslation } from 'react-i18next';
import type { Translate } from '../i18n';
import type { Meeting } from '../core/meeting';
import type { GarticTable as Table } from '../api/types';
import { GamePeople, GamePerson } from './GamePeople';
import { GameTurn } from './GamePresentation';
import { useGarticSounds } from './useGameSounds';
import { AlbumReveal, ClassicResults } from './GarticResults';
import { allowed } from '../core/permissions';
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
  const host = allowed(snapshot, meeting.admission.participantId, 'gartic.manage');
  return <GarticGame key={table.gameId} meeting={meeting} table={table} host={host} />;
}

function GarticGame({ meeting, table, host }: { meeting: Meeting; table: Table; host: boolean }) {
  const { t } = useTranslation();
  const connection = useStore(meeting.control.state);
  const connected = connection === 'connected';
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const pendingAction = useRef(false);
  const phone = table.mode === 'telephone';
  const lobby = table.phase === 'lobby';
  const ended = table.phase === 'finished' || table.phase === 'reveal';
  const players = table.players.filter((player) => player.active && !player.away);
  const minimum = phone ? 3 : 2;
  const phaseKey = `${table.gameId}:${table.turnToken}`;
  useGarticSounds(meeting, table, !!table.you?.playing);
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
    ? t(($) => $.gartic.phase.lobby)
    : table.phase === 'choosing'
      ? table.you?.choices.length
        ? t(($) => $.gartic.phase.choose)
        : t(($) => $.gartic.phase.artistChoosing)
      : table.phase === 'round-reveal'
        ? t(($) => $.gartic.phase.roundReveal)
        : table.phase === 'finished'
          ? t(($) => $.gartic.phase.finished)
          : table.phase === 'reveal'
            ? t(($) => $.gartic.phase.reveal)
            : table.you?.submitted
              ? t(($) => $.gartic.phase.submitted)
              : table.phase === 'prompt'
                ? table.you?.playing
                  ? t(($) => $.gartic.phase.prompt)
                  : t(($) => $.gartic.phase.promptOthers)
                : table.phase === 'describing'
                  ? table.you?.playing
                    ? t(($) => $.gartic.phase.describe)
                    : t(($) => $.gartic.phase.describeOthers)
                  : table.you?.canDraw
                    ? t(($) => $.gartic.phase.draw)
                    : phone
                      ? t(($) => $.gartic.phase.drawPhrases)
                      : t(($) => $.gartic.phase.guess);

  return (
    <section className="gartic" aria-label="Gartic" data-phase={table.phase}>
      <header className="gartic-header">
        <div className="gartic-heading">
          <Palette size={23} />
          <div>
            <h2>Gartic</h2>
            <span>{phone ? t(($) => $.gartic.modes.telephone) : t(($) => $.gartic.modes.classic)}</span>
          </div>
        </div>
        {!lobby && !(phone && ended) && (
          <span className="gartic-round">
            {phone
              ? t(($) => $.gartic.step, {
                  step: Math.min(table.step + 1, table.totalSteps),
                  total: table.totalSteps,
                })
              : t(($) => $.gartic.round, { round: table.round, rounds: table.rounds })}
          </span>
        )}
        <div className="gartic-header-actions">
          <details className="gartic-rules">
            <summary>
              <BookOpen size={16} /> {t(($) => $.gartic.rules.title)}
            </summary>
            <div>
              {phone ? (
                <p>{t(($) => $.gartic.rules.telephone)}</p>
              ) : (
                <p>{t(($) => $.gartic.rules.classic)}</p>
              )}
              <p>{t(($) => $.gartic.rules.voice)}</p>
            </div>
          </details>
          {host && (
            <IconButton
              label={t(($) => $.gartic.close)}
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
          {t(($) => $.gartic.reconnecting)}
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
                {t(($) => $.gartic.lobby.sketchDraw)}
                <br />
                {t(($) => $.gartic.lobby.sketchSurprise)}
              </span>
            </div>
            <h3>
              {phone
                ? t(($) => $.gartic.lobby.headline.telephone)
                : t(($) => $.gartic.lobby.headline.classic)}
            </h3>
            <p>{phone ? t(($) => $.gartic.lobby.intro.telephone) : t(($) => $.gartic.lobby.intro.classic)}</p>
          </div>
          <div className="gartic-lobby-options">
            <div className="gartic-mode-picker" aria-label={t(($) => $.gartic.lobby.modePicker)}>
              <button
                type="button"
                aria-pressed={!phone}
                disabled={!host || pending || !connected}
                onClick={() => void act('gartic.settings', undefined, { option: 'classic' })}
              >
                <Palette size={20} />
                <b>{t(($) => $.gartic.modes.classic)}</b>
                <span>{t(($) => $.gartic.lobby.modeHint.classic)}</span>
              </button>
              <button
                type="button"
                aria-pressed={phone}
                disabled={!host || pending || !connected}
                onClick={() => void act('gartic.settings', undefined, { option: 'telephone' })}
              >
                <BookOpen size={20} />
                <b>{t(($) => $.gartic.modes.telephone)}</b>
                <span>{t(($) => $.gartic.lobby.modeHint.telephone)}</span>
              </button>
            </div>
            {!phone && (
              <div className="gartic-settings">
                <label>
                  {t(($) => $.gartic.lobby.rounds)}
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
                  {t(($) => $.gartic.lobby.turnSeconds)}
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
                        {t(($) => $.gartic.lobby.seconds, { count: value })}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            {phone && <p className="gartic-small">{t(($) => $.gartic.lobby.telephoneTiming)}</p>}
            <div className="gartic-lobby-players">
              <Users size={17} />
              <b>{t(($) => $.gartic.lobby.players, { count: players.length })}</b>
              <span>
                {players.map((player) => player.name).join(', ') || t(($) => $.gartic.lobby.joinFirst)}
              </span>
            </div>
            <div className="gartic-actions">
              {!table.you ? (
                <button
                  type="button"
                  className="button primary"
                  disabled={pending || !connected}
                  onClick={() => void act('gartic.join')}
                >
                  <Users size={17} /> {t(($) => $.gartic.lobby.join)}
                </button>
              ) : (
                <span className="gartic-ready">
                  <Check size={17} /> {t(($) => $.gartic.lobby.inGame)}
                </span>
              )}
              {host && (
                <button
                  type="button"
                  className="button primary"
                  disabled={pending || !connected || players.length < minimum}
                  onClick={() => void act('gartic.start')}
                >
                  <Play size={17} /> {t(($) => $.gartic.lobby.start)}
                </button>
              )}
            </div>
            {players.length < minimum && (
              <p className="gartic-small">
                {t(($) => $.gartic.lobby.needMore, { count: minimum - players.length })}
              </p>
            )}
            {!host && <p className="gartic-small">{t(($) => $.gartic.lobby.hostStarts)}</p>}
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
          <aside
            className="gartic-sidebar"
            aria-label={phone ? t(($) => $.gartic.sidebar.telephone) : t(($) => $.gartic.sidebar.classic)}
          >
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
                <Eye size={16} /> {t(($) => $.gartic.footer.watching)}
              </span>
              <button
                type="button"
                className="button secondary"
                disabled={!connected || pending}
                onClick={() => void act('gartic.join')}
              >
                {t(($) => $.gartic.footer.playNext)}
              </button>
            </>
          )}
          {table.you && !table.you.playing && !lobby && !ended && (
            <span>
              <Check size={16} /> {t(($) => $.gartic.footer.joinedNext)}
            </span>
          )}
          {table.you && (
            <button
              type="button"
              className="text-button"
              disabled={!connected || pending}
              onClick={() => void act('gartic.leave')}
            >
              <LogOut size={15} />{' '}
              {lobby || ended ? t(($) => $.gartic.footer.leave) : t(($) => $.gartic.footer.spectate)}
            </button>
          )}
          {host && ended && (
            <button
              type="button"
              className="button primary"
              disabled={!connected || pending}
              onClick={() => void act('gartic.start')}
            >
              <Play size={16} /> {t(($) => $.gartic.footer.again)}
            </button>
          )}
          {!host && ended && <span>{t(($) => $.gartic.footer.hostStartsNext)}</span>}
        </div>
        <GamePeople meeting={meeting} game="gartic" />
      </footer>
    </section>
  );
}

function ClassicTask({ table, send, connected }: { table: Table; send: SendCommand; connected: boolean }) {
  const { t } = useTranslation();
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
        <span>
          {table.answer
            ? t(($) => $.gartic.word.was)
            : table.you?.canDraw
              ? t(($) => $.gartic.word.youDraw)
              : t(($) => $.gartic.word.guess)}
        </span>
        <strong>{table.answer ?? (table.you?.canDraw ? table.you.prompt : table.hint) ?? '…'}</strong>
        {table.you?.canDraw && <small>{t(($) => $.gartic.word.onlyYou)}</small>}
      </div>
      {choosing && choices.length > 0 ? (
        <div className="gartic-choose">
          <Pencil size={34} strokeWidth={1.5} />
          <h3>{t(($) => $.gartic.word.chooseTitle)}</h3>
          <p>{t(($) => $.gartic.word.chooseHint)}</p>
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
  const { t } = useTranslation();
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
      <h3>{t(($) => $.gartic.guesses.title)}</h3>
      <ol
        ref={log}
        role="log"
        aria-label={t(($) => $.gartic.guesses.log)}
        aria-live="polite"
        aria-relevant="additions"
      >
        {table.guesses.map((entry) => (
          <li key={entry.id} data-correct={entry.correct || undefined}>
            <b>{entry.name}</b>
            <span>
              {entry.correct ? (
                <>
                  <Check size={14} /> {t(($) => $.gartic.guesses.correct)}
                </>
              ) : (
                entry.text
              )}
            </span>
          </li>
        ))}
        {!table.guesses.length && (
          <li className="gartic-empty-guesses">
            {table.phase === 'drawing' ? t(($) => $.gartic.guesses.first) : t(($) => $.gartic.guesses.empty)}
          </li>
        )}
      </ol>
      {table.you?.canGuess ? (
        <form onSubmit={(event) => void submit(event)}>
          <input
            aria-label={t(($) => $.gartic.guesses.input)}
            placeholder={t(($) => $.gartic.guesses.placeholder)}
            value={guess}
            maxLength={80}
            autoComplete="off"
            disabled={!connected || pending}
            onChange={(event) => setGuess(event.target.value)}
          />
          <button
            type="submit"
            aria-label={t(($) => $.gartic.guesses.send)}
            disabled={!connected || pending || !guess.trim()}
          >
            <Send size={18} />
          </button>
        </form>
      ) : guessed ? (
        <p className="gartic-guessed">
          <CheckCheck size={18} /> {t(($) => $.gartic.guesses.youGuessed)}
        </p>
      ) : (
        <p className="gartic-small">
          {table.you?.canDraw ? t(($) => $.gartic.guesses.drawer) : t(($) => $.gartic.guesses.guessersOnly)}
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
  const { t } = useTranslation();
  const canvas = useRef<GarticCanvasHandle>(null);
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const you = table.you;
  if (!you?.playing)
    return (
      <div className="gartic-phone-wait">
        <Eye size={34} strokeWidth={1.3} />
        <h3>{t(($) => $.gartic.phone.secretTitle)}</h3>
        <p>{t(($) => $.gartic.phone.secretText)}</p>
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
          <h3>{t(($) => $.gartic.phone.promptTitle)}</h3>
          <p>{t(($) => $.gartic.phone.promptText)}</p>
        </div>
      ) : drawing ? (
        <div className="gartic-phone-prompt">
          <span>{t(($) => $.gartic.phone.drawPhrase)}</span>
          <blockquote>
            {you.prompt ?? you.previous?.text ?? t(($) => $.gartic.phone.previousSkipped)}
          </blockquote>
        </div>
      ) : you.previous?.kind === 'drawing' ? (
        <GarticPicture strokes={you.previous.strokes} label={t(($) => $.gartic.phone.describeDrawing)} />
      ) : (
        <div className="gartic-phone-wait">
          <Pencil size={28} />
          <p>{t(($) => $.gartic.phone.missingDrawing)}</p>
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
          {table.phase === 'prompt'
            ? t(($) => $.gartic.phone.yourPhrase)
            : t(($) => $.gartic.phone.whatDrawn)}
          <textarea
            value={text}
            maxLength={120}
            rows={3}
            placeholder={
              table.phase === 'prompt'
                ? t(($) => $.gartic.phone.promptPlaceholder)
                : t(($) => $.gartic.phone.describePlaceholder)
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
            <CheckCheck size={20} /> {t(($) => $.gartic.phone.sent)}
          </p>
        ) : (
          <>
            <span className="gartic-small">
              {drawing ? t(($) => $.gartic.phone.finalDrawing) : t(($) => $.gartic.phone.finalPhrase)}
            </span>
            <button
              type="submit"
              className="button primary"
              disabled={!connected || pending || !you.canSubmit || (!drawing && !text.trim())}
            >
              <Check size={18} />{' '}
              {pending
                ? t(($) => $.gartic.phone.sending)
                : drawing
                  ? t(($) => $.gartic.phone.drawingReady)
                  : t(($) => $.gartic.phone.sendPhrase)}
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
            label={t(($) => $.gartic.phone.previousStep)}
          />
        </div>
      )}
    </form>
  );
}

function playerStatus(t: Translate, player: Table['players'][number], table: Table) {
  if (player.away) return t(($) => $.gartic.status.away);
  if (!player.active) return t(($) => $.gartic.status.spectator);
  if (player.memberId === table.drawerId)
    return table.phase === 'choosing'
      ? t(($) => $.gartic.status.choosing)
      : table.phase === 'round-reveal'
        ? t(($) => $.gartic.status.drew)
        : t(($) => $.gartic.status.drawing);
  if (table.mode === 'telephone')
    return player.submitted
      ? t(($) => $.gartic.status.ready)
      : table.phase === 'drawing'
        ? t(($) => $.gartic.status.drawing)
        : t(($) => $.gartic.status.thinking);
  return player.guessed
    ? t(($) => $.gartic.status.guessed)
    : table.phase === 'choosing'
      ? t(($) => $.gartic.status.waitingWord)
      : table.phase === 'round-reveal'
        ? t(($) => $.gartic.status.waitingTurn)
        : t(($) => $.gartic.status.guessing);
}

function Scoreboard({ table, meeting }: { table: Table; meeting: Meeting }) {
  const { t } = useTranslation();
  const phone = table.mode === 'telephone';
  const players = !phone ? [...table.players].sort((a, b) => b.score - a.score) : table.players;
  const active = players.filter((player) => player.active);
  const ready = active.filter((player) => player.submitted).length;
  return (
    <div className="gartic-scores">
      <h3>
        {phone
          ? t(($) => $.gartic.scores.ready, { ready, total: active.length })
          : t(($) => $.gartic.scores.players)}
      </h3>
      {phone && (
        <progress
          className="gartic-player-completion"
          aria-label={t(($) => $.gartic.scores.completion)}
          value={ready}
          max={Math.max(1, active.length)}
        />
      )}
      <ol aria-label={phone ? t(($) => $.gartic.scores.progress) : t(($) => $.gartic.scores.list)}>
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
              label={playerStatus(t, player, table)}
              game="gartic"
            />
            {phone ? (
              <span className="gartic-player-progress" aria-hidden="true">
                {player.submitted ? <Check size={18} /> : <span className="gartic-waiting-dot" />}
              </span>
            ) : (
              <strong
                className="gartic-score"
                aria-label={t(($) => $.gartic.points, { count: player.score })}
              >
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
