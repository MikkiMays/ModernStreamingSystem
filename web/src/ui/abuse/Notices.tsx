import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldAlert, TimerOff } from 'lucide-react';
import type { Attachment, Snapshot } from '../../api/types';
import { locale } from '../../i18n';
import './notices.css';

/* Предупреждения антибота во встрече (E11-B). Тексты — в каталоге: `meeting.ceiling`, `chat.executable`. */

/** Когда встреча завершится по потолку длительности, или `null`, пока ядро об этом не сказало. */
export function readEndsAt(snapshot: Snapshot): number | null {
  const value = (snapshot as Snapshot & { endsAt?: number | null }).endsAt;
  return typeof value === 'number' ? value : null;
}

/**
 * Плашка «Встреча завершится в 14:30» (A2 модели угроз). Ядро присылает `endsAt` за
 * `stream.meeting.warn-before` до конца; время показывается по часам этого устройства с поправкой на
 * часы сервера.
 */
export function MeetingEnds({ snapshot }: { snapshot: Snapshot }) {
  const { t } = useTranslation();
  const endsAt = readEndsAt(snapshot);
  const time = useMemo(
    () =>
      endsAt === null
        ? ''
        : new Date(Date.now() + endsAt - snapshot.serverTime).toLocaleTimeString(locale(t), {
            hour: '2-digit',
            minute: '2-digit',
          }),
    [endsAt, snapshot.serverTime, t],
  );
  if (endsAt === null) return null;
  return (
    <p className="abuse-notice" role="status">
      <TimerOff size={14} aria-hidden="true" />
      {t(($) => $.meeting.ceiling, { time })}
    </p>
  );
}

/** Помечен ли файл ядром как способный запустить программу (`Attachment.executable`). */
export function isExecutable(file: Attachment): boolean {
  return (file as Attachment & { executable?: boolean }).executable === true;
}

/** Предупреждение у файла, который может запустить программу (A7 модели угроз). */
export function ExecutableNote({ file }: { file: Attachment }) {
  const { t } = useTranslation();
  if (!isExecutable(file)) return null;
  return (
    <small className="abuse-notice" role="note">
      <ShieldAlert size={13} aria-hidden="true" />
      {t(($) => $.chat.executable)}
    </small>
  );
}
