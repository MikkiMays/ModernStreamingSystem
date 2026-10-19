import { describe, expect, it, vi } from 'vitest';
import { Store } from '../core/store';
import {
  levelOf,
  rmsDb,
  smoothDb,
  tierOf,
  VoiceLevels,
  type LevelsEnvironment,
  type Meter,
  type VoiceSource,
} from './levels';

/*
  Уровень голоса проверяется синтетическим сигналом: синус известной амплитуды даёт известный
  уровень, а время идёт по нашим часам. Так видно то, ради чего модуль написан, — обводка
  загорается на первом же опросе и гаснет за 150–250 мс, а не через полсекунды SFU.
*/

const RATE = 48000;
/** 21 мс синуса 220 Гц с амплитудой `amplitude` — то, что отдал бы анализатор. */
function sine(amplitude: number, samples = 1024) {
  const data = new Float32Array(samples);
  for (let i = 0; i < samples; i += 1) data[i] = amplitude * Math.sin((2 * Math.PI * 220 * i) / RATE);
  return data;
}

/** Окружение на ручных часах: кадры вызываются тестом, сигнал задаётся на дорожку. */
function harness() {
  let now = 0;
  let visible = true;
  let frames: (() => void)[] = [];
  const signal = new Map<MediaStreamTrack, number>();
  const meters: { track: MediaStreamTrack; reads: number; closed: boolean }[] = [];
  const visibility = new Set<() => void>();
  const env: LevelsEnvironment = {
    meter: (track) => {
      const record = { track, reads: 0, closed: false };
      meters.push(record);
      const meter: Meter = {
        read: () => {
          record.reads += 1;
          return rmsDb(sine(signal.get(track) ?? 0));
        },
        close: () => {
          record.closed = true;
        },
      };
      return meter;
    },
    now: () => now,
    frame: (callback) => {
      frames.push(callback);
      return () => {
        frames = frames.filter((frame) => frame !== callback);
      };
    },
    visible: () => visible,
    onVisibility: (callback) => {
      visibility.add(callback);
      return () => visibility.delete(callback);
    },
    close: vi.fn(),
  };
  /** Прожить `ms` миллисекунд кадрами экрана 60 Гц. */
  const run = (ms: number) => {
    const end = now + ms;
    while (now < end - 1e-9) {
      now = Math.min(end, now + 1000 / 60);
      const pending = frames;
      frames = [];
      pending.forEach((frame) => frame());
    }
  };
  return {
    env,
    meters,
    run,
    signal,
    get frames() {
      return frames.length;
    },
    hide: (hidden: boolean) => {
      visible = !hidden;
      visibility.forEach((callback) => callback());
    },
  };
}

function track(): VoiceSource['track'] {
  return { kind: 'audio', mediaStreamTrack: { readyState: 'live' } as MediaStreamTrack };
}

function mic(participantId: string, value = track(), muted = false): VoiceSource {
  return { participantId, source: 'microphone', muted, track: value };
}

describe('уровень по отсчётам', () => {
  it('синус полной шкалы — около −3 дБ, тишина — дно шкалы', () => {
    // Окно не кратно периоду — сотые доли децибела гуляют.
    expect(rmsDb(sine(1))).toBeCloseTo(-3, 0);
    expect(rmsDb(sine(0.1))).toBeCloseTo(-23, 0);
    expect(rmsDb(new Float32Array(1024))).toBe(-100);
  });

  it('четыре ступени растут вместе с громкостью, тишина — ступень 0', () => {
    const tiers = [0.0005, 0.01, 0.03, 0.1, 0.4].map((amplitude) => tierOf(rmsDb(sine(amplitude))));
    expect(tiers).toEqual([0, 1, 2, 3, 4]);
  });

  it('шкала уровня — от −60 дБ до нуля', () => {
    expect(levelOf(-80)).toBe(0);
    expect(levelOf(-30)).toBeCloseTo(0.5);
    expect(levelOf(0)).toBe(1);
  });

  it('атака мгновенная, спад не быстрее 120 дБ/с', () => {
    expect(smoothDb(-80, -20, 33)).toBe(-20);
    expect(smoothDb(-20, -80, 100)).toBeCloseTo(-32);
    expect(smoothDb(-20, -80, 10_000)).toBe(-80);
  });
});

describe('VoiceLevels', () => {
  it('обводка загорается на первом опросе после начала звука', () => {
    const h = harness();
    const source = mic('anna');
    const levels = new VoiceLevels(new Store([source]), new Store<string[]>([]), h.env);
    levels.watch('anna', () => {});
    h.run(100);
    expect(levels.tier('anna')).toBe(0);
    h.signal.set(source.track.mediaStreamTrack!, 0.1);
    // Один опрос — не больше 1000/30 мс плюс кадр.
    h.run(50);
    expect(levels.tier('anna')).toBe(3);
    expect(levels.level('anna')).toBeGreaterThan(0.6);
  });

  it('после речи гаснет за 150–250 мс и не мерцает в паузах между слогами', () => {
    const h = harness();
    const source = mic('anna');
    const levels = new VoiceLevels(new Store([source]), new Store<string[]>([]), h.env);
    levels.watch('anna', () => {});
    const stream = source.track.mediaStreamTrack!;
    // Слоги по 120 мс с паузами по 60 мс: обводка обязана гореть всё это время.
    const seen: number[] = [];
    for (let syllable = 0; syllable < 5; syllable += 1) {
      h.signal.set(stream, 0.05);
      h.run(120);
      seen.push(levels.tier('anna'));
      h.signal.set(stream, 0);
      h.run(60);
      seen.push(levels.tier('anna'));
    }
    expect(seen.every((tier) => tier > 0)).toBe(true);
    // Речь закончилась.
    h.signal.set(stream, 0.05);
    h.run(100);
    h.signal.set(stream, 0);
    let dark = 0;
    while (levels.tier('anna') > 0 && dark < 1000) {
      h.run(1000 / 60);
      dark += 1000 / 60;
    }
    expect(dark).toBeGreaterThanOrEqual(130);
    expect(dark).toBeLessThanOrEqual(250);
  });

  it('опрашивает не чаще 30 раз в секунду', () => {
    const h = harness();
    const levels = new VoiceLevels(new Store([mic('anna')]), new Store<string[]>([]), h.env);
    levels.watch('anna', () => {});
    h.run(1000);
    expect(h.meters[0]!.reads).toBeLessThanOrEqual(31);
    expect(h.meters[0]!.reads).toBeGreaterThanOrEqual(25);
  });

  it('анализатор только у тех, на кого смотрят, и закрывается, когда смотреть перестали', () => {
    const h = harness();
    const levels = new VoiceLevels(
      new Store([mic('anna'), mic('boris'), mic('vera')]),
      new Store<string[]>([]),
      h.env,
    );
    expect(h.meters).toHaveLength(0);
    const stop = levels.watch('boris', () => {});
    expect(h.meters.map((meter) => meter.closed)).toEqual([false]);
    stop();
    expect(h.meters[0]!.closed).toBe(true);
    // Не на кого смотреть — нет и кадров.
    expect(h.frames).toBe(0);
  });

  it('оверлей клиента смотрит сразу на всех', () => {
    const h = harness();
    const levels = new VoiceLevels(new Store([mic('anna'), mic('boris')]), new Store<string[]>([]), h.env);
    const stop = levels.watchAll(() => {});
    expect(h.meters).toHaveLength(2);
    stop();
    expect(h.meters.every((meter) => meter.closed)).toBe(true);
  });

  it('скрытая вкладка не опрашивает и гасит обводку', () => {
    const h = harness();
    const source = mic('anna');
    const levels = new VoiceLevels(new Store([source]), new Store<string[]>([]), h.env);
    levels.watch('anna', () => {});
    h.signal.set(source.track.mediaStreamTrack!, 0.1);
    h.run(50);
    expect(levels.tier('anna')).toBeGreaterThan(0);
    h.hide(true);
    expect(levels.tier('anna')).toBe(0);
    const reads = h.meters[0]!.reads;
    h.run(500);
    expect(h.meters[0]!.reads).toBe(reads);
    h.hide(false);
    h.run(50);
    expect(levels.tier('anna')).toBeGreaterThan(0);
  });

  it('заглушённый микрофон не измеряется', () => {
    const h = harness();
    const levels = new VoiceLevels(new Store([mic('anna', track(), true)]), new Store<string[]>([]), h.env);
    levels.watch('anna', () => {});
    expect(h.meters).toHaveLength(0);
    expect(levels.tier('anna')).toBe(0);
  });

  it('новая дорожка под той же публикацией (обработка микрофона) — новый анализатор', () => {
    const h = harness();
    const source = mic('anna');
    const levels = new VoiceLevels(new Store([source]), new Store<string[]>([]), h.env);
    levels.watch('anna', () => {});
    const processed = { readyState: 'live' } as MediaStreamTrack;
    source.track.mediaStreamTrack = processed;
    h.signal.set(processed, 0.1);
    h.run(100);
    expect(h.meters[0]!.closed).toBe(true);
    expect(h.meters.at(-1)!.track).toBe(processed);
    expect(levels.tier('anna')).toBe(3);
  });

  it('без анализатора — ступень от SFU, с задержкой сервера, но не пусто', () => {
    const h = harness();
    const speaking = new Store<string[]>([]);
    const levels = new VoiceLevels(new Store([mic('anna')]), speaking, { ...h.env, meter: () => null });
    levels.watch('anna', () => {});
    levels.watch('remote-without-track', () => {});
    speaking.set(['anna', 'remote-without-track']);
    expect(levels.tier('anna')).toBe(2);
    expect(levels.tier('remote-without-track')).toBe(2);
    speaking.set([]);
    expect(levels.tier('anna')).toBe(0);
  });

  it('уровень меряется, а SFU не перебивает его своим мнением', () => {
    const h = harness();
    const source = mic('anna');
    const speaking = new Store<string[]>(['anna']);
    const levels = new VoiceLevels(new Store([source]), speaking, h.env);
    levels.watch('anna', () => {});
    h.run(100);
    expect(levels.tier('anna')).toBe(0);
  });

  it('слушатель зовётся, только когда уровни изменились', () => {
    const h = harness();
    const source = mic('anna');
    const levels = new VoiceLevels(new Store([source]), new Store<string[]>([]), h.env);
    const listener = vi.fn();
    levels.watch('anna', listener);
    h.run(500);
    expect(listener).not.toHaveBeenCalled();
    h.signal.set(source.track.mediaStreamTrack!, 0.1);
    h.run(50);
    expect(listener).toHaveBeenCalled();
  });
});
