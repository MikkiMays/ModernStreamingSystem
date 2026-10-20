import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { GripVertical, ListStart, MoreHorizontal, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { musicSourceName, type MusicState, type MusicTrack } from '../core/services';
import { Button, IconButton, Menu, MenuContent, MenuItem, MenuTrigger } from './kit';
import { MusicCover } from './MusicCover';
import { afterMove, afterPromote, afterRemove, dropIndex, formatDuration } from './music-playback';

interface Drag {
  id: string;
  pointer: number;
  /** Откуда взяли — по вертикали, чтобы строка шла за пальцем. */
  startY: number;
  dy: number;
  /** Куда встанет: место в очереди (не раньше первого после играющего). */
  index: number;
}

/**
 * «Далее» (T18): что заиграет после текущего трека. Играющий здесь не повторяется — он в карточке
 * «Сейчас играет» выше.
 *
 * ПЕРЕСТАНОВКА — ЗА РУЧКУ, ЛЮБЫМ УКАЗАТЕЛЕМ. На главной (E02) касание не тащит строку: там палец
 * листает список. Здесь тянут только за ручку — отдельный элемент управления, который список не
 * листает (`touch-action: none`), поэтому и пальцем тоже. С клавиатуры — стрелки ↑/↓ на ручке.
 * Строка идёт за указателем, черта показывает, куда она встанет; служба ставит её туда же
 * (`move`), а до ответа видно предсказание (`afterMove`).
 */
export function MusicQueue({
  state,
  canUse,
  onClear,
  onPromote,
  onRemove,
  onMove,
}: {
  state: MusicState;
  canUse: boolean;
  onClear: (patch: Partial<MusicState>) => void;
  onPromote: (track: MusicTrack, patch: Partial<MusicState>) => void;
  onRemove: (track: MusicTrack, patch: Partial<MusicState>) => void;
  onMove: (track: MusicTrack, index: number, patch: Partial<MusicState>) => void;
}) {
  const { t } = useTranslation();
  const list = useRef<HTMLOListElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [said, setSaid] = useState('');
  const upcoming = state.queue.slice(1);
  /*
    Строку, которую тянут, может унести опрос: трек заиграл, кончился или его убрал другой участник,
    а с ним пропала и ручка — и её `pointerup` уже не придёт. Право могли отобрать посреди движения.
    Тогда перетаскивание кончается само, а не висит до следующего нажатия.
  */
  const lost = !!drag && (!canUse || !upcoming.some((track) => track.id === drag.id));
  useEffect(() => {
    if (lost) setDrag(null);
  }, [lost]);
  if (!state.queue.length) return null;

  const move = (track: MusicTrack, index: number) => {
    const from = state.queue.findIndex((entry) => entry.id === track.id);
    const to = Math.min(Math.max(1, index), state.queue.length - 1);
    if (from < 1 || to === from) return;
    onMove(track, to, afterMove(state, track.id, to));
    setSaid(t(($) => $.music.queue.moved, { title: track.title, position: to }));
    // Строка переехала в разметке, и фокус с её ручки мог уйти вместе с узлом — возвращаем.
    requestAnimationFrame(() =>
      [...(list.current?.querySelectorAll<HTMLElement>('[data-handle]') ?? [])]
        .find((handle) => handle.dataset.handle === track.id)
        ?.focus(),
    );
  };
  /** Середины строк, кроме перетаскиваемой; играющий трек — «выше всех» (его строки здесь нет). */
  const middles = (id: string) => [
    Number.NEGATIVE_INFINITY,
    ...[...(list.current?.querySelectorAll<HTMLElement>('[data-track-id]') ?? [])]
      .filter((row) => row.dataset.trackId !== id)
      .map((row) => {
        const box = row.getBoundingClientRect();
        return box.top + box.height / 2;
      }),
  ];
  const grab = (track: MusicTrack, event: PointerEvent<HTMLButtonElement>) => {
    if (!canUse || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({
      id: track.id,
      pointer: event.pointerId,
      startY: event.clientY,
      dy: 0,
      index: state.queue.findIndex((entry) => entry.id === track.id),
    });
  };
  const follow = (event: PointerEvent<HTMLButtonElement>) => {
    if (!drag || drag.pointer !== event.pointerId) return;
    setDrag({ ...drag, dy: event.clientY - drag.startY, index: dropIndex(middles(drag.id), event.clientY) });
  };
  const drop = (track: MusicTrack, event: PointerEvent<HTMLButtonElement>) => {
    if (!drag || drag.pointer !== event.pointerId) return;
    setDrag(null);
    move(track, drag.index);
  };
  const step = (track: MusicTrack, index: number, event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    move(track, index + (event.key === 'ArrowUp' ? -1 : 1));
  };

  // Черта места: перед той строкой, что после переезда окажется сразу за перетаскиваемой.
  const rest = drag ? state.queue.filter((entry) => entry.id !== drag.id) : [];
  const before = drag ? rest[drag.index]?.id : undefined;
  const last = drag && drag.index >= rest.length ? rest.at(-1)?.id : undefined;

  return (
    <section
      className="music-queue"
      aria-label={t(($) => $.music.queue.label)}
      data-dragging={drag ? 'true' : undefined}
    >
      <div className="music-queue__head">
        <h4>{t(($) => $.music.queue.next)}</h4>
        {upcoming.length > 0 && <span className="music-queue__count">{upcoming.length}</span>}
        <Button
          variant="quiet"
          size="sm"
          className="music-queue__clear"
          disabled={!canUse || upcoming.length === 0}
          onClick={() => onClear({ queue: state.queue.slice(0, 1) })}
        >
          {t(($) => $.music.queue.clear)}
        </Button>
      </div>
      {upcoming.length === 0 ? (
        <p className="music-queue__empty">{t(($) => $.music.queue.empty)}</p>
      ) : (
        <ol ref={list} className="music-queue__list">
          {upcoming.map((track, i) => {
            const index = i + 1;
            const dragging = drag?.id === track.id;
            return (
              <li
                key={track.id}
                className="music-queue__row"
                data-track-id={track.id}
                data-lifted={dragging || undefined}
                data-insert={track.id === before ? 'before' : track.id === last ? 'after' : undefined}
                style={dragging ? { transform: `translateY(${drag.dy}px)` } : undefined}
              >
                <button
                  type="button"
                  className="music-queue__handle"
                  data-handle={track.id}
                  aria-label={t(($) => $.music.queue.reorder, { title: track.title })}
                  aria-describedby="music-queue-hint"
                  disabled={!canUse}
                  onPointerDown={(event) => grab(track, event)}
                  onPointerMove={follow}
                  onPointerUp={(event) => drop(track, event)}
                  onPointerCancel={() => setDrag(null)}
                  onLostPointerCapture={(event) => {
                    if (drag?.pointer === event.pointerId) setDrag(null);
                  }}
                  onKeyDown={(event) => step(track, index, event)}
                >
                  <GripVertical size={16} aria-hidden="true" />
                </button>
                <MusicCover track={track} />
                <div className="music-queue__text">
                  <strong>{track.title}</strong>
                  <small>
                    <span>{track.artist || track.addedBy}</span>
                    {/* Источник — когда панель шире: на узкой он отнял бы место у названия. */}
                    <span className="music-queue__source">{musicSourceName(t, track.source)}</span>
                  </small>
                </div>
                <span className="music-queue__time">{formatDuration(track.duration)}</span>
                <Menu>
                  <MenuTrigger
                    disabled={!canUse}
                    render={
                      <IconButton
                        size="sm"
                        className="music-queue__more"
                        label={t(($) => $.music.queue.actions, { title: track.title })}
                      >
                        <MoreHorizontal size={16} />
                      </IconButton>
                    }
                  />
                  <MenuContent align="end">
                    {index > 1 && (
                      <MenuItem
                        icon={<ListStart size={16} />}
                        onClick={() => onPromote(track, afterPromote(state, track))}
                      >
                        {t(($) => $.music.queue.playNext)}
                      </MenuItem>
                    )}
                    <MenuItem
                      icon={<Trash2 size={16} />}
                      destructive
                      onClick={() => onRemove(track, afterRemove(state, track.id))}
                    >
                      {t(($) => $.music.queue.remove)}
                    </MenuItem>
                  </MenuContent>
                </Menu>
              </li>
            );
          })}
        </ol>
      )}
      <span id="music-queue-hint" hidden>
        {t(($) => $.music.queue.hint)}
      </span>
      <span className="music-queue__said" role="status">
        {said}
      </span>
    </section>
  );
}
