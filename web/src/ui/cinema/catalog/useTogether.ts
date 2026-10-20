import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CinemaItem } from '../../../core/cinema';
import type { Meeting } from '../../../core/meeting';
import { allowed } from '../../../core/permissions';
import { useStore } from '../../primitives';
import { problemText } from './notes';

/**
 * «Смотреть вместе» — единственное в каталоге, что касается всей комнаты.
 *
 * Всё остальное здесь личное: листать можно сколько угодно, никому не мешая. А это обычная
 * команда комнате — и потому её можно не иметь права послать (`canUse`), её ждут (`busy` — id
 * карточки, которую включают) и она может не пройти (`error`).
 */
export function useTogether(meeting: Meeting) {
  const { t } = useTranslation();
  const snapshot = useStore(meeting.snapshot);
  const canUse = allowed(snapshot, meeting.admission.participantId, 'watch.open');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const open = async (item: CinemaItem) => {
    if (!canUse) return;
    // Вид считается до `try`: условное выражение внутри `try` React Compiler тоже не берёт.
    const kind = item.kind === 'channel' ? 'channel' : 'video';
    setBusy(item.id);
    setError('');
    try {
      await meeting.command('watch.open', item.title, undefined, {
        provider: item.provider,
        kind,
        contentId: item.id,
      });
      // Включили — значит, смотреть, а не листать дальше: каталог уходит, зал остаётся.
      meeting.openCinema(null);
    } catch (e) {
      setError(problemText(t, e));
    }
    // Не `finally`: блок с ним React Compiler не берёт и оставляет хук без памяти — тогда `open`
    // новая на каждом рендере, и вслед за ней заново строятся все плитки сетки. `catch` выше
    // ловит всё, так что сюда доходят оба исхода — ровно как было с `finally`.
    setBusy('');
  };
  return { canUse, busy, error, open };
}
