import type { DurakTable, PokerTable } from '../api/types';
import type { MusicState } from '../core/services';

export type ServiceActivity = { active: boolean; label: string };

/** The music API is the source of truth: a media bot may reconnect late or not be listed at all. */
export function musicActivity(state: MusicState | undefined, unavailable = false): ServiceActivity {
  if (unavailable) return { active: false, label: 'Статус недоступен' };
  if (!state) return { active: false, label: 'Загружаем статус' };
  const labels: Record<MusicState['status'], string> = {
    disabled: 'Выключена',
    connecting: 'Подключается',
    playing: 'Играет',
    paused: 'На паузе',
    idle: state.queue.length ? 'Готова к воспроизведению' : 'Очередь пуста',
    error: 'Ошибка',
  };
  return { active: state.enabled && state.status !== 'disabled', label: labels[state.status] };
}

function gameLabel(name: string, phase: string) {
  const status = phase === 'lobby' ? 'лобби' : phase === 'over' ? 'завершён' : 'игра идёт';
  return `${name}: ${status}`;
}

export function gameActivity(
  poker: Pick<PokerTable, 'phase'> | null,
  durak: Pick<DurakTable, 'phase'> | null,
) {
  const labels = [poker && gameLabel('Покер', poker.phase), durak && gameLabel('Дурак', durak.phase)].filter(
    Boolean,
  );
  return { active: labels.length > 0, label: labels.join(' · ') };
}
