import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Clapperboard, ShieldAlert, TimerOff } from 'lucide-react';
import type { Attachment, Snapshot } from '../../api/types';
import { locale } from '../../i18n';
import './notices.css';

/* Предупреждения антибота во встрече (E11-B). Тексты — в каталоге: `meeting.ceiling`, `meeting.cinema*`, `chat.executable`. */

/** Когда встреча завершится по потолку длительности, или `null`, пока ядро об этом не сказало. */
export function readEndsAt(snapshot: Snapshot): number | null {
  const value = (snapshot as Snapshot & { endsAt?: number | null }).endsAt;
  return typeof value === 'number' ? value : null;
}

/**
 * Плашка «до 14:30» — встреча завершится в это время (A2 модели угроз). Ядро присылает `endsAt` за
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
  // В шапке — коротко (R27): «до 23:00»; почему — в подсказке и для диктора.
  const full = t(($) => $.meeting.ceiling, { time });
  return (
    <p className="abuse-notice" role="status" title={full} aria-label={full}>
      <TimerOff size={12} aria-hidden="true" />
      {t(($) => $.meeting.ceilingShort, { time })}
    </p>
  );
}

/** Какую долю потолка трафика кинозала встреча выбрала (`Snapshot.cinemaTraffic`, %), или `null`. */
export function readCinemaTraffic(snapshot: Snapshot): number | null {
  const value = (snapshot as Snapshot & { cinemaTraffic?: number | null }).cinemaTraffic;
  return typeof value === 'number' ? value : null;
}

/**
 * Плашка о трафике кинозала (A8 модели угроз): служба кинозала сообщает ядру порог предупреждения
 * (`CINEMA_TRAFFIC_WARN_AT`, 80 %) и сам потолок; на потолке кино в этой встрече остановлено до её конца.
 */
export function CinemaTraffic({ snapshot }: { snapshot: Snapshot }) {
  const { t } = useTranslation();
  const percent = readCinemaTraffic(snapshot);
  if (percent === null) return null;
  const stopped = percent >= 100;
  const full = stopped ? t(($) => $.meeting.cinemaStopped) : t(($) => $.meeting.cinemaTraffic, { percent });
  return (
    <p className="abuse-notice" role="status" title={full} aria-label={full}>
      <Clapperboard size={12} aria-hidden="true" />
      {stopped ? t(($) => $.meeting.cinemaStoppedShort) : t(($) => $.meeting.cinemaTrafficShort, { percent })}
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
      <ShieldAlert size={12} aria-hidden="true" />
      {t(($) => $.chat.executable)}
    </small>
  );
}
