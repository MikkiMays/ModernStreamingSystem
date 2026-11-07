import { describe, expect, it } from 'vitest';
import { FIRST_CAPTURE_SLOW_MS, MIC_SLOW_MS, micSlowDetail, PressTimer } from './mic-press';

describe('сколько заняло нажатие на микрофон (R191)', () => {
  it('быстрое включение — ничего не пишем, медленное — из чего сложилось, без имён', () => {
    const press = {
      waitMs: 0,
      wakeMs: 0,
      unmuteMs: 3,
      processorMs: 0,
      recaptured: false,
      signal: 'connected',
      rtt: 40,
    };
    expect(micSlowDetail({ ...press, totalMs: MIC_SLOW_MS - 1 })).toBeNull();
    expect(
      micSlowDetail({ ...press, totalMs: 1640, unmuteMs: 1600, processorMs: 40, recaptured: true }),
    ).toBe('total=1640 unmute=1600 proc=40 recapture signal=connected rtt=40');
  });

  it('первый захват идёт дольше законно: у него свой порог', () => {
    const press = {
      waitMs: 0,
      wakeMs: 0,
      unmuteMs: 0,
      processorMs: 0,
      recaptured: false,
      signal: 'connected',
      rtt: 0,
    };
    expect(micSlowDetail({ ...press, totalMs: FIRST_CAPTURE_SLOW_MS - 1, firstCapture: true })).toBeNull();
    expect(micSlowDetail({ ...press, totalMs: FIRST_CAPTURE_SLOW_MS, firstCapture: true })).toBe(
      `total=${FIRST_CAPTURE_SLOW_MS} first-capture signal=connected`,
    );
  });

  it('нажатие ждало занятое устройство или заглушённый захват — это видно отдельно', () => {
    expect(
      micSlowDetail({
        totalMs: 1110,
        waitMs: 500,
        wakeMs: 600,
        unmuteMs: 10,
        processorMs: 0,
        recaptured: false,
        signal: 'signalReconnecting',
        rtt: 0,
      }),
    ).toBe('total=1110 wait=500 wake=600 unmute=10 signal=signalReconnecting');
  });

  it('секундомер считает шаги между отметками и всё время с нажатия', () => {
    let now = 100;
    const timer = new PressTimer(() => now);
    now = 150;
    expect(timer.lap()).toBe(50);
    now = 180;
    expect(timer.lap()).toBe(30);
    expect(timer.total()).toBe(80);
  });

  it('секундомер нажатия, которое ждало, идёт с самого нажатия', () => {
    let now = 500;
    const timer = new PressTimer(() => now, 100);
    expect(timer.lap()).toBe(400);
    now = 510;
    expect(timer.total()).toBe(410);
  });
});
