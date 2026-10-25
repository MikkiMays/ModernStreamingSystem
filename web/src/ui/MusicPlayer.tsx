import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Pause, Play, Repeat2, Shuffle, SkipBack, SkipForward, Volume2, VolumeX } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { coverUrl, musicSourceName, type MusicState } from '../core/services';
import type { Translate } from '../i18n';
import { paint } from './brands';
import { IconButton, Slider } from './kit';
import { MusicCover } from './MusicCover';
import { afterPrevious, afterSkip, formatDuration, playbackPosition } from './music-playback';
import { sourceBrand } from './music-platforms';

export type PlayerAction = 'play' | 'pause' | 'skip' | 'previous' | 'shuffle' | 'repeat';

/** Что сейчас со звуком — словами. «Играет» — только когда звук и правда идёт. */
export function playerStatus(t: Translate, state: MusicState): string {
  const current = state.queue[0];
  // Голодающий источник и переподключение издателя (R09/R04) на слух — тишина, и подпись обязана это
  // говорить, а не «Играет».
  if (state.status === 'connecting') return t(($) => $.music.player.status.connecting);
  if (state.status === 'reconnecting') return t(($) => $.music.player.status.reconnecting);
  if (!current) return t(($) => $.music.player.status.empty);
  if (state.paused) return t(($) => $.music.player.status.paused);
  if (state.status === 'starved') return t(($) => $.music.player.status.starved);
  return t(($) => $.music.player.status.playing);
}

/** Звук идёт прямо сейчас: есть трек, служба играет и не на паузе. */
export function soundsNow(state: MusicState): boolean {
  return !!state.queue[0] && state.status === 'playing' && !state.paused;
}

/**
 * Игла трека с ходом времени между опросами: опрос отдаёт позицию раз в две секунды, а игла идёт
 * плавно. `behind` — на сколько мы слышим музыку позже издателя (`MediaSession.musicPlayoutMs`): игла
 * совпадает со звуком, а не с тем, что издатель уже отправил.
 */
export function usePlayback(state: MusicState, behind?: () => number) {
  const current = state.queue[0];
  const playing = soundsNow(state);
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
  return playbackPosition(
    anchor.current,
    now,
    playing,
    current?.duration ?? state.position,
    playing ? (behind?.() ?? 0) : 0,
  );
}

/**
 * «Сейчас играет» (R44, по r103-32): «Сейчас играет · площадка», обложка, название, исполнитель и
 * состояние звука; игла с временем по краям; shuffle · ⏮ · ⏯ · ⏭ · repeat; громкость у себя. Цвет —
 * площадки, откуда трек (`brands.ts`, R33): полоса иглы, круг ⏯ и эквалайзер — красный YouTube,
 * жёлтый Яндекс, зелёный своих файлов; кнопки приложения остаются цветом Cord.
 *
 * ⏮ — как у любого плеера: дольше трёх секунд трека — с начала, иначе предыдущий трек (служба помнит
 * сыгранные, `previous`). Перетаскивание иглы не шлёт `seek`, пока её не отпустили.
 */
export function MusicPlayer({
  state,
  canUse,
  volume,
  onVolume,
  onCommand,
  onSeek,
  behind,
}: {
  state: MusicState;
  canUse: boolean;
  volume: number;
  onVolume: (value: number) => void;
  onCommand: (action: PlayerAction, extra?: { enabled?: boolean }, patch?: Partial<MusicState>) => void;
  onSeek: (position: number) => void;
  /** На сколько миллисекунд мы слышим музыку позже издателя. */
  behind?: () => number;
}) {
  const { t } = useTranslation();
  const current = state.queue[0];
  const playing = soundsNow(state);
  const [dragging, setDragging] = useState<number | null>(null);
  const position = usePlayback(state, behind);
  const commit = (value: number) => {
    setDragging(null);
    onSeek(value);
  };
  const percent = Math.round(volume * 100);
  const backdrop = current?.cover ? { '--music-cover': `url("${coverUrl(current.cover)}")` } : {};
  const style = { ...paint(sourceBrand(current?.source ?? 'upload')), ...backdrop } as CSSProperties;
  return (
    <section
      className="music-now"
      aria-label={t(($) => $.music.player.label)}
      data-playing={playing || undefined}
      data-backdrop={current?.cover ? 'true' : undefined}
      style={style}
    >
      <h4 className="music-now__label">
        {t(($) => $.music.player.label)}
        {current && <span className="music-now__source">{musicSourceName(t, current.source)}</span>}
      </h4>
      <div className="music-now__head">
        <span className="music-now__art">
          <MusicCover track={current} size="lg" />
        </span>
        <div className="music-now__meta">
          <strong className="music-now__title">
            {current?.title ?? t(($) => $.music.player.firstTrack)}
          </strong>
          <span className="music-now__artist">
            {current
              ? current.artist || t(($) => $.music.player.addedBy, { name: current.addedBy })
              : t(($) => $.music.player.emptyHint)}
          </span>
          {current && (
            <span className="music-now__status" data-sounding={playing || undefined}>
              {playing && <Equalizer />}
              {playerStatus(t, state)}
            </span>
          )}
        </div>
      </div>
      {current && (
        <div className="music-now__progress">
          <span className="music-now__time">{formatDuration(dragging ?? position)}</span>
          <Slider
            min={0}
            max={Math.max(1, current.duration)}
            step={1}
            disabled={!canUse}
            label={t(($) => $.music.player.position)}
            value={dragging ?? position}
            onChange={(e) => setDragging(Number(e.target.value))}
            onValueCommitted={commit}
          />
          <span className="music-now__time">{formatDuration(current.duration)}</span>
        </div>
      )}
      <div className="music-now__controls">
        <IconButton
          label={t(($) => $.music.player.shuffle)}
          className="music-now__toggle"
          disabled={!canUse || state.queue.length < 3}
          onClick={() => onCommand('shuffle')}
        >
          <Shuffle size={20} />
        </IconButton>
        <IconButton
          label={t(($) => $.music.player.previous)}
          className="music-now__step"
          disabled={!canUse || !current}
          onClick={() => onCommand('previous', undefined, afterPrevious(position))}
        >
          <SkipBack size={20} />
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
          {state.paused || !current ? <Play size={24} /> : <Pause size={24} />}
        </IconButton>
        <IconButton
          label={t(($) => $.music.player.next)}
          className="music-now__step"
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
          <Repeat2 size={20} />
        </IconButton>
      </div>
      {state.participantId && (
        <div className="music-now__volume" title={t(($) => $.music.player.volume)}>
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

/** Три полоски цвета площадки: единственное, что движется само, — потому что это звук. */
export function Equalizer() {
  return (
    <span className="music-eq" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}
