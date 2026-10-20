import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { Meeting } from '../core/meeting';
import { SystemControls } from '../media/system-controls';
import { callEnded, callStarted, isMobileApp, onAppCommand } from '../core/mobile-app';

/**
 * Разговор, видимый системе (E12, T16): кнопки Media Session и уведомление приложения Cord.
 *
 * Живёт, пока открыт экран встречи. Нажатия снаружи — кнопка «Завершить» в окне PiP настольного
 * Chrome, микрофон из интерфейса Safari, «Завершить» в уведомлении приложения — идут теми же путями,
 * что кнопки пульта: `onLeave` — тот же выход, что у красной кнопки.
 */
export function useCallInBackground(meeting: Meeting, onLeave: () => void) {
  const { t } = useTranslation();
  const leave = useRef(onLeave);
  useEffect(() => {
    leave.current = onLeave;
  });

  useEffect(() => {
    const media = meeting.media;
    const live = () => !meeting.ended.get() && media.state.get().status === 'connected';
    const controls = new SystemControls({
      microphone: () => {
        if (live()) void media.toggle('microphone');
      },
      camera: () => {
        if (live()) void media.toggle('camera');
      },
      hangup: () => {
        if (!meeting.ended.get()) leave.current();
      },
      pictureInPicture: () => {
        media.pip.enter();
      },
    });
    let title = '';
    const sync = () => {
      const next = meeting.snapshot.get().title || t(($) => $.media.background.untitled);
      if (next !== title) {
        title = next;
        controls.describe({
          title,
          artist: t(($) => $.media.background.artist),
          artwork: [{ src: '/icon-512.png', sizes: '512x512', type: 'image/png' }],
        });
      }
      const state = media.state.get();
      controls.reflect({ microphone: state.microphone, camera: state.camera });
    };
    sync();
    const stops = [meeting.snapshot.subscribe(sync), media.state.subscribe(sync)];
    return () => {
      stops.forEach((stop) => stop());
      controls.dispose();
    };
  }, [meeting, t]);

  // Приложение Cord: уведомление «Идёт разговор» и foreground service на всё время встречи.
  useEffect(() => {
    if (!isMobileApp()) return;
    const media = meeting.media;
    let shown: string | null = null;
    const sync = () => {
      const status = media.state.get().status;
      const inCall = !meeting.ended.get() && (status === 'connected' || status === 'recovering');
      if (inCall) {
        const title = meeting.snapshot.get().title || t(($) => $.media.background.untitled);
        const microphone = media.state.get().microphone;
        const key = `${title}\n${microphone}`;
        if (key !== shown) {
          shown = key;
          void callStarted({ title, microphone });
        }
      } else if (shown !== null) {
        shown = null;
        void callEnded();
      }
    };
    sync();
    const stops = [
      meeting.snapshot.subscribe(sync),
      media.state.subscribe(sync),
      meeting.ended.subscribe(sync),
      onAppCommand((command) => {
        if (command === 'hangup' && !meeting.ended.get()) leave.current();
        if (command === 'microphone' && !meeting.ended.get() && media.state.get().status === 'connected')
          void media.toggle('microphone');
      }),
    ];
    return () => {
      stops.forEach((stop) => stop());
      if (shown !== null) void callEnded();
    };
  }, [meeting, t]);
}
