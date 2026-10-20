import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { AudioLines, Pause, Play, Repeat2, Shuffle, SkipForward, Volume2, VolumeX } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { coverUrl, musicSourceName, type MusicState } from '../core/services';
import { Badge, IconButton, Slider } from './kit';
import { MusicCover } from './MusicCover';
import { afterSkip, formatDuration, playbackPosition } from './music-playback';

/**
 * «Сейчас играет» (T18): обложка, название, источник, игла, пульт и громкость у себя — одной
 * карточкой. Под обложкой — её же размытый свет: единственное украшение панели, и оно про трек, а
 * не про оформление. Светит только под картинкой, не под текстом, — контраст букв от обложки не
 * зависит. Нет обложки — нет и света.
 */
export function MusicPlayer({
  state,
  canUse,
  volume,
  onVolume,
  onCommand,
  onSeek,
}: {
  state: MusicState;
  canUse: boolean;
  volume: number;
  onVolume: (value: number) => void;
  onCommand: (
    action: 'play' | 'pause' | 'skip' | 'shuffle' | 'repeat',
    extra?: { enabled?: boolean },
    patch?: Partial<MusicState>,
  ) => void;
  onSeek: (position: number) => void;
}) {
  const { t } = useTranslation();
  const current = state.queue[0];
  const playing = !!current && state.status === 'playing' && !state.paused;
  const [dragging, setDragging] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now);
  // Опрос отдаёт новый объект каждые две секунды, даже когда ничего не сдвинулось. Привязка
  // к самой позиции, а не к тождеству объекта, не даёт отсчёту начинаться заново — и делает
  // эту переустановку безвредной, когда React рисует дважды.
  const anchor = useRef({ position: state.position, trackId: current?.id, at: Date.now() });
  if (anchor.current.position !== state.position || anchor.current.trackId !== current?.id)
    anchor.current = { position: state.position, trackId: current?.id, at: Date.now() };
  useEffect(() => {
    setNow(Date.now());
    if (!playing) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [playing, current?.id]);
  const position = playbackPosition(anchor.current, now, playing, current?.duration ?? state.position);
  const commit = (value: number) => {
    setDragging(null);
    onSeek(value);
  };
  const status =
    state.status === 'connecting'
      ? t(($) => $.music.player.status.connecting)
      : !current
        ? t(($) => $.music.player.status.empty)
        : state.paused
          ? t(($) => $.music.player.status.paused)
          : t(($) => $.music.player.status.playing);
  const percent = Math.round(volume * 100);
  const backdrop = current?.cover
    ? ({ '--music-cover': `url("${coverUrl(current.cover)}")` } as CSSProperties)
    : undefined;
  return (
    <section
      className="music-now"
      aria-label={t(($) => $.music.player.label)}
      data-playing={playing || undefined}
      data-backdrop={backdrop ? 'true' : undefined}
      style={backdrop}
    >
      <div className="music-now__head">
        <span className="music-now__art">
          <MusicCover track={current} size="lg" />
        </span>
        <div className="music-now__meta">
          <span className="music-now__state">
            <span className="music-now__status">
              {playing && <AudioLines size={14} aria-hidden="true" />}
              {status}
            </span>
            {current && <Badge>{musicSourceName(t, current.source)}</Badge>}
          </span>
          <strong className="music-now__title">
            {current?.title ?? t(($) => $.music.player.firstTrack)}
          </strong>
          <span className="music-now__artist">
            {current
              ? current.artist || t(($) => $.music.player.addedBy, { name: current.addedBy })
              : t(($) => $.music.player.emptyHint)}
          </span>
        </div>
      </div>
      {current && (
        <div className="music-now__progress">
          <Slider
            min={0}
            max={Math.max(1, current.duration)}
            step={1}
            disabled={!canUse}
            label={t(($) => $.music.player.position)}
            value={dragging ?? position}
            onChange={(e) => setDragging(Number(e.target.value))}
            onPointerUp={(e) => commit(Number(e.currentTarget.value))}
            onKeyUp={(e) => {
              if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key))
                commit(Number(e.currentTarget.value));
            }}
          />
          <div className="music-now__times">
            <span>{formatDuration(dragging ?? position)}</span>
            <span>{formatDuration(current.duration)}</span>
          </div>
        </div>
      )}
      <div className="music-now__controls">
        <IconButton
          label={t(($) => $.music.player.shuffle)}
          className="music-now__toggle"
          disabled={!canUse || state.queue.length < 3}
          onClick={() => onCommand('shuffle')}
        >
          <Shuffle size={18} />
        </IconButton>
        <IconButton
          label={state.paused ? t(($) => $.music.player.resume) : t(($) => $.music.player.pause)}
          size="lg"
          className="music-now__play"
          disabled={!canUse || !current}
          onClick={() =>
            onCommand(state.paused ? 'play' : 'pause', undefined, {
              paused: !state.paused,
              status: state.paused ? 'playing' : 'paused',
            })
          }
        >
          {state.paused || !current ? <Play size={22} /> : <Pause size={22} />}
        </IconButton>
        <IconButton
          label={t(($) => $.music.player.next)}
          className="music-now__toggle"
          disabled={!canUse || !current}
          onClick={() => onCommand('skip', undefined, afterSkip(state))}
        >
          <SkipForward size={20} />
        </IconButton>
        <IconButton
          label={t(($) => $.music.player.repeat)}
          className="music-now__toggle"
          aria-pressed={state.repeat}
          data-on={state.repeat || undefined}
          disabled={!canUse}
          onClick={() => onCommand('repeat', { enabled: !state.repeat }, { repeat: !state.repeat })}
        >
          <Repeat2 size={18} />
        </IconButton>
      </div>
      {state.participantId && (
        <div className="music-now__volume">
          {percent === 0 ? (
            <VolumeX size={16} aria-hidden="true" />
          ) : (
            <Volume2 size={16} aria-hidden="true" />
          )}
          {/*
            Музыке усиление не положено. Тихий собеседник — это случайность его микрофона, и
            её честно исправлять усилением; трек же приходит сведённым и на своём уровне, и
            всё сверх 100 % — это не «громче», а клиппинг. Потолок в 200 % остаётся у людей.
          */}
          <Slider
            min={0}
            max={100}
            step={1}
            value={percent}
            label={t(($) => $.music.player.volume)}
            onChange={(e) => onVolume(Number(e.target.value) / 100)}
          />
          <output className="music-now__percent" aria-hidden="true">
            {percent}%
          </output>
        </div>
      )}
    </section>
  );
}
