import type { DurakTable, PokerTable } from '../api/types';
import type { MusicState } from '../core/services';
import type { Translate } from '../i18n';

export type ServiceActivity = { active: boolean; label: string };

/** The music API is the source of truth: a media bot may reconnect late or not be listed at all. */
export function musicActivity(
  t: Translate,
  state: MusicState | undefined,
  unavailable = false,
): ServiceActivity {
  if (unavailable) return { active: false, label: t(($) => $.services.status.unavailable) };
  if (!state) return { active: false, label: t(($) => $.services.status.loading) };
  const status = state.status === 'idle' && !state.queue.length ? 'empty' : state.status;
  return { active: state.enabled && state.status !== 'disabled', label: t(($) => $.services.status[status]) };
}

function gameLabel(t: Translate, name: string, phase: string) {
  const status =
    phase === 'lobby'
      ? t(($) => $.services.game.lobby)
      : ['over', 'finished', 'reveal'].includes(phase)
        ? t(($) => $.services.game.over)
        : t(($) => $.services.game.playing);
  return t(($) => $.services.game.label, { name, status });
}

export function gameActivity(
  t: Translate,
  poker: Pick<PokerTable, 'phase'> | null,
  durak: Pick<DurakTable, 'phase'> | null,
  chess?: { phase: string } | null,
  gartic?: { phase: string } | null,
) {
  const labels = [
    poker &&
      gameLabel(
        t,
        t(($) => $.services.games.poker),
        poker.phase,
      ),
    durak &&
      gameLabel(
        t,
        t(($) => $.services.games.durak),
        durak.phase,
      ),
    chess &&
      gameLabel(
        t,
        t(($) => $.services.games.chess),
        chess.phase,
      ),
    gartic && gameLabel(t, 'Gartic', gartic.phase),
  ].filter(Boolean);
  return { active: labels.length > 0, label: labels.join(' · ') };
}
