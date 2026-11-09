import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Watch } from '../../../api/types';
import type { Meeting } from '../../../core/meeting';
import { JUMP_LIMIT, targetPosition } from '../../../core/watch';
import { Playhead, SAMPLE_MS } from './playhead';
import { useEcho, useRoomSync } from './useRoomSync';

/*
  Перемотка на +15 с у медленного плеера — целиком: настоящая синхронизация (`useRoomSync`), настоящий
  сторож позиции (`Playhead`), а плеер и комната — модели (R216, жалоба владельца с телевизора 09.11.2026).

  Плеер: данные на новое место за краем загруженного приходят через `resume` секунд (сеть, первый кусок,
  декодер), дальше кусочки по `segment` секунд — со скоростью `speed` реального времени. Комната: команда
  доходит до ядра за 100 мс, ядро ставит якорь на своё «сейчас».

  До R216 тот же сценарий у плеера, которому нужно 4 с на новое место, давал вечную погоню: перемотка
  вдогонку целилась на 0,4 с вперёд, плеер вставал туда через 4 с, комната уходила ещё на 4 с — 19 перемоток
  и 74 с ожидания из 90 (замер моделью из цикла `useRoomSync` до правки).
*/

const T0 = 1_790_000_000_000;
const STEP = 50;

interface Net {
  resume: number;
  speed: number;
  segment: number;
}

class Player {
  private t = 0;
  private from = 0;
  private to = 0;
  private pending: { at: number; ready: number } | null = null;
  paused = false;
  ended = false;
  seeking = false;
  muted = false;
  volume = 1;
  playbackRate = 1;
  duration = 3600;
  /** Сколько раз позицию двигал кто-то кроме человека. */
  moves = 0;
  stalled = 0;
  constructor(
    private readonly net: Net,
    private readonly playhead: Playhead,
    private readonly clock: () => number,
  ) {
    this.pending = { at: 0, ready: this.clock() + net.resume * 1000 };
  }
  get currentTime() {
    return this.t;
  }
  /** Что происходило с позицией и ожиданием — в текст отказа проверки. */
  log: string[] = [];
  private waiting: number | null = null;
  set currentTime(value: number) {
    const was = this.t;
    this.moves++;
    this.t = value;
    if (value < this.from || value >= this.to - 0.1) {
      this.from = Math.floor(value / this.net.segment) * this.net.segment;
      this.to = this.from;
      this.pending = { at: this.from, ready: this.clock() + this.net.resume * 1000 };
    }
    this.seeking = !this.ready;
    this.log.push(
      `${((this.clock() - T0) / 1000).toFixed(2)}s ${was.toFixed(1)}→${value.toFixed(1)} ${this.ready ? 'in' : 'out'}`,
    );
    this.playhead.seeking(performance.now(), this);
  }
  get ready() {
    return this.t >= this.from && this.to - this.t > 0.1;
  }
  get readyState() {
    return this.ready ? 4 : 1;
  }
  get buffered() {
    return { length: 1, start: () => this.from, end: () => this.to };
  }
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  advance(counting: boolean) {
    const now = this.clock();
    if (this.pending && now >= this.pending.ready) {
      this.to = this.pending.at + this.net.segment;
      this.pending = null;
    }
    if (!this.pending && this.to - this.t < 25)
      this.pending = { at: this.to, ready: now + (this.net.segment / this.net.speed) * 1000 };
    if (this.ready) {
      if (this.waiting !== null) this.log.push(`wait ${((now - this.waiting) / 1000).toFixed(2)}s`);
      this.waiting = null;
      this.seeking = false;
      if (!this.paused) this.t = Math.min(this.to, this.t + (STEP / 1000) * this.playbackRate);
    } else if (!this.paused) {
      this.waiting ??= now;
      if (counting) this.stalled += STEP;
    }
  }
}

function scenario(net: Net, options: { rateSafe: boolean; solo: boolean }) {
  const playhead = new Playhead();
  const player = new Player(net, playhead, () => Date.now());
  let watch: Watch = {
    provider: 'youtube',
    kind: 'video',
    contentId: 'aqz-KE-bpKQ',
    title: null,
    openedBy: 'me',
    paused: false,
    positionMs: 0,
    anchorAt: T0,
    revision: 1,
  };
  let counting = false;
  const commands: string[] = [];
  const meeting = {
    serverNow: () => Date.now(),
    command: vi.fn((type: string, _a: unknown, _b: unknown, payload?: { positionMs?: number }) => {
      commands.push(`${type} ${payload?.positionMs}`);
      setTimeout(() => {
        watch = {
          ...watch,
          positionMs: payload?.positionMs ?? targetPosition(watch, Date.now()),
          paused: type === 'watch.pause',
          anchorAt: Date.now(),
          revision: watch.revision + 1,
        };
        hook.rerender({ watch });
      }, 100);
      return Promise.resolve();
    }),
    media: { report: vi.fn() },
    admission: { participantId: 'me' },
  };
  const hook = renderHook(
    (props: { watch: Watch }) =>
      useRoomSync({
        meeting: meeting as unknown as Meeting,
        watch: props.watch,
        live: false,
        canControl: true,
        video: { current: player as unknown as HTMLVideoElement },
        playback: { current: null },
        echo: useEcho(),
        wake: () => {},
        setStatus: () => {},
        playhead,
        rateSafe: options.rateSafe,
        solo: options.solo,
      }),
    { initialProps: { watch } },
  );
  setInterval(() => player.advance(counting), STEP);
  setInterval(() => playhead.sample(performance.now(), player), SAMPLE_MS);
  return {
    player,
    commands,
    drift: () => player.currentTime * 1000 - targetPosition(watch, Date.now()),
    skip: async () => {
      counting = true;
      player.moves = 0;
      commands.length = 0;
      await act(async () => hook.result.current.skip(15_000));
    },
  };
}

/** Проходит `ms` — по четверти секунды за раз: каждая отрисовка комнаты успевает дойти до синхронизации. */
async function run(ms: number) {
  for (let left = ms; left > 0; left -= 250) {
    await act(async () => {
      vi.advanceTimersByTime(Math.min(250, left));
      await Promise.resolve();
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('перемотка +15 с у медленного плеера: без погони за комнатой (R216)', () => {
  // Телевизор: новое место — через 4 с, загрузка в 1,3 раза быстрее просмотра; скорость не честная.
  const tv = { resume: 4, speed: 1.3, segment: 5 };

  it('один у телевизора: одно ожидание, ни одной перемотки вдогонку — комната встаёт туда, где он', async () => {
    const room = scenario(tv, { rateSafe: false, solo: true });
    await run(30_000);
    await room.skip();
    await run(60_000);
    // Позицию двигала только сама перемотка человека.
    expect(room.player.moves, room.player.log.join(' | ')).toBe(1);
    expect(room.player.stalled, room.player.log.join(' | ')).toBeLessThanOrEqual(4_500);
    expect(room.commands.filter((command) => command.startsWith('watch.seek'))).toHaveLength(2);
    expect(Math.abs(room.drift())).toBeLessThan(JUMP_LIMIT);
  });

  it('телевизор в комнате с другими: перемотка вдогонку одна — с упреждением на своё ожидание', async () => {
    const room = scenario(tv, { rateSafe: false, solo: false });
    await run(30_000);
    await room.skip();
    await run(60_000);
    // Своя перемотка и не больше одной вдогонку (раньше — девятнадцать).
    expect(room.player.moves, room.player.log.join(' | ')).toBeLessThanOrEqual(2);
    // Комната медленного не ждёт и назад к нему не отскакивает: в неё ушла только его собственная перемотка.
    expect(room.commands).toEqual([expect.stringMatching(/^watch\.seek /)]);
    expect(room.player.stalled, room.player.log.join(' | ')).toBeLessThanOrEqual(10_000);
    expect(Math.abs(room.drift())).toBeLessThan(JUMP_LIMIT);
  });

  it('второй только что вышел — правило «комната идёт за одним» ещё не действует: комнату не двигаем', async () => {
    const room = scenario(tv, { rateSafe: false, solo: true });
    // Перемотка через секунду после того, как остался один (`SOLO_SETTLE_MS`).
    await run(1_000);
    await room.skip();
    await run(3_000);
    expect(room.commands).toEqual([expect.stringMatching(/^watch\.seek /)]);
  });

  it('канал впритык: не больше двух перемоток вдогонку, и плеер приходит на секунду комнаты', async () => {
    // Канал в 1,05 раза быстрее просмотра: почти всё ожидание здесь — сам канал (до R216 — 84 с из 90).
    const room = scenario({ resume: 5, speed: 1.05, segment: 5 }, { rateSafe: false, solo: false });
    await run(30_000);
    await room.skip();
    await run(60_000);
    expect(room.player.moves, room.player.log.join(' | ')).toBeLessThanOrEqual(3);
    expect(room.player.stalled, room.player.log.join(' | ')).toBeLessThanOrEqual(22_000);
    expect(Math.abs(room.drift())).toBeLessThan(JUMP_LIMIT);
  });

  it('компьютер: ни одной перемотки вдогонку, а расхождение уходит скоростью', async () => {
    const room = scenario({ resume: 0.8, speed: 4, segment: 5 }, { rateSafe: true, solo: false });
    await run(30_000);
    await room.skip();
    await run(30_000);
    expect(room.player.moves, room.player.log.join(' | ')).toBe(1);
    expect(room.player.stalled, room.player.log.join(' | ')).toBeLessThanOrEqual(1_000);
    expect(Math.abs(room.drift())).toBeLessThan(400);
  });
});
