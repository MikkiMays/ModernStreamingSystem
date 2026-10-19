import { useCallback, useSyncExternalStore } from 'react';
import type { Meeting } from '../core/meeting';
import type { VoiceTier } from '../media/levels';

/**
 * Ступень голоса участника (0 — молчит, 1–4 — тихо, речь, громко, пик) из `media/levels.ts`.
 *
 * Подписка и есть «смотрю на него»: пока компонент на экране, его голос измеряется, ушёл — анализ
 * закрывается. Перерисовка — только когда ступень сменилась, а не на каждом опросе: сравнение
 * делает `useSyncExternalStore`.
 */
export function useVoiceTier(meeting: Meeting, id: string | null | undefined): VoiceTier {
  const levels = meeting.media.levels;
  const subscribe = useCallback(
    (listener: () => void) => (id ? levels.watch(id, listener) : () => {}),
    [levels, id],
  );
  return useSyncExternalStore(subscribe, () => (id ? levels.tier(id) : 0));
}

/** Уровень голоса участника, 0..1 — для шкал. Перерисовывает до 30 раз в секунду, пока звучит. */
export function useVoiceLevel(meeting: Meeting | null | undefined, id: string | null | undefined): number {
  const levels = meeting?.media.levels;
  const subscribe = useCallback(
    (listener: () => void) => (levels && id ? levels.watch(id, listener) : () => {}),
    [levels, id],
  );
  return useSyncExternalStore(subscribe, () => (levels && id ? levels.level(id) : 0));
}
