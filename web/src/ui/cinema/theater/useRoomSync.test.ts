import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Watch } from '../../../api/types';
import type { Meeting } from '../../../core/meeting';
import type { Playback } from './engines/playback';
import { SUPPRESS_MS, useEcho, useRoomSync } from './useRoomSync';
import type { Status } from './useSource';

const T0 = 1_790_000_000_000;

const watch = (patch: Partial<Watch> = {}): Watch => ({
  provider: 'youtube',
  kind: 'video',
  contentId: 'dQw4w9WgXcQ',
  title: null,
  openedBy: 'someone',
  paused: false,
  positionMs: 60_000,
  anchorAt: T0,
  revision: 1,
  ...patch,
});

/** `<video>` без медиа: только то, что читает и пишет синхронизация. */
function element(patch: Partial<Record<string, unknown>> = {}) {
  const video = {
    currentTime: 0,
    duration: 212,
    paused: false,
    ended: false,
    readyState: 4,
    playbackRate: 1,
    buffered: { length: 1, end: () => 90 },
    play: vi.fn(() => {
      video.paused = false;
      return Promise.resolve();
    }),
    pause: vi.fn(() => {
      video.paused = true;
    }),
    ...patch,
  };
  return video;
}

function room() {
  return {
    serverNow: () => Date.now(),
    command: vi.fn(() => Promise.resolve()),
    media: { report: vi.fn() },
    admission: { participantId: 'me' },
  };
}

type Props = { watch: Watch; live: boolean; canControl: boolean };

function setup(video = element(), initial: Partial<Props> = {}, edge?: Partial<Playback>) {
  const meeting = room();
  const playback = { current: (edge ?? null) as Playback | null };
  const wake = vi.fn();
  const setStatus = vi.fn();
  const hook = renderHook(
    (props: Props) => {
      const echo = useEcho();
      return {
        echo,
        sync: useRoomSync({
          ...props,
          meeting: meeting as unknown as Meeting,
          video: { current: video as unknown as HTMLVideoElement },
          playback,
          echo,
          wake,
          setStatus,
        }),
      };
    },
    { initialProps: { watch: watch(), live: false, canControl: true, ...initial } },
  );
  return { hook, video, meeting, playback, wake, setStatus };
}

/** Проходит `ms` миллисекунд — с тиками синхронизации, если они выпадают на этот отрезок. */
const pass = (ms: number) =>
  act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  });

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useRoomSync: свой плеер догоняет комнату раз в секунду', () => {
  it('отстали дальше 2,5 с — перемотка с упреждением, и 1200 мс после неё своё эхо не трогают', async () => {
    const { hook, video } = setup(element({ currentTime: 50 }));
    await pass(1000);
    // Цель — 61 000 мс, догоняем с запасом в 400 мс: пока перемотка доедет, уйдёт ещё столько же.
    expect(video.currentTime).toBeCloseTo(61.4, 6);
    expect(video.playbackRate).toBe(1);
    expect(hook.result.current.sync.drift).toBe(-11_000);
    expect(hook.result.current.sync.position).toBe(50_000);
    expect(hook.result.current.sync.buffered).toBe(90_000);
    expect(hook.result.current.echo.quiet()).toBe(true);

    video.currentTime = 50;
    await pass(1000);
    // Окно ещё идёт (перемотка была 1000 мс назад, окно — SUPPRESS_MS): это наше эхо, не трогаем.
    expect(SUPPRESS_MS).toBe(1200);
    expect(video.currentTime).toBe(50);

    await pass(1000);
    expect(video.currentTime).toBeCloseTo(63.4, 6);
  });

  it('разошлись меньше чем на 2,5 с — подтяжка скоростью, и окна тишины после неё нет', async () => {
    const { hook, video } = setup(element({ currentTime: 60 }));
    await pass(1000);
    // Цель 61 000, мы на 60 000: отстаём на секунду — чуть быстрее.
    expect(video.playbackRate).toBe(1.05);
    expect(hook.result.current.echo.quiet()).toBe(false);

    // Через секунду уже далеко позади — и перемотка случается сразу, без ожидания окна.
    video.currentTime = 40;
    await pass(1000);
    expect(video.currentTime).toBeCloseTo(62.4, 6);
    expect(video.playbackRate).toBe(1);

    // После перемотки окно тишины: тик через секунду молчит, следующий видит, что мы впереди на
    // секунду (цель 64 000, мы на 65 000), — и чуть притормаживает.
    video.currentTime = 65;
    await pass(1000);
    expect(video.playbackRate).toBe(1);
    await pass(1000);
    expect(video.playbackRate).toBe(0.95);
  });

  it('комната играет, а мы стоим — play; браузер не дал — «Смотреть вместе» вместо пульта', async () => {
    const { video, setStatus } = setup(element({ currentTime: 61, paused: true }));
    await pass(1000);
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(setStatus).not.toHaveBeenCalled();

    video.paused = true;
    video.play.mockImplementationOnce(() => Promise.reject(new Error('NotAllowedError')));
    await pass(2000);
    expect(video.play).toHaveBeenCalledTimes(2);
    const update = setStatus.mock.calls[0]![0] as (current: Status) => Status;
    expect(update('ready')).toBe('blocked');
    expect(update('loading')).toBe('loading');
  });

  it('комната на паузе, а мы играем — пауза ровно в её секунде', async () => {
    const { hook, video } = setup(element({ currentTime: 29, playbackRate: 1.05 }), {
      watch: watch({ paused: true, positionMs: 30_000 }),
    });
    await pass(1000);
    expect(video.pause).toHaveBeenCalledTimes(1);
    expect(video.playbackRate).toBe(1);
    expect(video.currentTime).toBe(30);
    // На паузе расхождение не показывают: догонять нечего, пока никто не играет.
    expect(hook.result.current.sync.drift).toBe(0);
  });

  it('пока `<video>` не готов, его не двигают', async () => {
    const { video } = setup(element({ currentTime: 5, readyState: 1 }));
    await pass(3000);
    expect(video.currentTime).toBe(5);
    expect(video.play).not.toHaveBeenCalled();
  });

  it('своё эхо в комнату не уходит, а нажатие человека — уходит', async () => {
    const { hook, meeting } = setup(element({ currentTime: 30, paused: true }), {
      watch: watch({ paused: true, positionMs: 30_000 }),
    });
    act(() => hook.result.current.echo.suppress());
    hook.result.current.sync.played();
    expect(meeting.command).not.toHaveBeenCalled();

    await pass(SUPPRESS_MS);
    act(() => hook.result.current.sync.played());
    expect(meeting.command).toHaveBeenCalledWith('watch.play', undefined, undefined, { positionMs: 30_000 });
  });

  it('остановку человека рассылает, а конец ролика, эфир и чужие руки — нет', async () => {
    const video = element({ currentTime: 61 });
    const { hook, meeting } = setup(video);
    act(() => hook.result.current.sync.paused());
    expect(meeting.command).toHaveBeenLastCalledWith('watch.pause', undefined, undefined, {
      positionMs: 61_000,
    });
    await pass(SUPPRESS_MS);
    meeting.command.mockClear();
    video.ended = true;
    act(() => hook.result.current.sync.paused());
    video.ended = false;
    hook.rerender({ watch: watch(), live: true, canControl: true });
    act(() => hook.result.current.sync.paused());
    hook.rerender({ watch: watch(), live: false, canControl: false });
    act(() => hook.result.current.sync.paused());
    expect(meeting.command).not.toHaveBeenCalled();
  });

  it('эфир: отставание от края видно числом, а дальше двенадцати секунд — прыжок к краю', async () => {
    const edge = { liveSyncPosition: 100 } as Partial<Playback>;
    const { hook, video } = setup(
      element({ currentTime: 95 }),
      { live: true, watch: watch({ kind: 'channel' }) },
      edge,
    );
    await pass(1000);
    expect(hook.result.current.sync.lag).toBe(5);
    expect(video.currentTime).toBe(95);

    video.currentTime = 80;
    await pass(1000);
    expect(hook.result.current.sync.lag).toBe(20);
    expect(video.currentTime).toBe(100);
    expect(hook.result.current.echo.quiet()).toBe(true);
  });

  it('«встать на секунду комнаты»: запись — к цели, эфир — к краю или заново с края', async () => {
    const video = element({ currentTime: 10, paused: true });
    const { hook } = setup(video);
    act(() => hook.result.current.sync.resync());
    expect(video.currentTime).toBe(60);
    expect(video.play).toHaveBeenCalledTimes(1);

    const reload = vi.fn();
    const live = setup(element({ currentTime: 10 }), { live: true }, { reload } as Partial<Playback>);
    act(() => live.hook.result.current.sync.resync());
    expect(reload).toHaveBeenCalledOnce();
    live.playback.current = { liveSyncPosition: 42 } as Playback;
    act(() => live.hook.result.current.sync.resync());
    expect(live.video.currentTime).toBe(42);
  });

  it('нажатие пультом: сначала комнате, одно за раз, и только у кого есть право', async () => {
    const video = element({ currentTime: 61 });
    const { hook, meeting, wake } = setup(video);
    act(() => hook.result.current.sync.command('watch.seek', 5000));
    expect(video.currentTime).toBe(5);
    expect(wake).toHaveBeenCalled();
    expect(meeting.command).toHaveBeenCalledWith('watch.seek', undefined, undefined, { positionMs: 5000 });
    // Пока первая команда в пути, вторая не уходит.
    act(() => hook.result.current.sync.command('watch.pause'));
    expect(meeting.command).toHaveBeenCalledTimes(1);
    await act(async () => {});
    act(() => hook.result.current.sync.skip(-15000));
    expect(meeting.command).toHaveBeenLastCalledWith('watch.seek', undefined, undefined, { positionMs: 0 });

    const guest = setup(element(), { canControl: false });
    act(() => guest.hook.result.current.sync.command('watch.play'));
    expect(guest.meeting.command).not.toHaveBeenCalled();
  });

  it('метаданные: встать туда, где комната, а открывшему — включить через полсекунды, один раз на видео', async () => {
    const video = element({ currentTime: 0, paused: true });
    const opened = watch({ paused: true, positionMs: 0, openedBy: 'me' });
    const { hook, meeting } = setup(video, { watch: opened });
    act(() => hook.result.current.sync.loaded());
    expect(hook.result.current.sync.duration).toBe(212_000);
    await pass(499);
    expect(meeting.command).not.toHaveBeenCalled();
    await pass(1);
    expect(meeting.command).toHaveBeenCalledWith('watch.play', undefined, undefined, { positionMs: 0 });

    await act(async () => {});
    act(() => hook.result.current.sync.loaded());
    await pass(600);
    expect(meeting.command).toHaveBeenCalledTimes(1);

    // Другое видео — снова «открывший включает», и расхождение начинается с нуля.
    hook.rerender({ watch: { ...opened, contentId: 'aqz-KE-bpKQ' }, live: false, canControl: true });
    act(() => hook.result.current.sync.loaded());
    await pass(500);
    expect(meeting.command).toHaveBeenCalledTimes(2);
  });
});
