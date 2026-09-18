import { ListPlus, Trash2 } from 'lucide-react';
import { musicSourceName, type MusicState, type MusicTrack } from '../core/services';
import { IconButton } from './primitives';
import { afterPromote, afterRemove, formatDuration } from './music-playback';

/** Что стоит после текущего трека и что с этим можно сделать. */
export function MusicQueue({
  state,
  canUse,
  onClear,
  onPromote,
  onRemove,
}: {
  state: MusicState;
  canUse: boolean;
  onClear: (patch: Partial<MusicState>) => void;
  onPromote: (track: MusicTrack, patch: Partial<MusicState>) => void;
  onRemove: (track: MusicTrack, patch: Partial<MusicState>) => void;
}) {
  if (!state.queue.length) return null;
  return (
    <section className="music-queue" aria-label="Музыкальная очередь">
      <div className="queue-heading">
        <h4>Сейчас и далее · {state.queue.length}</h4>
        <IconButton
          label="Очистить следующие треки"
          disabled={!canUse || state.queue.length < 2}
          onClick={() => onClear({ queue: state.queue.slice(0, 1) })}
        >
          <Trash2 size={16} />
        </IconButton>
      </div>
      <ol>
        {state.queue.map((track, i) => (
          <li key={track.id} data-current={i === 0}>
            <span className="queue-number">{i + 1}</span>
            <div className="queue-track">
              <strong>{track.title}</strong>
              <small>
                {track.artist || track.addedBy} · {musicSourceName(track.source)} ·{' '}
                {formatDuration(track.duration)}
              </small>
            </div>
            {i > 1 && (
              <IconButton
                label={`Следующим: ${track.title}`}
                disabled={!canUse}
                onClick={() => onPromote(track, afterPromote(state, track))}
              >
                <ListPlus size={16} />
              </IconButton>
            )}
            <IconButton
              label={`Убрать трек: ${track.title}`}
              disabled={!canUse}
              onClick={() => onRemove(track, afterRemove(state, track.id))}
            >
              <Trash2 size={15} />
            </IconButton>
          </li>
        ))}
      </ol>
    </section>
  );
}
