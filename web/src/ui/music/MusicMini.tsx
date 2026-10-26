import {
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import { Music2, Pause, Play, SkipBack, SkipForward, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Snapshot } from '../../api/types';
import type { Meeting } from '../../core/meeting';
import type { MusicTrack } from '../../core/services';
import { IconButton, Popover } from '../kit';
import { MusicCover } from '../MusicCover';
import { Equalizer, playerStatus, soundsNow, usePlayback } from '../MusicPlayer';
import { afterPrevious, afterSkip } from '../music-playback';
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
 * - играет трек — мини-плеер: обложка, название и исполнитель (нажатие открывает плеер), ⏮ ⏯ ⏭;
 * - музыка есть, а трека нет (подключается, очередь пуста) — чип с состоянием словами.
 * Нажатие открывает виджет — тот же плеер, что в панели интеграций (`MusicWidget`), — поповером под
 * полосой, на телефоне листом снизу. Панель при этом не переключается.
 *
 * Где он стоит (R128): в разговоре — поверх сцены справа сверху, «стеклом сцены»; когда сцену занимает
 * стол игры — в шапке стола (`IntegrationBarSlot`), как её часть, а не плашкой поверх стола.
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

/** Где стоит мини-плеер: поверх сцены (разговор) или в шапке интеграции (стол игры, R128). */
export type MiniPlacement = 'stage' | 'bar';

export function MusicMini({
  meeting,
  mini,
  placement = 'stage',
}: {
  meeting: Meeting;
  mini: MusicMiniModel;
  placement?: MiniPlacement;
}) {
  const { t } = useTranslation();
  const { view, music, open, setOpen } = mini;
  if (view.kind === 'none') return null;
  const widget = (trigger: ReactElement, anchor?: RefObject<HTMLElement | null>) => (
    <Popover
      trigger={trigger}
      anchor={anchor}
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
      <span className="music-offer media-stage" data-placement={placement}>
        {widget(
          <button
            type="button"
            className="music-offer__chip"
            disabled={music.busy}
            onClick={() => {
              // Одно нажатие — и музыка уже добавляется; виджет открыт, чтобы сразу найти трек.
              if (!music.present) music.enable();
            }}
          >
            <Music2 aria-hidden="true" />
            <span className="music-offer__label">{t(($) => $.music.mini.offer)}</span>
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
      <button
        type="button"
        className="music-mini__chip media-stage"
        data-placement={placement}
        title={view.chip.title}
      >
        <span className="music-mini__glyph" aria-hidden="true">
          <Music2 />
        </span>
        <span className="music-mini__label">{view.chip.label}</span>
      </button>,
    );

  return (
    <MiniBar
      track={view.track}
      music={music}
      placement={placement}
      behind={() => meeting.media.musicPlayoutMs()}
      widget={widget}
    />
  );
}

/**
 * Полоса «играет» (R128): обложка, название и исполнитель — одна большая кнопка, она и открывает
 * виджет; ⏮ ⏯ ⏭ рядом — свои кнопки, виджет не открывают. Шеврона «раскрыть» больше нет (владелец:
 * «открывать виджет музыки не при нажатии на стрелку, а при нажатии на сам трек и исполнителя»).
 * ⏯ — сплошной светлый круг, как в плеере; ход трека — волосок внизу. Виджет встаёт под всей полосой.
 */
function MiniBar({
  track,
  music,
  placement,
  behind,
  widget,
}: {
  track: MusicTrack;
  music: MusicControl;
  placement: MiniPlacement;
  behind: () => number;
  widget: (trigger: ReactElement, anchor?: RefObject<HTMLElement | null>) => ReactNode;
}) {
  const { t } = useTranslation();
  const bar = useRef<HTMLDivElement>(null);
  const state = music.state!;
  const canUse = music.can('music.control');
  const position = usePlayback(state, behind);
  const playing = soundsNow(state);
  const progress = track.duration ? Math.min(1, position / track.duration) : 0;
  const name = track.artist ? `${track.title} — ${track.artist}` : track.title;
  return (
    <div
      ref={bar}
      className="music-mini media-stage"
      role="group"
      aria-label={t(($) => $.music.mini.label)}
      data-placement={placement}
      data-playing={playing || undefined}
      style={{ '--music-progress': progress } as CSSProperties}
    >
      {widget(
        <button
          type="button"
          className="music-mini__track"
          aria-label={t(($) => $.music.mini.openTrack, { track: name })}
          title={name}
        >
          <MusicCover track={track} />
          <span className="music-mini__text">
            <strong>{track.title}</strong>
            <small>
              {playing && <Equalizer />}
              <span>{track.artist || playerStatus(t, state)}</span>
            </small>
          </span>
        </button>,
        bar,
      )}
      <IconButton
        tone="stage"
        size="sm"
        className="music-mini__step"
        label={t(($) => $.music.player.previous)}
        disabled={!canUse}
        onClick={() => music.command('previous', undefined, afterPrevious(position))}
      >
        <SkipBack fill="currentColor" />
      </IconButton>
      <IconButton
        tone="stage"
        size="sm"
        className="music-play music-mini__play"
        data-icon={state.paused ? 'play' : 'pause'}
        label={state.paused ? t(($) => $.music.player.resume) : t(($) => $.music.player.pause)}
        disabled={!canUse}
        onClick={() =>
          music.command(state.paused ? 'play' : 'pause', undefined, {
            paused: !state.paused,
            status: state.paused ? 'playing' : 'paused',
          })
        }
      >
        {state.paused ? <Play fill="currentColor" /> : <Pause fill="currentColor" />}
      </IconButton>
      <IconButton
        tone="stage"
        size="sm"
        className="music-mini__step"
        label={t(($) => $.music.player.next)}
        disabled={!canUse}
        onClick={() => music.command('skip', undefined, afterSkip(state))}
      >
        <SkipForward fill="currentColor" />
      </IconButton>
      <span className="music-mini__progress" aria-hidden="true">
        <i />
      </span>
    </div>
  );
}
