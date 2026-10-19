import { useEffect, useRef } from 'react';
import { announceMeeting } from '../core/active-meeting';
import type { Meeting } from '../core/meeting';

/**
 * Эта вкладка во встрече — пусть соседние знают (T52, `core/active-meeting.ts`).
 *
 * Объявление живёт, пока встреча не кончилась; название и код обновляются, только когда меняются, —
 * снимок приходит на каждое изменение комнаты, и пересылать его соседям каждый раз незачем. Если
 * соседняя вкладка забрала встречу себе, `onHandedOver` закрывает разговор здесь — без выхода.
 */
export function useMeetingBeacon(meeting: Meeting | null, onHandedOver: () => void) {
  const handedOver = useRef(onHandedOver);
  useEffect(() => {
    handedOver.current = onHandedOver;
  });
  useEffect(() => {
    if (!meeting) return;
    let beacon: ReturnType<typeof announceMeeting> | null = null;
    let last = '';
    const info = () => {
      const snapshot = meeting.snapshot.get();
      return { roomId: meeting.admission.roomId, title: snapshot.title, code: snapshot.code };
    };
    const sync = () => {
      const live = !meeting.ended.get();
      const next = info();
      const key = `${next.title}\n${next.code}`;
      if (live && !beacon) {
        last = key;
        beacon = announceMeeting(next, {
          admission: () => ({ ...meeting.admission, snapshot: meeting.snapshot.get() }),
          onHandedOver: () => {
            beacon = null;
            handedOver.current();
          },
        });
      } else if (!live && beacon) {
        beacon.stop();
        beacon = null;
      } else if (beacon && key !== last) {
        last = key;
        beacon.update(next);
      }
    };
    sync();
    const unsubscribe = [meeting.snapshot.subscribe(sync), meeting.ended.subscribe(sync)];
    return () => {
      unsubscribe.forEach((off) => off());
      beacon?.stop();
    };
  }, [meeting]);
}
