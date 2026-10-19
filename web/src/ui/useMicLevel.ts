import type { Meeting } from '../core/meeting';
import { useVoiceLevel } from './useVoice';

/**
 * Уровень микрофона, который встреча сейчас отдаёт, от 0 до 100 — для шкалы в настройках.
 *
 * Читает тот же источник, что обводки плиток (`media/levels.ts`): дорожку, которую слышит
 * комната, вместе с обработкой перед ней. Раньше здесь был свой `AudioContext` и опрос раз в
 * 100 мс — второй анализатор той же дорожки, который к тому же отставал от рамки на плитке.
 * Микрофон выключен — шкала стоит на нуле.
 */
export function useMicLevel(meeting?: Meeting | null): number {
  return Math.round(useVoiceLevel(meeting, meeting?.admission.participantId) * 100);
}
