import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, ChevronDown, Pencil, RotateCcw, Trophy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { locale, type Translate } from '../i18n';
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

const number = (t: Translate, value: number) => value.toLocaleString(locale(t));

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
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const share = topScore > 0 ? Math.round((player.score / topScore) * 100) : 0;
  const you = player.memberId === meeting.admission.participantId;
  return (
    <li className="gartic-result-row" data-self={you || undefined}>
      <div className="gartic-result-line">
        <span className="gartic-rank" aria-label={t(($) => $.gartic.results.rank, { rank })}>
          {rank}
        </span>
        <GamePerson
          meeting={meeting}
          memberId={player.memberId}
          fallbackName={player.name}
          interactive={false}
          label={
            you
              ? t(($) => $.gartic.results.you)
              : player.away
                ? t(($) => $.gartic.results.offline)
                : undefined
          }
        />
        <strong
          className="gartic-result-score"
          aria-label={t(($) => $.gartic.points, { count: player.score })}
        >
          {number(t, player.score)}
          <small>{t(($) => $.gartic.results.pointsWord, { count: player.score })}</small>
        </strong>
        <button
          type="button"
          className="gartic-result-toggle"
          aria-label={t(($) => $.gartic.results.details, { name: player.name })}
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
            <dt>{t(($) => $.gartic.results.toFirst)}</dt>
            <dd>
              {t(($) => $.gartic.results.pointsValue, {
                count: Math.max(0, topScore - player.score),
                points: number(t, Math.max(0, topScore - player.score)),
              })}
            </dd>
          </div>
          <div>
            <dt>{t(($) => $.gartic.results.fromLeader)}</dt>
            <dd>{share}%</dd>
          </div>
        </dl>
        <div className="gartic-score-track" aria-hidden="true">
          <span style={{ '--score-share': `${share}%` } as CSSProperties} />
        </div>
        {topScore === 0 && <p>{t(($) => $.gartic.results.nobodyScored)}</p>}
      </div>
    </li>
  );
}

export function ClassicResults({ table, meeting }: { table: Table; meeting: Meeting }) {
  const { t } = useTranslation();
  const snapshot = useStore(meeting.snapshot);
  const ranked = rankedPlayers(table.players);
  const topScore = ranked[0]?.player.score ?? 0;
  const leaders = ranked.filter(({ player }) => player.score === topScore);
  const podium = ranked.filter(({ player }) => player.score > 0).slice(0, 3);
  const tied = topScore > 0 && leaders.length > 1;
  const total = table.players.reduce((sum, player) => sum + player.score, 0);
  return (
    <section className="gartic-finish" aria-label={t(($) => $.gartic.results.section)}>
      <header className="gartic-finish-heading">
        <span className="gartic-finish-emblem" aria-hidden="true">
          <Trophy size={28} strokeWidth={1.6} />
        </span>
        <div>
          <h3>
            {topScore === 0
              ? t(($) => $.gartic.results.noPoints)
              : tied
                ? t(($) => $.gartic.results.tie)
                : t(($) => $.gartic.results.winner, { name: leaders[0]!.player.name })}
          </h3>
          <p>
            {topScore === 0
              ? t(($) => $.gartic.results.noPointsText)
              : tied
                ? t(($) => $.gartic.results.tieText, {
                    names: leaders.map(({ player }) => player.name).join(', '),
                    count: topScore,
                    points: number(t, topScore),
                  })
                : t(($) => $.gartic.results.winnerText)}
          </p>
        </div>
      </header>
      {podium.length > 0 && (
        <div
          className="gartic-podium"
          aria-label={t(($) => $.gartic.results.podium)}
          data-count={podium.length}
        >
          {podium.map(({ player, rank }) => (
            <div key={player.memberId} className="gartic-podium-place" data-first={rank === 1 || undefined}>
              <span className="gartic-podium-rank">
                {rank === 1 && <Trophy size={15} />}
                {t(($) => $.gartic.results.place, { rank })}
              </span>
              <Avatar
                name={player.name}
                src={snapshot.participants.find((person) => person.id === player.memberId)?.avatar}
              />
              <strong title={player.name}>{player.name}</strong>
              <span className="gartic-podium-score">
                {number(t, player.score)}{' '}
                <small>{t(($) => $.gartic.results.pointsWord, { count: player.score })}</small>
              </span>
            </div>
          ))}
        </div>
      )}
      <dl className="gartic-result-summary">
        <div>
          <dt>{t(($) => $.gartic.results.players)}</dt>
          <dd>{table.players.length}</dd>
        </div>
        <div>
          <dt>{t(($) => $.gartic.results.total)}</dt>
          <dd>{number(t, total)}</dd>
        </div>
        <div>
          <dt>{t(($) => $.gartic.results.round)}</dt>
          <dd>
            {table.round} <span>{t(($) => $.gartic.results.ofRounds, { rounds: table.rounds })}</span>
          </dd>
        </div>
      </dl>
      <div className="gartic-ranking-heading">
        <h4>{t(($) => $.gartic.results.ranking)}</h4>
        <span>{t(($) => $.gartic.results.compareHint)}</span>
      </div>
      <ol className="gartic-ranking" aria-label={t(($) => $.gartic.results.ranking)}>
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
      {ranked.length === 0 && <p className="gartic-small">{t(($) => $.gartic.results.empty)}</p>}
      <details className="gartic-scoring-help">
        <summary>
          {t(($) => $.gartic.results.scoringTitle)}
          <ChevronDown size={16} />
        </summary>
        <p>{t(($) => $.gartic.results.scoringText)}</p>
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
  const { t } = useTranslation();
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

  const nextLabel = !lastStep
    ? t(($) => $.gartic.reveal.nextStep)
    : nextAlbum
      ? t(($) => $.gartic.reveal.nextStory)
      : t(($) => $.gartic.reveal.restart);
  const kind = (item: { kind: string }) => (item.kind === 'drawing' ? 'drawing' : 'text');
  return (
    <section className="gartic-reveal" aria-label={t(($) => $.gartic.reveal.section)}>
      <aside className="gartic-albums" aria-label={t(($) => $.gartic.reveal.albums)}>
        <div className="gartic-albums-heading">
          <BookOpen size={21} />
          <h3>{t(($) => $.gartic.reveal.title)}</h3>
          <span>{table.albums.length}</span>
        </div>
        <p className="gartic-albums-intro">{t(($) => $.gartic.reveal.intro)}</p>
        <div className="gartic-album-list">
          {table.albums.map((item, index) => {
            const contents = (
              <>
                <span className="gartic-album-number">{index + 1}</span>
                <span className="gartic-album-copy">
                  <b>{item.ownerName}</b>
                  <small>{t(($) => $.gartic.reveal.albumSteps, { count: item.entries })}</small>
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
            <dt>{t(($) => $.gartic.reveal.stories)}</dt>
            <dd>{table.albums.length}</dd>
          </div>
          <div>
            <dt>{t(($) => $.gartic.reveal.totalSteps)}</dt>
            <dd>{totalEntries}</dd>
          </div>
        </dl>
        <p className="gartic-reveal-follow">
          {host ? t(($) => $.gartic.reveal.hostShowing) : t(($) => $.gartic.reveal.hostFlipping)}
        </p>
      </aside>
      <div className="gartic-album-page">
        <header className="gartic-story-heading">
          <div>
            <span>
              {t(($) => $.gartic.reveal.storyOf, {
                index: Math.max(0, albumIndex + 1),
                total: table.albums.length,
              })}
            </span>
            <h3>
              {album
                ? t(($) => $.gartic.reveal.start, { name: album.ownerName })
                : t(($) => $.gartic.reveal.unavailable)}
            </h3>
          </div>
          {album && (
            <span className="gartic-story-position">
              {table.revealEntry + 1}
              <span> / {album.entries}</span>
            </span>
          )}
        </header>
        {album && (
          <ol className="gartic-story-steps" aria-label={t(($) => $.gartic.reveal.steps)}>
            {Array.from({ length: album.entries }, (_, index) => (
              <li key={index}>
                {host ? (
                  <button
                    type="button"
                    aria-label={t(($) => $.gartic.reveal.showStep, { step: index + 1 })}
                    aria-current={index === table.revealEntry ? 'step' : undefined}
                    disabled={disabled || !entry}
                    onClick={() => change(album.index, index)}
                  >
                    {index + 1}
                  </button>
                ) : (
                  <span
                    aria-label={t(($) => $.gartic.reveal.stepN, { step: index + 1 })}
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
                label={t(($) => $.gartic.reveal.author[kind(entry)], { step: entry.step + 1 })}
              />
              <span className="gartic-entry-kind">
                {entry.kind === 'drawing' ? <Pencil size={16} /> : <BookOpen size={16} />}
                {t(($) => $.gartic.reveal.kind[entry.skipped ? 'skipped' : kind(entry)])}
              </span>
            </div>
          )}
          <div className="gartic-reveal-entry" key={`${table.revealAlbum}:${table.revealEntry}`}>
            {!entry || !album ? (
              <div className="gartic-reveal-placeholder">
                <BookOpen size={32} />
                <p>{t(($) => $.gartic.reveal.unavailable)}</p>
                <span>{t(($) => $.gartic.reveal.waitUpdate)}</span>
              </div>
            ) : entry.skipped ? (
              <div className="gartic-reveal-placeholder">
                <Pencil size={32} />
                <p>{t(($) => $.gartic.reveal.skippedTitle)}</p>
                <span>{t(($) => $.gartic.reveal.skippedText)}</span>
              </div>
            ) : entry.kind === 'drawing' ? (
              <GarticPicture
                strokes={entry.strokes}
                label={t(($) => $.gartic.reveal.drawingBy, { name: entry.authorName })}
              />
            ) : (
              <blockquote>
                <span className="gartic-quote-mark" aria-hidden="true">
                  “
                </span>
                {entry.text || t(($) => $.gartic.reveal.noText)}
              </blockquote>
            )}
          </div>
        </div>
        <p className="gartic-sr-only" role="status" aria-live="polite" aria-atomic="true">
          {album && entry
            ? t(($) => $.gartic.reveal.announce, {
                owner: album.ownerName,
                step: table.revealEntry + 1,
                total: album.entries,
                kind: t(($) => $.gartic.reveal.announceKind[entry.skipped ? 'skipped' : kind(entry)]),
                author: entry.authorName,
              })
            : t(($) => $.gartic.reveal.unavailable)}
        </p>

        {host && (
          <nav
            className="gartic-reveal-navigation"
            aria-label={t(($) => $.gartic.reveal.navigation)}
            onKeyDown={navigate}
          >
            <button
              ref={previousButton}
              type="button"
              className="button secondary"
              aria-label={t(($) => $.gartic.reveal.previous)}
              disabled={previousDisabled}
              onClick={previous}
            >
              <ArrowLeft size={18} />
              <span>{t(($) => $.gartic.reveal.back)}</span>
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
