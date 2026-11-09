import { describe, expect, it } from 'vitest';
import {
  COOLDOWN_MS,
  DecodeWatch,
  DEMOTION_DAYS,
  DEMOTION_KEY,
  demote,
  demotedFamilies,
  familyOf,
  MAX_STEPS,
  STALL_WINDOW_MS,
  SUSTAIN,
  WINDOW,
  type Frames,
} from './decode';

/** Кадры раз в секунду: `fps` декодировано, из них `drop` потеряно, — сколько секунд, начиная с `from`. */
function feed(
  watch: DecodeWatch,
  state: { at: number; frames: Frames },
  seconds: number,
  fps: number,
  drop: number,
) {
  const verdicts = [];
  for (let i = 0; i < seconds; i++) {
    state.at += 1000;
    state.frames = { total: state.frames.total + fps, dropped: state.frames.dropped + drop };
    const verdict = watch.sample(state.at, state.frames);
    if (verdict) verdicts.push({ at: state.at, ...verdict });
  }
  return verdicts;
}

const start = () => ({ at: 0, frames: { total: 0, dropped: 0 } });

class Memory {
  items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
}

describe('кодек по силам устройства по ходу просмотра (R216)', () => {
  it('семейство кодека — по строке плейлиста', () => {
    expect(familyOf('av01.0.09M.08')).toBe('av01');
    expect(familyOf('video/mp4; codecs="vp09.00.41.08"')).toBe('vp09');
    expect(familyOf('avc1.640028')).toBe('avc1');
    expect(familyOf('hev1.1.6.L93.B0')).toBe('hvc1');
    expect(familyOf(undefined)).toBe('');
  });

  it('ровная картинка — ничего; редкие потери — ничего', () => {
    const watch = new DecodeWatch();
    const state = start();
    expect(feed(watch, state, 60, 60, 0)).toEqual([]);
    // 10 % потерь (60 кадров на экране 50 Гц теряют шестую часть) — не повод.
    expect(feed(watch, state, 60, 60, 6)).toEqual([]);
  });

  it('устойчиво теряет больше пятой части кадров — облегчить, но не с первой плохой секунды', () => {
    const watch = new DecodeWatch();
    const state = start();
    feed(watch, state, WINDOW, 60, 0);
    const verdicts = feed(watch, state, 30, 60, 20);
    expect(verdicts.length).toBeGreaterThan(0);
    const first = verdicts[0]!;
    expect(first.reason).toBe('frames');
    // Окно должно стать плохим и продержаться SUSTAIN проверок.
    expect(first.at - WINDOW * 1000).toBeGreaterThanOrEqual(SUSTAIN * 1000);
    expect(first.ratio).toBeGreaterThan(0.2);
  });

  it('короткая вспышка потерь (переход качества, тяжёлая сцена) — не повод', () => {
    const watch = new DecodeWatch();
    const state = start();
    feed(watch, state, WINDOW, 60, 0);
    expect(feed(watch, state, 3, 60, 45)).toEqual([]);
    expect(feed(watch, state, 30, 60, 0)).toEqual([]);
  });

  it('мало кадров (стоп-кадр, слайд-шоу) — не судим', () => {
    const watch = new DecodeWatch();
    expect(feed(watch, start(), 60, 5, 3)).toEqual([]);
  });

  it('пауза, перемотка, скрытая вкладка — не в счёт; сброс счётчиков — новое начало, а не минус', () => {
    const watch = new DecodeWatch();
    const state = start();
    feed(watch, state, WINDOW, 60, 30);
    // Пауза посреди плохого: подряд считается заново.
    expect(watch.sample(state.at + 500, null)).toBeNull();
    // Новый источник медиа: счётчики с нуля.
    state.frames = { total: 10, dropped: 0 };
    expect(watch.sample(state.at + 1000, state.frames)).toBeNull();
    state.at += 1000;
    expect(feed(watch, state, SUSTAIN - 1, 60, 30)).toEqual([]);
  });

  it('после шага — передышка; шаг не помог — больше не шагаем; шагов не больше трёх', () => {
    const watch = new DecodeWatch();
    const state = start();
    feed(watch, state, WINDOW, 60, 0);
    const first = feed(watch, state, 30, 60, 30)[0]!;
    watch.stepped(first.at, first);
    // В передышку не судим, даже если всё так же плохо.
    state.at = first.at;
    expect(feed(watch, state, COOLDOWN_MS / 1000, 60, 30)).toEqual([]);
    // После неё всё так же плохо (шаг не убавил потерь) — дело не в декодере: стоп.
    expect(feed(watch, state, 60, 60, 30)).toEqual([]);
    expect(watch.done).toBe(true);

    const helped = new DecodeWatch();
    const again = start();
    feed(helped, again, WINDOW, 60, 0);
    for (let step = 0; step < MAX_STEPS; step++) {
      // Каждый шаг вдвое убавляет потери — помогает, но не до конца.
      const drop = Math.round(48 / 2 ** step);
      const verdict = feed(helped, again, 40, 60, drop)[0];
      expect(verdict, `шаг ${step + 1}`).toBeDefined();
      helped.stepped(verdict!.at, verdict!);
      again.at = verdict!.at;
    }
    expect(helped.done).toBe(true);
  });

  it('шаг доказал пользу — один раз «помог» (тогда кодек стоит запомнить); не доказал — нет', () => {
    const watch = new DecodeWatch();
    const state = start();
    feed(watch, state, WINDOW, 60, 0);
    const verdict = feed(watch, state, 30, 60, 40)[0]!;
    watch.stepped(verdict.at, verdict);
    state.at = verdict.at;
    expect(watch.takeProven()).toBe(false);
    // Новый кодек: потерь почти нет.
    feed(watch, state, COOLDOWN_MS / 1000 + WINDOW, 60, 1);
    expect(watch.takeProven()).toBe(true);
    expect(watch.takeProven()).toBe(false);
  });

  it('застревания при данных впереди: два за три минуты — облегчить; одно или давно — нет', () => {
    const watch = new DecodeWatch();
    expect(watch.stall(1000)).toBeNull();
    expect(watch.stall(1000 + STALL_WINDOW_MS + 1)).toBeNull();
    const verdict = watch.stall(1000 + STALL_WINDOW_MS + 60_000);
    expect(verdict).toEqual({ reason: 'stalls', ratio: null });
  });

  it('отказ от кодека помнится на этом устройстве неделю', () => {
    const store = new Memory();
    const now = 1_790_000_000_000;
    expect(demotedFamilies(now, store)).toEqual(new Set());
    demote('av01', now, store);
    demote('vp09', now + 1000, store);
    demote('av01', now + 2000, store);
    expect(demotedFamilies(now + 3000, store)).toEqual(new Set(['av01', 'vp09']));
    expect(JSON.parse(store.getItem(DEMOTION_KEY)!)).toHaveLength(2);
    expect(demotedFamilies(now + 1000 + DEMOTION_DAYS * 86_400_000 + 1, store)).toEqual(new Set(['av01']));
    // Испорченная запись или нет хранилища — просто ничего не помним.
    store.setItem(DEMOTION_KEY, '{oops');
    expect(demotedFamilies(now, store)).toEqual(new Set());
    expect(demotedFamilies(now, null)).toEqual(new Set());
    expect(() => demote('vp09', now, null)).not.toThrow();
  });
});
