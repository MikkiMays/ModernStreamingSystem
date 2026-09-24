import { useState } from 'react';
import type { CinemaItem } from '../../../core/cinema';
import type { Meeting } from '../../../core/meeting';
import { useStore } from '../../primitives';

/**
 * «Смотреть вместе» — единственное в каталоге, что касается всей комнаты.
 *
 * Всё остальное здесь личное: листать можно сколько угодно, никому не мешая. А это обычная
 * команда комнате — и потому её можно не иметь права послать (`canUse`), её ждут (`busy` — id
 * карточки, которую включают) и она может не пройти (`error`).
 */
export function useTogether(meeting: Meeting) {
  const snapshot = useStore(meeting.snapshot);
  const self = snapshot.participants.find((p) => p.id === meeting.admission.participantId);
  const canUse = !!self && (self.owner || snapshot.integrationsAllowed !== false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const open = async (item: CinemaItem) => {
    if (!canUse) return;
    setBusy(item.id);
    setError('');
    try {
      await meeting.command('watch.open', item.title, undefined, {
        provider: item.provider,
        kind: item.kind === 'channel' ? 'channel' : 'video',
        contentId: item.id,
      });
      // Включили — значит, смотреть, а не листать дальше: каталог уходит, зал остаётся.
      meeting.openCinema(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  return { canUse, busy, error, open };
}
