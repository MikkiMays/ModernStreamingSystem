import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import type { Watch } from '../../../api/types';
import type { Meeting } from '../../../core/meeting';
import { catchUp, correction, finished, targetPosition, type CatchUp } from '../../../core/watch';
import type { Playback } from './engines/playback';
import { contentOf, type Status } from './useSource';
import { skipTarget } from './watch-controls';

/**
 * Своё эхо отличается окном тишины после каждой своей же команды плееру: без него пауза,
 * поставленная по приказу комнаты, улетала бы в комнату как новое нажатие.
 */
export const SUPPRESS_MS = 1200;
/**
 * Насколько можно отстать от края живого эфира, прежде чем это стоит исправить прыжком.
 *
 * У эфира нет общей позиции, но есть край, и отстать от него можно надолго: одна затычка в
 * сети, и буфер растёт, а картинка едет с задержкой в полминуты — это и есть жалоба «звук
 * отстаёт на стриме», только отстаёт не звук от картинки, а всё вместе от эфира. Раз в секунду
 * сравниваем себя с краем и возвращаемся, если отстали слишком сильно; кнопка «LIVE» делает то
 * же самое по просьбе.
 */
const LIVE_LAG = 12;

/** Окно тишины после своей же команды плееру (см. {@link SUPPRESS_MS}). */
export interface Echo {
  /** Своя команда плееру: ближайшие {@link SUPPRESS_MS} его события — наше эхо, а не человек. */
  suppress(): void;
  /** Идёт ли окно тишины прямо сейчас. */
  quiet(): boolean;
}

function createEcho(): Echo {
  let until = 0;
  return {
    suppress() {
      until = Date.now() + SUPPRESS_MS;
    },
    quiet() {
      return Date.now() < until;
    },
  };
}

/**
 * Окно тишины на весь плеер — одно на всех, кто командует `<video>`: и синхронизацию, и смену
 * источника, и сам движок.
 */
export function useEcho(): Echo {
  const [echo] = useState(createEcho);
  return echo;
}

type WatchCommand = 'watch.play' | 'watch.pause' | 'watch.seek';

/**
 * Свой плеер и комната: раз в секунду — где мы, где комната и что из этого следует.
 *
 * Отсюда же уходят в комнату нажатия пульта ({@link command}), и здесь же видно, чьё событие
 * пришло от `<video>`: человека (его надо разослать) или наше эхо (его надо промолчать).
 */
export function useRoomSync({
  meeting,
  watch,
  live,
  canControl,
  video,
  playback,
  echo,
  wake,
  setStatus,
}: {
  meeting: Meeting;
  watch: Watch;
  live: boolean;
  canControl: boolean;
  video: RefObject<HTMLVideoElement | null>;
  playback: RefObject<Playback | null>;
  echo: Echo;
  /** Разбудить пульт: нажатие пультом — это и движение мыши. */
  wake: () => void;
  setStatus: Dispatch<SetStateAction<Status>>;
}) {
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [drift, setDrift] = useState(0);
  const [lag, setLag] = useState(0);
  const sending = useRef(false);
  const started = useRef(false);
  const nudge = useRef<CatchUp | null>(null);
  const latest = useRef({ watch, canControl, live });
  latest.current = { watch, canControl, live };

  const send = useCallback(
    (type: 'watch.play' | 'watch.pause' | 'watch.seek' | 'watch.close', positionMs?: number) => {
      if (sending.current) return;
      sending.current = true;
      void meeting
        .command(type, undefined, undefined, positionMs === undefined ? undefined : { positionMs })
        .catch((e) => meeting.media.report(e))
        .finally(() => {
          sending.current = false;
        });
    },
    [meeting],
  );

  // Другое видео — и расхождение, и отставание, и «открывший уже включил» начинаются заново.
  const content = contentOf(watch);
  useEffect(() => {
    setDrift(0);
    setLag(0);
    started.current = false;
    nudge.current = null;
  }, [meeting, content]);

  // Раз в секунду: где мы, где комната, и что из этого следует.
  useEffect(() => {
    const timer = setInterval(() => {
      const element = video.current;
      const now = latest.current.watch;
      if (!element) return;
      const serverNow = meeting.serverNow();
      const ranges = element.buffered;
      setBuffered(ranges.length ? ranges.end(ranges.length - 1) * 1000 : 0);
      /*
        Полоса и отставание — только у произведения с началом и концом. У эфира ни общей
        позиции, ни конца нет; у него считается другое — насколько мы отстали от края.
      */
      if (!latest.current.live) {
        const here = element.currentTime * 1000;
        setPosition(here);
        setDuration(Number.isFinite(element.duration) ? element.duration * 1000 : 0);
        const over = finished({ watch: now, serverNow, localMs: here, ended: element.ended });
        setDrift(now.paused || over ? 0 : here - targetPosition(now, serverNow));
        setLag(0);
      } else {
        setDrift(0);
        const edge = playback.current?.liveSyncPosition;
        const known = edge !== undefined && edge !== null && Number.isFinite(edge);
        const behind = known ? edge - element.currentTime : 0;
        setLag(Math.max(0, behind));
        // Отстали настолько, что это уже не эфир: возвращаемся к краю сами, не спрашивая.
        if (known && behind > LIVE_LAG && element.readyState >= 2 && !element.paused) {
          echo.suppress();
          element.currentTime = edge;
        }
      }
      if (echo.quiet() || element.readyState < 2) return;
      const localMs = element.currentTime * 1000;
      const playing = !element.paused && !element.ended;
      // Подтяжка под присмотром (`catchUp`): её окно помнится между проверками, а не в плеере, и
      // меряется монотонными часами — перевод своих часов назад растянул бы его на весь перевод.
      const watched = catchUp(nudge.current, {
        now: performance.now(),
        driftMs: localMs - targetPosition(now, serverNow),
        nudging: !latest.current.live && !now.paused && playing && element.playbackRate !== 1,
      });
      nudge.current = watched.next;
      const fix = correction({
        watch: now,
        live: latest.current.live,
        serverNow,
        localMs,
        playing,
        ended: element.ended,
        rate: element.playbackRate,
        stalled: watched.stalled,
      });
      if (fix.action === 'none') return;
      // Подтяжка скоростью — не команда плееру, а наклон: своё эхо от неё не рождается, и
      // глушить проверку на секунду из-за неё было бы ошибкой (за секунду она и не успеет).
      if (fix.action === 'rate') {
        element.playbackRate = fix.rate;
        return;
      }
      echo.suppress();
      if (fix.action === 'play') {
        if (fix.positionMs !== undefined) {
          element.playbackRate = 1;
          element.currentTime = fix.positionMs / 1000;
        }
        void element.play().catch(() => setStatus((current) => (current === 'ready' ? 'blocked' : current)));
      }
      if (fix.action === 'pause') {
        element.pause();
        element.playbackRate = 1;
        element.currentTime = fix.positionMs / 1000;
      }
      if (fix.action === 'seek') {
        element.playbackRate = 1;
        element.currentTime = fix.positionMs / 1000;
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [meeting, video, playback, echo, setStatus]);

  /** Нажатие пультом: сначала комнате, а плеер догонит себя сам ближайшей проверкой. */
  const command = (type: WatchCommand, positionMs?: number) => {
    if (!canControl) return;
    wake();
    echo.suppress();
    const element = video.current;
    // «Включить» у досмотренного — это «ещё раз с начала»: так понимает `play()` сам браузер, и
    // комната должна услышать то же самое, а не «играй с последнего кадра».
    const again = type === 'watch.play' && positionMs === undefined && !!element?.ended;
    const at = again
      ? 0
      : (positionMs ??
        Math.round(element ? element.currentTime * 1000 : targetPosition(watch, meeting.serverNow())));
    if (element) element.playbackRate = 1;
    if ((type === 'watch.seek' || again) && element) element.currentTime = at / 1000;
    if (type === 'watch.play') void element?.play().catch(() => {});
    if (type === 'watch.pause') element?.pause();
    send(type, Math.max(0, at));
  };

  /** Отмотать всем на пятнадцать секунд назад или вперёд — не дальше начала и конца. */
  const skip = (delta: number) => {
    const element = video.current;
    const at = element ? element.currentTime * 1000 : targetPosition(watch, meeting.serverNow());
    command('watch.seek', skipTarget(at, delta, duration));
  };

  /**
   * Вернуться туда, где комната, — или к краю эфира.
   *
   * Своё действие, а не команда: комнату оно не двигает. Автоматика делает это сама, но
   * «сама» — это через секунду и незаметно, а кнопка нужна тогда, когда человек уже видит,
   * что отстал, и ждать не хочет.
   */
  const resync = () => {
    const element = video.current;
    if (!element) return;
    wake();
    // Досмотрели вместе с комнатой — уже на её секунде; `play()` здесь начал бы ролик заново.
    const over = finished({
      watch: latest.current.watch,
      serverNow: meeting.serverNow(),
      localMs: element.currentTime * 1000,
      ended: element.ended,
    });
    if (!live && over) return;
    echo.suppress();
    element.playbackRate = 1;
    if (live) {
      const edge = playback.current?.liveSyncPosition;
      if (edge !== undefined && edge !== null && Number.isFinite(edge)) element.currentTime = edge;
      else playback.current?.reload?.();
      setLag(0);
    } else {
      element.currentTime = targetPosition(latest.current.watch, meeting.serverNow()) / 1000;
      setDrift(0);
    }
    if (!element.paused) return;
    if (live || !latest.current.watch.paused) void element.play().catch(() => {});
  };

  /** `<video>` заиграл: если это не наше эхо и комната стоит — значит, включил человек. */
  const played = () => {
    if (echo.quiet() || !latest.current.canControl) return;
    if (latest.current.watch.paused && !latest.current.live) command('watch.play');
  };

  /** `<video>` встал: если это не наше эхо и не конец ролика — значит, остановил человек. */
  const paused = () => {
    if (echo.quiet() || !latest.current.canControl) return;
    if (latest.current.live || video.current?.ended) return;
    if (!latest.current.watch.paused) command('watch.pause');
  };

  /** Метаданные приехали: встать туда, где комната, а открывшему — включить. */
  const loaded = () => {
    const element = video.current;
    if (!element) return;
    setDuration(Number.isFinite(element.duration) ? element.duration * 1000 : 0);
    if (!latest.current.live) {
      echo.suppress();
      element.currentTime = targetPosition(latest.current.watch, meeting.serverNow()) / 1000;
    }
    // Открывший включает, как только его плеер готов: состояние уже у всех, а
    // отставших подтянет обычная проверка расхождения.
    const now = latest.current.watch;
    if (
      !started.current &&
      now.paused &&
      now.positionMs === 0 &&
      now.openedBy === meeting.admission.participantId
    ) {
      started.current = true;
      setTimeout(() => command('watch.play', 0), 500);
    }
  };

  return { position, duration, buffered, drift, lag, send, command, skip, resync, played, paused, loaded };
}
