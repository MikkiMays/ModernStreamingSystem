import { useState, type CSSProperties, type ReactElement, type ReactNode } from 'react';
import { ChevronDown, Music2, Pause, Play, SkipBack, SkipForward, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Snapshot } from '../../api/types';
import type { Meeting } from '../../core/meeting';
import type { MusicTrack } from '../../core/services';
import { paint } from '../brands';
import { IconButton, Popover } from '../kit';
import { MusicCover } from '../MusicCover';
import { Equalizer, playerStatus, soundsNow, usePlayback } from '../MusicPlayer';
import { afterPrevious, afterSkip } from '../music-playback';
import { sourceBrand } from '../music-platforms';
import { useStore } from '../primitives';
import { stageChips, type StageChip } from '../StageOverlay';
import { MusicWidget } from './MusicWidget';
import { useMusic, type MusicControl } from './useMusic';
import './music-mini.css';

/**
 * Музыка поверх звонка (R31): мини-плеер, а когда музыки нет — предложение её включить.
 *
 * Владелец: «при включенной интеграции, что не мешает музыке, сверху где-то в корде предлагать включить
 * интеграцию музыки, а также сделать небольшой плеер при проигрывании, а при нажатии можно было бы
 * управлять музыкой как виджетом, не переключаясь между интеграциями». Поэтому в слое над сценой
 * (R30, справа сверху) три вида:
 * - идёт игра (под неё музыка не мешает, в отличие от кинозала), музыки во встрече нет, и этому
 *   человеку можно её добавить, — чип «Включить музыку» с крестиком «не предлагать до конца встречи»;
 * - играет трек — мини-плеер: обложка, название, эквалайзер, ⏮ ⏯ ⏭ и «открыть плеер»;
 * - музыка есть, а трека нет (подключается, очередь пуста) — чип с состоянием словами.
 * Нажатие открывает виджет — тот же плеер, что в панели интеграций (`MusicWidget`), — поповером под
 * полосой, на телефоне листом снизу. Панель при этом не переключается.
 */
export type MiniView =
  | { kind: 'none' }
  | { kind: 'offer' }
  | { kind: 'chip'; chip: StageChip }
  | { kind: 'bar'; track: MusicTrack };

/** Встречи, где предложение включить музыку скрыли крестиком: до конца встречи оно не вернётся. */
const DISMISSED = new WeakSet<Meeting>();

const playingGame = (snapshot: Snapshot) =>
  !!(snapshot.poker || snapshot.durak || snapshot.chess || snapshot.gartic);

/** Что показать поверх звонка — и музыка, с которой это показывать (один хук встречи, `useMusic`). */
export function useMusicMini(meeting: Meeting) {
  const { t } = useTranslation();
  const snapshot = useStore(meeting.snapshot);
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(() => DISMISSED.has(meeting));
  const present = snapshot.participants.some(
    (p) => p.service === 'music' && ['JOINING', 'CONNECTED', 'RECOVERING'].includes(p.status),
  );
  // Пока музыки нет и виджет закрыт, службу спрашивать незачем; открытый виджет — спрашивает.
  const music = useMusic(meeting, { poll: present || open });
  const current = music.state?.enabled ? music.state.queue[0] : undefined;
  const view: MiniView = present
    ? current
      ? { kind: 'bar', track: current }
      : {
          kind: 'chip',
          chip: stageChips(t, snapshot, { present, state: music.state, failed: music.failed }).find(
            (chip) => chip.kind === 'music',
          )!,
        }
    : (open || (playingGame(snapshot) && !snapshot.watch && !dismissed)) && music.can('music.enable')
      ? { kind: 'offer' }
      : { kind: 'none' };
  return {
    view,
    music,
    open,
    setOpen,
    dismiss: () => {
      DISMISSED.add(meeting);
      setDismissed(true);
    },
  };
}

export type MusicMiniModel = ReturnType<typeof useMusicMini>;

export function MusicMini({ meeting, mini }: { meeting: Meeting; mini: MusicMiniModel }) {
  const { t } = useTranslation();
  const { view, music, open, setOpen } = mini;
  if (view.kind === 'none') return null;
  const widget = (trigger: ReactElement) => (
    <Popover
      trigger={trigger}
      open={open}
      onOpenChange={setOpen}
      width={360}
      drawerHeight="85"
      title={t(($) => $.services.music.title)}
      className="music-mini__popover"
    >
      <MusicWidget meeting={meeting} music={music} />
    </Popover>
  );

  if (view.kind === 'offer')
    return (
      <span className="music-offer">
        {widget(
          <button
            type="button"
            className="stage-chip music-offer__chip media-stage"
            data-kind="music"
            disabled={music.busy}
            onClick={() => {
              // Одно нажатие — и музыка уже добавляется; виджет открыт, чтобы сразу найти трек.
              if (!music.present) music.enable();
            }}
          >
            <span className="stage-chip__brand" aria-hidden="true">
              <Music2 />
            </span>
            <span className="stage-chip__label">{t(($) => $.music.mini.offer)}</span>
          </button>,
        )}
        <IconButton
          tone="stage"
          size="sm"
          className="music-offer__dismiss"
          label={t(($) => $.music.mini.dismiss)}
          onClick={mini.dismiss}
        >
          <X />
        </IconButton>
      </span>
    );

  if (view.kind === 'chip')
    return widget(
      <button type="button" className="stage-chip media-stage" data-kind="music" title={view.chip.title}>
        <span className="stage-chip__brand" aria-hidden="true">
          <Music2 />
        </span>
        <span className="stage-chip__label">{view.chip.label}</span>
      </button>,
    );

  return (
    <MiniBar
      track={view.track}
      music={music}
      behind={() => meeting.media.musicPlayoutMs()}
      onOpen={() => setOpen(true)}
      widget={widget}
    />
  );
}

function MiniBar({
  track,
  music,
  behind,
  onOpen,
  widget,
}: {
  track: MusicTrack;
  music: MusicControl;
  behind: () => number;
  onOpen: () => void;
  widget: (trigger: ReactElement) => ReactNode;
}) {
  const { t } = useTranslation();
  const state = music.state!;
  const canUse = music.can('music.control');
  const position = usePlayback(state, behind);
  const playing = soundsNow(state);
  const progress = track.duration ? Math.min(1, position / track.duration) : 0;
  return (
    <div
      className="music-mini media-stage"
      role="group"
      aria-label={t(($) => $.music.mini.label)}
      data-playing={playing || undefined}
      style={{ ...paint(sourceBrand(track.source)), '--music-progress': progress } as CSSProperties}
    >
      <button
        type="button"
        className="music-mini__track"
        title={track.artist ? `${track.title} — ${track.artist}` : track.title}
        onClick={onOpen}
      >
        <MusicCover track={track} />
        <span className="music-mini__text">
          <strong>{track.title}</strong>
          <small>{track.artist || playerStatus(t, state)}</small>
        </span>
        {playing && <Equalizer />}
      </button>
      <IconButton
        tone="stage"
        size="sm"
        className="music-mini__step"
        label={t(($) => $.music.player.previous)}
        disabled={!canUse}
        onClick={() => music.command('previous', undefined, afterPrevious(position))}
      >
        <SkipBack />
      </IconButton>
      <IconButton
        tone="stage"
        size="sm"
        className="music-mini__play"
        label={state.paused ? t(($) => $.music.player.resume) : t(($) => $.music.player.pause)}
        disabled={!canUse}
        onClick={() =>
          music.command(state.paused ? 'play' : 'pause', undefined, {
            paused: !state.paused,
            status: state.paused ? 'playing' : 'paused',
          })
        }
      >
        {state.paused ? <Play /> : <Pause />}
      </IconButton>
      <IconButton
        tone="stage"
        size="sm"
        className="music-mini__step"
        label={t(($) => $.music.player.next)}
        disabled={!canUse}
        onClick={() => music.command('skip', undefined, afterSkip(state))}
      >
        <SkipForward />
      </IconButton>
      {widget(
        <IconButton tone="stage" size="sm" className="music-mini__open" label={t(($) => $.music.mini.open)}>
          <ChevronDown />
        </IconButton>,
      )}
      <span className="music-mini__progress" aria-hidden="true" />
    </div>
  );
}
