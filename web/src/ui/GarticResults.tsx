import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, ChevronDown, Pencil, RotateCcw, Trophy } from 'lucide-react';
import type { GarticTable as Table } from '../api/types';
import type { Meeting } from '../core/meeting';
import { GamePerson } from './GamePeople';
import { GarticPicture } from './GarticCanvas';
import { Avatar, useStore } from './primitives';

type Player = Table['players'][number];

function rankedPlayers(players: Player[]) {
  const sorted = [...players].sort((a, b) => b.score - a.score);
  return sorted.map((player) => ({
    player,
    // Competition ranking: equal scores share their place, e.g. 1, 1, 3.
    rank: sorted.findIndex((entry) => entry.score === player.score) + 1,
  }));
}

const number = (value: number) => value.toLocaleString('ru-RU');

function ResultRow({
  meeting,
  player,
  rank,
  topScore,
}: {
  meeting: Meeting;
  player: Player;
  rank: number;
  topScore: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const share = topScore > 0 ? Math.round((player.score / topScore) * 100) : 0;
  const you = player.memberId === meeting.admission.participantId;
  return (
    <li className="gartic-result-row" data-self={you || undefined}>
      <div className="gartic-result-line">
        <span className="gartic-rank" aria-label={`Место ${rank}`}>
          {rank}
        </span>
        <GamePerson
          meeting={meeting}
          memberId={player.memberId}
          fallbackName={player.name}
          interactive={false}
          label={you ? 'Это вы' : player.away ? 'Не в сети' : undefined}
        />
        <strong className="gartic-result-score" aria-label={`${player.score} очков`}>
          {number(player.score)}
          <small>очков</small>
        </strong>
        <button
          type="button"
          className="gartic-result-toggle"
          aria-label={`Подробности: ${player.name}`}
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => setExpanded(!expanded)}
        >
          <ChevronDown size={18} />
        </button>
      </div>
      <div id={detailsId} className="gartic-result-detail" hidden={!expanded}>
        <dl>
          <div>
            <dt>До первого места</dt>
            <dd>{number(Math.max(0, topScore - player.score))} очков</dd>
          </div>
          <div>
            <dt>От результата лидера</dt>
            <dd>{share}%</dd>
          </div>
        </dl>
        <div className="gartic-score-track" aria-hidden="true">
          <span style={{ '--score-share': `${share}%` } as CSSProperties} />
        </div>
        {topScore === 0 && <p>В этой партии пока никто не набрал очков.</p>}
      </div>
    </li>
  );
}

export function ClassicResults({ table, meeting }: { table: Table; meeting: Meeting }) {
  const snapshot = useStore(meeting.snapshot);
  const ranked = rankedPlayers(table.players);
  const topScore = ranked[0]?.player.score ?? 0;
  const leaders = ranked.filter(({ player }) => player.score === topScore);
  const podium = ranked.filter(({ player }) => player.score > 0).slice(0, 3);
  const tied = topScore > 0 && leaders.length > 1;
  const total = table.players.reduce((sum, player) => sum + player.score, 0);
  return (
    <section className="gartic-finish" aria-label="Результаты игры">
      <header className="gartic-finish-heading">
        <span className="gartic-finish-emblem" aria-hidden="true">
          <Trophy size={28} strokeWidth={1.6} />
        </span>
        <div>
          <h3>
            {topScore === 0
              ? 'В этот раз без очков'
              : tied
                ? 'Ничья на первом месте'
                : `Победа: ${leaders[0]!.player.name}`}
          </h3>
          <p>
            {topScore === 0
              ? 'Главное — было что нарисовать. Попробуем ещё?'
              : tied
                ? `${leaders.map(({ player }) => player.name).join(', ')} — по ${number(topScore)} очков.`
                : 'Слова угаданы. Время посмотреть, кто отличился.'}
          </p>
        </div>
      </header>
      {podium.length > 0 && (
        <div className="gartic-podium" aria-label="Лучшие результаты" data-count={podium.length}>
          {podium.map(({ player, rank }) => (
            <div key={player.memberId} className="gartic-podium-place" data-first={rank === 1 || undefined}>
              <span className="gartic-podium-rank">
                {rank === 1 && <Trophy size={15} />}
                {rank} место
              </span>
              <Avatar
                name={player.name}
                src={snapshot.participants.find((person) => person.id === player.memberId)?.avatar}
              />
              <strong title={player.name}>{player.name}</strong>
              <span className="gartic-podium-score">
                {number(player.score)} <small>очков</small>
              </span>
            </div>
          ))}
        </div>
      )}
      <dl className="gartic-result-summary">
        <div>
          <dt>Игроков</dt>
          <dd>{table.players.length}</dd>
        </div>
        <div>
          <dt>Очков за игру</dt>
          <dd>{number(total)}</dd>
        </div>
        <div>
          <dt>Круг</dt>
          <dd>
            {table.round} <span>из {table.rounds}</span>
          </dd>
        </div>
      </dl>
      <div className="gartic-ranking-heading">
        <h4>Итоговый счёт</h4>
        <span>Нажмите на стрелку, чтобы сравнить</span>
      </div>
      <ol className="gartic-ranking" aria-label="Итоговый счёт">
        {ranked.map(({ player, rank }) => (
          <ResultRow
            key={player.memberId}
            meeting={meeting}
            player={player}
            rank={rank}
            topScore={topScore}
          />
        ))}
      </ol>
      {ranked.length === 0 && <p className="gartic-small">Результатов участников пока нет.</p>}
      <details className="gartic-scoring-help">
        <summary>
          Как считаются очки
          <ChevronDown size={16} />
        </summary>
        <p>
          За верный ответ — от 250 до 500 очков: чем быстрее угадаете, тем больше получите. Художнику — 100
          очков за каждого угадавшего. Одинаковый счёт означает одинаковое место.
        </p>
      </details>
    </section>
  );
}

export function AlbumReveal({
  meeting,
  table,
  host,
  disabled,
  pending,
  onReveal,
}: {
  meeting: Meeting;
  table: Table;
  host: boolean;
  disabled: boolean;
  pending: boolean;
  onReveal: (albumIndex: number, entryIndex: number) => void;
}) {
  const albumIndex = table.albums.findIndex((item) => item.index === table.revealAlbum);
  const album = table.albums[albumIndex];
  const entry = table.revealed;
  const previousAlbum = table.albums[albumIndex - 1];
  const nextAlbum = table.albums[albumIndex + 1];
  const lastStep = !!album && table.revealEntry + 1 >= album.entries;
  const previousDisabled = disabled || !entry || !album || (table.revealEntry === 0 && !previousAlbum);
  const nextDisabled = disabled || !entry || !album || album.entries < 1;
  const previousButton = useRef<HTMLButtonElement>(null);
  const nextButton = useRef<HTMLButtonElement>(null);
  const totalEntries = table.albums.reduce((sum, item) => sum + item.entries, 0);

  // Only the current authorized page is rendered. No album contents or drawing log are retained.
  const change = (albumNumber: number, step: number) => {
    if (!host || disabled || (albumNumber === table.revealAlbum && step === table.revealEntry)) return;
    onReveal(albumNumber, step);
  };
  const previous = () => {
    if (previousDisabled) return;
    if (table.revealEntry > 0) change(table.revealAlbum, table.revealEntry - 1);
    else if (previousAlbum) change(previousAlbum.index, previousAlbum.entries - 1);
  };
  const next = () => {
    if (nextDisabled) return;
    if (!lastStep) change(table.revealAlbum, table.revealEntry + 1);
    else if (nextAlbum) change(nextAlbum.index, 0);
    else if (table.albums[0]) change(table.albums[0].index, 0);
  };
  const navigate = (event: KeyboardEvent<HTMLElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      if (event.key === 'ArrowLeft') previous();
      else next();
    }
  };
  useEffect(() => {
    if (!disabled && previousDisabled && document.activeElement === previousButton.current)
      nextButton.current?.focus({ preventScroll: true });
  }, [disabled, previousDisabled]);

  const nextLabel = !lastStep ? 'Следующий шаг' : nextAlbum ? 'Следующая история' : 'Смотреть сначала';
  return (
    <section className="gartic-reveal" aria-label="Истории игроков">
      <aside className="gartic-albums" aria-label="Альбомы игроков">
        <div className="gartic-albums-heading">
          <BookOpen size={21} />
          <h3>Наши истории</h3>
          <span>{table.albums.length}</span>
        </div>
        <p className="gartic-albums-intro">Посмотрим, куда завела фантазия.</p>
        <div className="gartic-album-list">
          {table.albums.map((item, index) => {
            const contents = (
              <>
                <span className="gartic-album-number">{index + 1}</span>
                <span className="gartic-album-copy">
                  <b>{item.ownerName}</b>
                  <small>Шагов: {item.entries}</small>
                </span>
                <ArrowRight size={16} />
              </>
            );
            return host ? (
              <button
                key={item.index}
                type="button"
                className="gartic-album-option"
                aria-current={item.index === table.revealAlbum ? 'true' : undefined}
                disabled={disabled || item.entries < 1}
                onClick={() => change(item.index, 0)}
              >
                {contents}
              </button>
            ) : (
              <div
                key={item.index}
                className="gartic-album-option"
                aria-current={item.index === table.revealAlbum ? 'true' : undefined}
              >
                {contents}
              </div>
            );
          })}
        </div>
        <dl className="gartic-album-summary">
          <div>
            <dt>Историй</dt>
            <dd>{table.albums.length}</dd>
          </div>
          <div>
            <dt>Всего шагов</dt>
            <dd>{totalEntries}</dd>
          </div>
        </dl>
        <p className="gartic-reveal-follow">
          {host ? 'Вы показываете истории всей комнате' : 'Ведущий листает истории для всех'}
        </p>
      </aside>
      <div className="gartic-album-page">
        <header className="gartic-story-heading">
          <div>
            <span>
              История {Math.max(0, albumIndex + 1)} из {table.albums.length}
            </span>
            <h3>{album ? `Начало: ${album.ownerName}` : 'Истории пока недоступны'}</h3>
          </div>
          {album && (
            <span className="gartic-story-position">
              {table.revealEntry + 1}
              <span> / {album.entries}</span>
            </span>
          )}
        </header>
        {album && (
          <ol className="gartic-story-steps" aria-label="Шаги истории">
            {Array.from({ length: album.entries }, (_, index) => (
              <li key={index}>
                {host ? (
                  <button
                    type="button"
                    aria-label={`Показать шаг ${index + 1}`}
                    aria-current={index === table.revealEntry ? 'step' : undefined}
                    disabled={disabled || !entry}
                    onClick={() => change(album.index, index)}
                  >
                    {index + 1}
                  </button>
                ) : (
                  <span
                    aria-label={`Шаг ${index + 1}`}
                    aria-current={index === table.revealEntry ? 'step' : undefined}
                  >
                    {index + 1}
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}
        <div className="gartic-reveal-stage" aria-busy={pending || undefined}>
          {entry && album && (
            <div className="gartic-reveal-author">
              <GamePerson
                meeting={meeting}
                memberId={entry.authorId}
                fallbackName={entry.authorName}
                label={`${entry.kind === 'drawing' ? 'Рисунок' : 'Фраза'}, шаг ${entry.step + 1}`}
              />
              <span className="gartic-entry-kind">
                {entry.kind === 'drawing' ? <Pencil size={16} /> : <BookOpen size={16} />}
                {entry.skipped ? 'Пропущено' : entry.kind === 'drawing' ? 'Рисунок' : 'Фраза'}
              </span>
            </div>
          )}
          <div className="gartic-reveal-entry" key={`${table.revealAlbum}:${table.revealEntry}`}>
            {!entry || !album ? (
              <div className="gartic-reveal-placeholder">
                <BookOpen size={32} />
                <p>Истории пока недоступны</p>
                <span>Ждём обновления игры.</span>
              </div>
            ) : entry.skipped ? (
              <div className="gartic-reveal-placeholder">
                <Pencil size={32} />
                <p>Этот шаг пропущен</p>
                <span>Иногда фантазии нужно чуть больше времени.</span>
              </div>
            ) : entry.kind === 'drawing' ? (
              <GarticPicture strokes={entry.strokes} label={`Рисунок: ${entry.authorName}`} />
            ) : (
              <blockquote>
                <span className="gartic-quote-mark" aria-hidden="true">
                  “
                </span>
                {entry.text || 'Без описания'}
              </blockquote>
            )}
          </div>
        </div>
        <p className="gartic-sr-only" role="status" aria-live="polite" aria-atomic="true">
          {album && entry
            ? `История: ${album.ownerName}. Шаг ${table.revealEntry + 1} из ${album.entries}. ${entry.skipped ? 'Шаг пропущен.' : entry.kind === 'drawing' ? 'Рисунок.' : 'Фраза.'} Автор: ${entry.authorName}.`
            : 'Истории пока недоступны'}
        </p>

        {host && (
          <nav className="gartic-reveal-navigation" aria-label="Листать историю" onKeyDown={navigate}>
            <button
              ref={previousButton}
              type="button"
              className="button secondary"
              aria-label="Предыдущий шаг"
              disabled={previousDisabled}
              onClick={previous}
            >
              <ArrowLeft size={18} />
              <span>Назад</span>
            </button>
            <button
              ref={nextButton}
              type="button"
              className="button primary"
              disabled={nextDisabled}
              onClick={next}
            >
              <span>{nextLabel}</span>
              {lastStep && !nextAlbum ? <RotateCcw size={18} /> : <ArrowRight size={18} />}
            </button>
          </nav>
        )}
      </div>
    </section>
  );
}
