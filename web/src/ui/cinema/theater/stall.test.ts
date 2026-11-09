import { describe, expect, it } from 'vitest';
import { nextHeal, type Heal, type Health } from './stall';

const health = (patch: Partial<Health> = {}): Health => ({
  ahead: 0,
  loading: false,
  fedAgoMs: 1000,
  auto: true,
  ...patch,
});

/** Лестница целиком: каждые полсекунды — как сторож в `usePlayback`, — и что за чем сделано. */
function ladder(state: Health, until: number, audio = false): [number, Heal][] {
  const done = new Set<Heal>();
  const steps: [number, Heal][] = [];
  for (let at = 0; at <= until; at += 500) {
    const step = nextHeal({ stalledMs: at, health: state, done, audio });
    if (step) {
      done.add(step);
      steps.push([at, step]);
      if (step === 'fail') break;
    }
  }
  return steps;
}

describe('лестница лечения застрявшего плеера (R216)', () => {
  it('короткая заминка — не повод: hls.js переживает её сам', () => {
    expect(nextHeal({ stalledMs: 2000, health: health({ ahead: 10 }), done: new Set() })).toBeNull();
    expect(
      nextHeal({ stalledMs: 3000, health: health({ loading: true, fedAgoMs: 500 }), done: new Set() }),
    ).toBeNull();
  });

  it('данные впереди есть, а позиция стоит (вставший декодер телевизора): толчок, пересборка, заново, отказ', () => {
    expect(ladder(health({ ahead: 20 }), 60_000)).toEqual([
      [2500, 'nudge'],
      [6000, 'rebuild'],
      [15000, 'reopen'],
      [40000, 'fail'],
    ]);
  });

  it('данных нет и загрузка не идёт: начать её заново через 4 с, ступень ниже, открыть заново, отказ', () => {
    expect(ladder(health({ loading: false }), 60_000)).toEqual([
      [4000, 'kick'],
      [8000, 'lower'],
      [22000, 'reopen'],
      [45000, 'fail'],
    ]);
  });

  it('загрузка идёт и куски приходят — не рвём её: только ступень ниже и, если не помогло, заново', () => {
    expect(ladder(health({ loading: true, fedAgoMs: 2000 }), 30_000)).toEqual([
      [8000, 'lower'],
      [22000, 'reopen'],
    ]);
  });

  it('загрузка «идёт», но ни одного куска 15 с — она висит: начать заново', () => {
    expect(ladder(health({ loading: true, fedAgoMs: null }), 16_000)).toEqual([
      [8000, 'lower'],
      [15000, 'kick'],
    ]);
    expect(
      nextHeal({ stalledMs: 5000, health: health({ loading: true, fedAgoMs: 20_000 }), done: new Set() }),
    ).toBe('kick');
  });

  it('качество, выбранное руками, лечение не трогает', () => {
    expect(ladder(health({ auto: false, loading: true, fedAgoMs: 1000 }), 30_000)).toEqual([
      [22000, 'reopen'],
    ]);
  });

  it('звук отстал от идущей картинки: толчок сразу, пересборка через 5 с, заново через 15 с', () => {
    expect(ladder(health({ ahead: 20 }), 30_000, true)).toEqual([
      [0, 'nudge'],
      [5000, 'rebuild'],
      [15000, 'reopen'],
    ]);
  });
});
