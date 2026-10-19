import { useEffect, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import type { Admission } from '../../api/types';
import { requestHandover, watchActiveMeetings, type ActiveMeeting } from '../../core/active-meeting';
import { formatCode } from '../../core/invitation';
import { Button } from '../kit';

const TEXT = {
  title: 'Вы во встрече в другой вкладке',
  back: 'Вернуться',
  backLabel: (title: string) => `Вернуться во встречу «${title}» здесь`,
  moving: 'Переносим…',
};

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <section className="home-here" aria-label={TEXT.title}>
      <span className="home-here__pulse" aria-hidden="true" />
      <div className="home-here__text">
        <p className="home-here__lead">{TEXT.title}</p>
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
        aria-label={TEXT.backLabel(meeting.title)}
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
        {busy ? TEXT.moving : TEXT.back}
      </Button>
    </section>
  );
}
