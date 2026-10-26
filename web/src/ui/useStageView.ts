import type { Meeting } from '../core/meeting';
import { knownProvider } from '../core/cinema/link';
import { stageOccupant, stageView, type StageOccupant, type StageView } from '../core/stage-view';
import { useStore } from './primitives';

/**
 * Что занимает сцену и что из этого видит этот зритель (R121) — для тех, кто стоит рядом со сценой:
 * чёлки, слоя интеграций, клавиши выхода. Правила — `core/stage-view.ts`, уход хранит встреча.
 */
export function useStageView(meeting: Meeting): { occupant: StageOccupant | null; view: StageView } {
  const snapshot = useStore(meeting.snapshot);
  const catalog = useStore(meeting.cinema);
  const away = useStore(meeting.stageAway);
  const viewing = useStore(meeting.viewing);
  const occupant = stageOccupant(snapshot, !!catalog && knownProvider(catalog));
  return { occupant, view: stageView(occupant, away, !!viewing) };
}
