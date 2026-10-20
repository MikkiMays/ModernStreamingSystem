import { useEffect, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Admission } from '../../api/types';
import { requestHandover, watchActiveMeetings, type ActiveMeeting } from '../../core/active-meeting';
import { formatCode } from '../../core/invitation';
import { Button } from '../kit';

/** Встречи соседних вкладок этого браузера; переспрашиваются, когда страница снова на виду. */
export function useActiveMeetings() {
  const [meetings, setMeetings] = useState<ActiveMeeting[]>([]);
  useEffect(() => {
    const watcher = watchActiveMeetings(setMeetings);
    const again = () => {
      if (!document.hidden) watcher.refresh();
    };
    document.addEventListener('visibilitychange', again);
    window.addEventListener('focus', again);
    return () => {
      document.removeEventListener('visibilitychange', again);
      window.removeEventListener('focus', again);
      watcher.close();
    };
  }, []);
  return meetings;
}

/**
 * «Вы здесь» на главной (T52): встреча уже идёт в соседней вкладке, и вернуться в неё можно отсюда
 * же — разговор переносится в эту вкладку тем же участником, а та вкладка его отпускает.
 */
export function ActiveMeetingNotice({
  meeting,
  onResume,
}: {
  meeting: ActiveMeeting;
  onResume: (admission: Admission) => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <section className="home-here" aria-label={t(($) => $.home.here.title)}>
      <span className="home-here__pulse" aria-hidden="true" />
      <div className="home-here__text">
        <p className="home-here__lead">{t(($) => $.home.here.title)}</p>
        <p className="home-here__title">
          <strong>{meeting.title}</strong>
          {meeting.code && <span className="home-here__code">{formatCode(meeting.code)}</span>}
        </p>
        {error && (
          <p className="home-here__error" role="alert">
            {error}
          </p>
        )}
      </div>
      <Button
        variant="primary"
        icon={<ArrowRight size={16} />}
        loading={busy}
        aria-label={t(($) => $.home.here.backLabel, { title: meeting.title })}
        onClick={async () => {
          setBusy(true);
          setError('');
          try {
            onResume(await requestHandover(meeting));
          } catch (problem) {
            setError((problem as Error).message);
            setBusy(false);
          }
        }}
      >
        {busy ? t(($) => $.home.here.moving) : t(($) => $.home.here.back)}
      </Button>
    </section>
  );
}
