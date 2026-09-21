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
  /**
   * Телефон в кармане.
   *
   * Двадцать секунд отведены человеку, который смотрит на экран. У погашенного экрана смотреть
   * некому, и отсчитывать в это время конец встречи — значит закончить её за то, что телефон
   * убрали в карман. Окно стоит, пока не смотрят, и продолжается с того же остатка, а не с
   * начала: иначе «свернул и развернул» дарило бы по двадцать секунд сколько угодно раз.
   */
  it('holds the window while the screen is off and resumes from the same remainder', () => {
    let now = 0;
    const recovery = new RecoveryWindow(
      20000,
      () => now,
      () => 0.5,
    );
    recovery.begin();
    now = 5000;
    expect(recovery.remaining()).toBe(15000);
    recovery.hold(true);
    expect(recovery.holding).toBe(true);
    // Пока придержано, срок не тратится, сколько бы времени ни прошло.
    now = 605000;
    expect(recovery.remaining()).toBe(15000);
    expect(recovery.delay(0)).toBe(0);
    // Вернулись к экрану: остаток тот же, а не новые двадцать секунд.
    recovery.hold(false);
    expect(recovery.holding).toBe(false);
    expect(recovery.remaining()).toBe(15000);
    now = 620000;
    expect(recovery.remaining()).toBe(0);
    // Восстановление снимает придержку заодно: следующее окно начинается чистым.
    recovery.hold(true);
    recovery.recovered();
    expect(recovery.holding).toBe(false);
    expect(recovery.remaining()).toBe(20000);
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
