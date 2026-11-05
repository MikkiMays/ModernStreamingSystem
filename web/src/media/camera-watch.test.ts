import { describe, expect, it } from 'vitest';
import {
  BACKOFF_MS,
  CameraWatch,
  FLAT_FRAMES_MS,
  GRACE_MS,
  HEALTHY_MS,
  NO_TRACK_MS,
  UNRENDERED_MS,
  type CameraSample,
} from './camera-watch';

/*
  Сторож чужой камеры (R189, И5): решает только «что делать», дёргают и исполняют сессия и пул. Время — в
  аргументах: 2 с — шаг опроса `checkLive`.
*/

const TRACK = {};
/** Здоровая камера на момент `now`: кадры растут и показываются. */
const healthy = (now: number, extra: Partial<CameraSample> = {}): CameraSample => ({
  now,
  subscription: TRACK,
  hasTrack: true,
  sfuPaused: false,
  framesReceived: now,
  framesDecoded: now,
  rendered: now,
  elementPaused: false,
  ...extra,
});
/** Кадры из сети остановились на `at`. */
const flat = (now: number, at = 0, extra: Partial<CameraSample> = {}) =>
  healthy(now, { framesReceived: at, framesDecoded: at, rendered: at, ...extra });

/** Прогон опросов: от `from` до `to` с шагом 2 с; возвращает действия, не равные 'none', со временем. */
function run(
  watch: CameraWatch,
  sample: (now: number) => CameraSample,
  from: number,
  to: number,
): [number, string][] {
  const actions: [number, string][] = [];
  for (let now = from; now <= to; now += 2000) {
    const action = watch.observe(sample(now));
    if (action !== 'none') {
      actions.push([now, action]);
      watch.settled();
    }
  }
  return actions;
}

describe('здоровая камера', () => {
  it('кадры идут — сторож молчит сколько угодно', () => {
    const watch = new CameraWatch(0);
    expect(run(watch, healthy, 0, 120_000)).toEqual([]);
  });

  it('неизвестные счётчики (нет статистики, элемента) — не повод ни для чего', () => {
    const watch = new CameraWatch(0);
    const sample = (now: number): CameraSample => ({
      now,
      subscription: TRACK,
      hasTrack: true,
      sfuPaused: false,
    });
    expect(run(watch, sample, 0, 60_000)).toEqual([]);
  });
});

describe('кадры из сети остановились', () => {
  it('ровно плоские дольше порога — переподписка; без звука и без слова SFU тоже', () => {
    const watch = new CameraWatch(0);
    // Грация начала (3 с) и порог (4 с) считаются вместе: кадры шли и остановились на 10 с.
    run(watch, healthy, 0, 10_000);
    const stopped = (now: number) => flat(now, 10_000);
    expect(watch.observe(stopped(10_000 + FLAT_FRAMES_MS - 2000))).toBe('none');
    expect(watch.observe(stopped(10_000 + FLAT_FRAMES_MS))).toBe('resubscribe');
  });

  it('отступ 8/16/32/60 с между попытками, дальше — раз в минуту', () => {
    const watch = new CameraWatch(0);
    const actions = run(watch, (now) => flat(now), GRACE_MS, 240_000);
    expect(actions.every(([, action]) => action === 'resubscribe')).toBe(true);
    const times = actions.map(([at]) => at);
    const gaps = times.slice(1).map((at, i) => at - times[i]!);
    // Шаг опроса 2 с — отступ не короче заданного и не длиннее на шаг.
    for (const [i, gap] of gaps.entries()) {
      const wanted = BACKOFF_MS[Math.min(i, BACKOFF_MS.length - 1)]!;
      expect(gap).toBeGreaterThanOrEqual(wanted);
      expect(gap).toBeLessThanOrEqual(wanted + 2000);
    }
    expect(gaps.length).toBeGreaterThanOrEqual(5);
  });

  it('5 с здоровых кадров — отступ сначала; меньше — нет', () => {
    const watch = new CameraWatch(0);
    expect(run(watch, (now) => flat(now), GRACE_MS, 20_000).length).toBeGreaterThan(0);
    // Второй отступ уже взведён: попытка идёт позже, чем через 8 с после предыдущей...
    run(watch, healthy, 22_000, 22_000 + HEALTHY_MS - 2000);
    const short = run(watch, (now) => flat(now, 26_000), 26_000, 140_000).map(([at]) => at);
    expect(short[1]! - short[0]!).toBeGreaterThanOrEqual(BACKOFF_MS[2]);
    // ...а после честных пяти секунд отступ снова первый.
    const fresh = new CameraWatch(0);
    run(fresh, (now) => flat(now), GRACE_MS, 20_000);
    run(fresh, healthy, 22_000, 22_000 + HEALTHY_MS + 2000);
    const again = run(fresh, (now) => flat(now, 30_000), 30_000, 60_000).map(([at]) => at);
    expect(again[1]! - again[0]!).toBeLessThanOrEqual(BACKOFF_MS[0] + 2000);
  });

  it('пока действие не завершено, второго нет', () => {
    const watch = new CameraWatch(0);
    let first = 'none';
    let now = 0;
    for (; first === 'none'; now += 2000) first = watch.observe(flat(now));
    expect(first).toBe('resubscribe');
    for (const later of [60_000, 62_000, 120_000]) expect(watch.observe(flat(later))).toBe('none');
    watch.settled();
    expect(watch.observe(flat(180_000))).toBe('resubscribe');
  });
});

describe('SFU сказал «пауза»', () => {
  it('никакой переподписки, сколько бы пауза ни длилась', () => {
    const watch = new CameraWatch(0);
    expect(run(watch, (now) => flat(now, 0, { sfuPaused: true }), 0, 600_000)).toEqual([]);
  });

  it('после снятия паузы — грация и порог заново, а не сразу', () => {
    const watch = new CameraWatch(0);
    run(watch, (now) => flat(now, 0, { sfuPaused: true }), 0, 60_000);
    expect(watch.observe(flat(62_000))).toBe('none');
    expect(watch.observe(flat(62_000 + GRACE_MS))).toBe('none');
    expect(watch.observe(flat(62_000 + GRACE_MS + FLAT_FRAMES_MS))).toBe('resubscribe');
  });
});

describe('желанная, но дорожки нет', () => {
  const missing = (now: number): CameraSample => ({
    now,
    subscription: undefined,
    hasTrack: false,
    sfuPaused: false,
  });

  it('больше 5 с — переключить подписку, с тем же отступом', () => {
    const watch = new CameraWatch(0);
    const actions = run(watch, missing, 0, 40_000);
    expect(actions[0]![1]).toBe('subscribe');
    expect(actions[0]![0]).toBeGreaterThanOrEqual(NO_TRACK_MS);
    expect(actions[1]![0] - actions[0]![0]).toBeGreaterThanOrEqual(BACKOFF_MS[0]);
  });

  it('SDK сказал «подписка не удалась» — не ждать пяти секунд', () => {
    const watch = new CameraWatch(0);
    expect(watch.observe(missing(GRACE_MS))).toBe('none');
    watch.subscriptionFailed();
    expect(watch.observe(missing(GRACE_MS + 1))).toBe('subscribe');
  });

  it('дорожка пришла — новая подписка: грация, а не «кадров нет»', () => {
    const watch = new CameraWatch(0);
    run(watch, missing, 0, 4000);
    const arrived = {};
    expect(watch.observe(flat(6000, 0, { subscription: arrived }))).toBe('none');
    expect(watch.observe(flat(6000 + GRACE_MS, 0, { subscription: arrived }))).toBe('none');
    expect(watch.observe(flat(6000 + GRACE_MS + FLAT_FRAMES_MS, 0, { subscription: arrived }))).toBe(
      'resubscribe',
    );
  });
});

describe('элемент', () => {
  it('`video.paused` — play, потом перепривязка, потом новый элемент', () => {
    const watch = new CameraWatch(0);
    const paused = (now: number) => healthy(now, { elementPaused: true });
    const actions = run(watch, paused, GRACE_MS, 60_000);
    expect(actions.map(([, action]) => action).slice(0, 4)).toEqual([
      'play',
      'reattach',
      'replace',
      'replace',
    ]);
    expect(actions[0]![0]).toBeLessThan(GRACE_MS + 2000);
    expect(actions[1]![0] - actions[0]![0]).toBeGreaterThanOrEqual(BACKOFF_MS[0]);
  });

  it('play помог — лесенка сначала, когда кадры снова здоровы 5 с', () => {
    const watch = new CameraWatch(0);
    expect(watch.observe(healthy(GRACE_MS, { elementPaused: true }))).toBe('play');
    watch.settled();
    run(watch, healthy, GRACE_MS + 2000, GRACE_MS + 2000 + HEALTHY_MS + 2000);
    expect(watch.observe(healthy(30_000, { elementPaused: true }))).toBe('play');
  });

  it('кадры декодируются, а не показываются — та же лесенка, не сеть', () => {
    const watch = new CameraWatch(0);
    run(watch, healthy, 0, 10_000);
    const unrendered = (now: number) => healthy(now, { rendered: 10_000 });
    expect(watch.observe(unrendered(10_000 + UNRENDERED_MS - 2000))).toBe('none');
    expect(watch.observe(unrendered(10_000 + UNRENDERED_MS))).toBe('play');
  });

  it('счётчик показа неизвестен (браузер не умеет) — проверки показа нет', () => {
    const watch = new CameraWatch(0);
    const sample = (now: number) => healthy(now, { rendered: undefined });
    expect(run(watch, sample, 0, 60_000)).toEqual([]);
  });

  it('декодер не показывает кадры (LiveHealth) — переподписка с общим отступом', () => {
    const watch = new CameraWatch(0);
    run(watch, healthy, 0, 10_000);
    expect(watch.observe(healthy(12_000, { stalled: true }))).toBe('resubscribe');
    watch.settled();
    expect(watch.observe(healthy(14_000, { stalled: true }))).toBe('none');
  });
});

describe('грация', () => {
  it('новая камера — три секунды ни за что не цепляется', () => {
    const watch = new CameraWatch(0);
    expect(watch.observe(healthy(0, { elementPaused: true }))).toBe('none');
    expect(watch.observe(healthy(GRACE_MS - 1, { elementPaused: true }))).toBe('none');
    expect(watch.observe(healthy(GRACE_MS, { elementPaused: true }))).toBe('play');
  });

  it('заглушённая, скрытая, у переподключающегося — пропуск; возврат — грация и порог заново', () => {
    const watch = new CameraWatch(0);
    run(watch, healthy, 0, 10_000);
    watch.skip();
    expect(watch.observe(flat(120_000, 10_000))).toBe('none');
    expect(watch.observe(flat(120_000 + GRACE_MS, 10_000))).toBe('none');
    expect(watch.observe(flat(120_000 + GRACE_MS + FLAT_FRAMES_MS, 10_000))).toBe('resubscribe');
  });

  it('плитку перенесли — грация', () => {
    const watch = new CameraWatch(0);
    run(watch, (now) => healthy(now, { movedAt: 1 }), 0, 10_000);
    const moved = (now: number) => healthy(now, { movedAt: 2, elementPaused: true });
    expect(watch.observe(moved(12_000))).toBe('none');
    expect(watch.observe(moved(12_000 + GRACE_MS))).toBe('play');
  });
});
