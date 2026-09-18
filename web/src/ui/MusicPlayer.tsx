import { useEffect, useRef, useState } from 'react';
import { Pause, Play, Repeat2, Shuffle, SkipForward } from 'lucide-react';
import { musicSourceName, type MusicState } from '../core/services';
import { IconButton } from './primitives';
import { afterSkip, formatDuration, playbackPosition } from './music-playback';

/** Что сейчас звучит, где игла и чем это можно перебить. */
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
  return (
    <>
      <div className="now-playing">
        <span className="panel-eyebrow">
          {state.status === 'connecting'
            ? 'ПОДКЛЮЧАЕМ МУЗЫКУ'
            : state.paused
              ? 'НА ПАУЗЕ'
              : current
                ? 'СЕЙЧАС ИГРАЕТ'
                : 'ГОТОВЫ СЛУШАТЬ'}
        </span>
        <strong>{current?.title ?? 'Добавьте первый трек'}</strong>
        <span>
          {current?.artist || (current ? `Добавил: ${current.addedBy}` : 'Из файла, Telegram или Яндекса')}
        </span>
        {current && <span className="music-source">Источник · {musicSourceName(current.source)}</span>}
      </div>
      {current && (
        <div className="music-progress">
          <input
            type="range"
            min="0"
            max={Math.max(1, current.duration)}
            step="1"
            disabled={!canUse}
            aria-label="Позиция трека"
            value={dragging ?? position}
            onChange={(e) => setDragging(Number(e.target.value))}
            onPointerUp={(e) => commit(Number(e.currentTarget.value))}
            onKeyUp={(e) => {
              if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key))
                commit(Number(e.currentTarget.value));
            }}
          />
          <div>
            <span>{formatDuration(dragging ?? position)}</span>
            <span>{formatDuration(current.duration)}</span>
          </div>
        </div>
      )}
      <div className="music-controls">
        <IconButton
          label={state.paused ? 'Продолжить музыку' : 'Пауза музыки'}
          disabled={!canUse || !current}
          onClick={() =>
            onCommand(state.paused ? 'play' : 'pause', undefined, {
              paused: !state.paused,
              status: state.paused ? 'playing' : 'paused',
            })
          }
        >
          {state.paused ? <Play size={22} /> : <Pause size={22} />}
        </IconButton>
        <IconButton
          label="Следующий трек"
          disabled={!canUse || !current}
          onClick={() => onCommand('skip', undefined, afterSkip(state))}
        >
          <SkipForward size={22} />
        </IconButton>
        <IconButton
          label="Перемешать очередь"
          disabled={!canUse || state.queue.length < 3}
          onClick={() => onCommand('shuffle')}
        >
          <Shuffle size={19} />
        </IconButton>
        <IconButton
          label="Повторять очередь"
          aria-pressed={state.repeat}
          className={state.repeat ? 'selected' : ''}
          disabled={!canUse}
          onClick={() => onCommand('repeat', { enabled: !state.repeat }, { repeat: !state.repeat })}
        >
          <Repeat2 size={19} />
        </IconButton>
      </div>
      {state.participantId && (
        <label className="gain-setting music-volume">
          Громкость музыки у вас · {Math.round(volume * 100)}%
          {/*
            Музыке усиление не положено. Тихий собеседник — это случайность его микрофона, и
            её честно исправлять усилением; трек же приходит сведённым и на своём уровне, и
            всё сверх 100 % — это не «громче», а клиппинг. Потолок в 200 % остаётся у людей.
          */}
          <input
            type="range"
            min="0"
            max="100"
            step="5"
            value={volume * 100}
            onChange={(e) => onVolume(Number(e.target.value) / 100)}
          />
        </label>
      )}
    </>
  );
}
