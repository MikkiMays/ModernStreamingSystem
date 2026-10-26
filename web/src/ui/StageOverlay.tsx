import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Clapperboard, Club, Crown, Music2, Pencil, Spade, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Snapshot } from '../api/types';
import type { Meeting } from '../core/meeting';
import type { MusicState } from '../core/services';
import type { Translate } from '../i18n';
import { useIntegrationBarSlot } from './IntegrationBar';
import { MusicMini, useMusicMini } from './music/MusicMini';
import { useStore } from './primitives';
import './stage-overlay.css';

/**
 * Активные интеграции поверх звонка (R30).
 *
 * Владелец: «если боты добавлены, то отображать их справа сверху, но не отдельным блоком, а
 * полупрозрачным поверх звонка». Раньше музыка жила отдельной непрозрачной колонкой справа от сетки —
 * и только в разговоре: на столе и в кинозале её не было вовсе, а сетка теряла 220 px. Теперь слой
 * один над всеми ветками сцены (разговор, чужой экран, столы, кинозал): чипы-«стекло» — игра, кино,
 * музыка; нажатие открывает панель интеграций. Пустой слой не видно и диктору не слышно.
 *
 * Музыка здесь — мини-плеер (R31, `music/MusicMini`): играет трек — полоса с ⏮ ⏯ ⏭ и виджетом плеера по
 * нажатию на трек; идёт игра, а музыки нет, — предложение её включить. За столом игры мини-плеер и
 * предложение уходят в шапку стола (`IntegrationBarSlot`, R128). `children` — ещё что-то в тот же ряд.
 */
export type ChipKind = 'poker' | 'durak' | 'chess' | 'gartic' | 'cinema' | 'music';

export interface StageChip {
  kind: ChipKind;
  /** Видимая подпись — она же имя кнопки. */
  label: string;
  /** Полностью — подсказкой: подпись в чипе обрезается. */
  title: string;
  /** Музыка звучит прямо сейчас — у чипа эквалайзер. */
  playing?: boolean;
}

/** Музыка комнаты: есть ли её бот во встрече и что отвечает служба. */
export interface MusicPresence {
  present: boolean;
  state?: MusicState;
  failed?: boolean;
}

const ICONS: Record<ChipKind, LucideIcon> = {
  poker: Spade,
  durak: Club,
  chess: Crown,
  gartic: Pencil,
  cinema: Clapperboard,
  music: Music2,
};

const seated = (seats: readonly { memberId?: string | null }[] | undefined) =>
  (seats ?? []).filter((seat) => !!seat.memberId).length;

function game(t: Translate, name: string, count: number): string {
  return count > 0 ? t(($) => $.services.roster.seated, { name, count }) : name;
}

/**
 * Что сейчас занимает сцену (`Stage.tsx`, тот же порядок): чужой экран, стол, кинозал — или разговор.
 * Чип того, что и так во всю сцену, не нужен: он повторял бы стол и закрывал бы его же кнопки.
 */
export function stageShows(snapshot: Snapshot, viewing: boolean): ChipKind | null {
  if (viewing) return null;
  if (snapshot.chess) return 'chess';
  if (snapshot.gartic) return 'gartic';
  if (snapshot.poker) return 'poker';
  if (snapshot.durak) return 'durak';
  return snapshot.watch ? 'cinema' : null;
}

/** Что показать чипами — по снимку комнаты и ответу службы музыки. Порядок: игра, кино, музыка. */
export function stageChips(
  t: Translate,
  snapshot: Snapshot,
  music: MusicPresence,
  onStage: ChipKind | null = null,
): StageChip[] {
  const chips: StageChip[] = [];
  const add = (kind: ChipKind, label: string, title = label, playing?: boolean) => {
    if (kind !== onStage) chips.push({ kind, label, title, ...(playing === undefined ? {} : { playing }) });
  };
  if (snapshot.poker)
    add(
      'poker',
      game(
        t,
        t(($) => $.services.games.poker),
        seated(snapshot.poker.seats),
      ),
    );
  if (snapshot.durak)
    add(
      'durak',
      game(
        t,
        t(($) => $.services.games.durak),
        seated(snapshot.durak.seats),
      ),
    );
  if (snapshot.chess) {
    const { white, black } = snapshot.chess as { white?: unknown; black?: unknown };
    add(
      'chess',
      game(
        t,
        t(($) => $.services.games.chess),
        [white, black].filter(Boolean).length,
      ),
    );
  }
  if (snapshot.gartic) {
    const players = (snapshot.gartic as { players?: unknown[] }).players ?? [];
    add('gartic', game(t, 'Gartic', players.length));
  }
  if (snapshot.watch) {
    const cinema = t(($) => $.services.roster.cinema);
    const title = snapshot.watch.title?.trim();
    if (title)
      add(
        'cinema',
        title,
        t(($) => $.services.roster.titled, { name: cinema, title }),
      );
    else add('cinema', cinema);
  }
  if (music.present) {
    const name = t(($) => $.services.roster.music);
    const state = music.state;
    const current = state?.enabled ? state.queue[0] : undefined;
    const playing = !!current && state?.status === 'playing' && !state.paused;
    if (playing && current) {
      const title = current.artist ? `${current.title} — ${current.artist}` : current.title;
      add(
        'music',
        current.title,
        t(($) => $.services.roster.titled, { name, title }),
        true,
      );
    } else {
      const status = music.failed
        ? t(($) => $.services.status.unavailable)
        : !state
          ? t(($) => $.services.status.loading)
          : t(
              ($) =>
                $.services.status[state.status === 'idle' && !state.queue.length ? 'empty' : state.status],
            );
      add(
        'music',
        t(($) => $.services.roster.status, { name, status }),
        undefined,
        false,
      );
    }
  }
  return chips;
}

export function StageOverlay({
  meeting,
  onOpenServices,
  children,
}: {
  meeting: Meeting;
  onOpenServices: () => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const snapshot = useStore(meeting.snapshot);
  const viewing = useStore(meeting.viewing);
  // Музыка — мини-плеером или предложением её включить (R31), а не чипом, который открывал панель:
  // виджет управляет музыкой, не переключая интеграции. Чипы — игра и кино.
  const mini = useMusicMini(meeting);
  /*
    Сцену занимает стол игры — у его шапки есть место для музыки (R128): мини-плеер встаёт туда
    порталом, частью шапки, а не плашкой поверх стола. Состояние и открытый виджет — те же.
  */
  const slot = useIntegrationBarSlot();
  const chips = stageChips(t, snapshot, { present: false }, stageShows(snapshot, !!viewing));
  const empty = chips.length === 0 && (mini.view.kind === 'none' || !!slot) && !children;
  const music = <MusicMini meeting={meeting} mini={mini} placement={slot ? 'bar' : 'stage'} />;
  return (
    <div
      className="stage-overlay"
      role={empty ? undefined : 'region'}
      aria-label={empty ? undefined : t(($) => $.services.roster.label)}
      aria-hidden={empty || undefined}
      data-empty={empty || undefined}
    >
      {chips.map((chip) => {
        const Icon = ICONS[chip.kind];
        return (
          <button
            key={chip.kind}
            type="button"
            className="stage-chip media-stage"
            data-kind={chip.kind}
            title={chip.title}
            onClick={onOpenServices}
          >
            <span className="stage-chip__brand" aria-hidden="true">
              <Icon />
            </span>
            <span className="stage-chip__label">{chip.label}</span>
            {chip.playing && (
              <span className="stage-chip__eq" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            )}
          </button>
        );
      })}
      {slot ? createPortal(music, slot) : music}
      {children}
    </div>
  );
}
