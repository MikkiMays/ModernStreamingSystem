import { describe, expect, it } from 'vitest';
import { RecoveryWindow } from './recovery';

describe('network recovery deadline', () => {
  it('uses a fixed deadline across repeated losses and network hints', () => {
    let now = 0;
    const recovery = new RecoveryWindow(
      20000,
      () => now,
      () => 0.5,
    );
    const epoch = recovery.begin();
    expect(recovery.delay(0)).toBe(0);
    now = 19000;
    expect(recovery.begin()).toBe(epoch);
    expect(recovery.remaining()).toBe(1000);
    expect(recovery.delay(9)).toBeNull();
    now = 20000;
    expect(recovery.delay(0)).toBeNull();
  });
  it('fences stale timers after recovery and a second failure', () => {
    const recovery = new RecoveryWindow();
    const stale = recovery.begin();
    recovery.recovered();
    const fresh = recovery.begin();
    expect(recovery.current(stale)).toBe(false);
    expect(recovery.current(fresh)).toBe(true);
    recovery.stop();
    expect(recovery.current(fresh)).toBe(false);
  });
  it('uses the requested bounded backoff', () => {
    const recovery = new RecoveryWindow(
      20000,
      () => 0,
      () => 0.5,
    );
    expect([0, 1, 2, 3, 4, 20].map((n) => recovery.delay(n))).toEqual([0, 500, 1000, 2000, 3000, 3000]);
  });
});
