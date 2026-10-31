import { describe, expect, it } from 'vitest';
import { CodecPlanner, type PlanInput } from './codec-planner';
import { probeKey, type Codec, type ProbeAnswers, type Scalability } from './codec-policy';
import type { EncoderSample } from './encoder-health';

function probe(...entries: [Codec, Scalability, 'hw' | 'sw'][]): ProbeAnswers {
  return Object.fromEntries(
    entries.map(([codec, mode, kind]) => [
      probeKey(codec, mode),
      { supported: true, smooth: true, powerEfficient: kind === 'hw' },
    ]),
  );
}
/** RTX 40 + встроенная Intel: AV1 и H.265 в железе, H.264 честно аппаратный. */
const rtx40: PlanInput = {
  source: 'camera',
  platform: 'electron',
  level: { width: 1280, height: 720, fps: 30, bitrate: 3_000_000 },
  probe: probe(['av1', 'L1T3', 'hw'], ['h265', 'L1T1', 'hw'], ['h264', 'L1T1', 'hw'], ['vp9', 'L1T3', 'sw']),
  gpu: { vendors: ['nvidia', 'intel'], source: 'shell' },
  cores: 8,
  sendable: ['av1', 'h265', 'vp9', 'h264', 'vp8'],
};
const calm: EncoderSample = { limitation: 'none', encodeMs: 4, targetFps: 30, software: false };
const cpu: EncoderSample = { ...calm, limitation: 'cpu' };

function clock() {
  let now = 0;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}
function feed(planner: CodecPlanner, source: 'camera' | 'screen', sample: EncoderSample, times: number) {
  let last = planner.observe(source, sample);
  for (let i = 1; i < times; i++) last = planner.observe(source, sample);
  return last;
}

describe('планировщик кодеков', () => {
  it('отступает по лестнице, а не сразу на H.264, и считает каждую смену', () => {
    const time = clock();
    const planner = new CodecPlanner(time.now);
    expect(planner.plan('camera', rtx40, true).codec).toBe('av1');
    const first = feed(planner, 'camera', cpu, 3);
    expect(first).toMatchObject({ kind: 'switch', from: 'av1', reason: 'cpu' });
    expect(first.kind === 'switch' && first.decision.codec).toBe('h265');
    expect(planner.takeSwitches()).toEqual([{ source: 'camera', from: 'av1', to: 'h265', reason: 'cpu' }]);
    expect(planner.info('camera')).toMatchObject({ fallbacks: 1, switches: 1, pending: false });
    expect(planner.info('camera')?.decision.reason).toBe('fallback');
  });

  it('переопубликация ради кодека — не чаще раза в 30 с', () => {
    const time = clock();
    const planner = new CodecPlanner(time.now);
    planner.plan('camera', rtx40, true);
    expect(feed(planner, 'camera', cpu, 3).kind).toBe('switch');
    time.advance(10_000);
    // H.265 тоже упёрся — решено, но ждёт окна; повторные жалобы отступами не считаются.
    expect(feed(planner, 'camera', cpu, 3).kind).toBe('none');
    expect(planner.info('camera')).toMatchObject({ pending: true, fallbacks: 2 });
    expect(feed(planner, 'camera', cpu, 6).kind).toBe('none');
    expect(planner.info('camera')?.fallbacks).toBe(2);
    time.advance(20_000);
    const late = planner.observe('camera', cpu);
    expect(late).toMatchObject({ kind: 'switch', from: 'h265', reason: 'cpu' });
    expect(late.kind === 'switch' && late.decision.codec).toBe('h264');
  });

  it('переподключение сторожа не пересоздаёт: второй возврат по-прежнему вдвое терпеливее', () => {
    const time = clock();
    const planner = new CodecPlanner(time.now);
    planner.plan('camera', rtx40, true);
    feed(planner, 'camera', cpu, 3); // av1 → h265
    time.advance(31_000);
    expect(feed(planner, 'camera', calm, 4)).toMatchObject({ kind: 'switch', reason: 'restore' });
    time.advance(31_000);
    feed(planner, 'camera', cpu, 3); // снова av1 → h265, отступ второй
    time.advance(31_000);
    planner.reconnected();
    // Прежде `new EncoderHealth()` на каждом `connected` возвращал через 2 замера; теперь — через 8.
    expect(feed(planner, 'camera', calm, 7).kind).toBe('none');
    expect(planner.observe('camera', calm)).toMatchObject({ kind: 'switch', reason: 'restore' });
    expect(planner.current('camera')?.codec).toBe('av1');
  });

  it('аппаратный AV1 оказался программным — отступ и без возврата', () => {
    const time = clock();
    const planner = new CodecPlanner(time.now);
    planner.plan('camera', rtx40, true);
    const sw = { ...calm, software: true };
    expect(planner.observe('camera', sw).kind).toBe('none');
    expect(planner.observe('camera', sw)).toMatchObject({ kind: 'switch', reason: 'software' });
    time.advance(60_000);
    expect(feed(planner, 'camera', calm, 40).kind).toBe('none');
    expect(planner.current('camera')?.codec).toBe('h265');
  });

  it('программный H.264 при `cpu` — подсказка, не чаще раза в 5 минут; кадр и кодек те же', () => {
    const time = clock();
    const planner = new CodecPlanner(time.now);
    const weak: PlanInput = { ...rtx40, probe: probe(['h264', 'L1T1', 'sw']), gpu: null, cores: 2 };
    expect(planner.plan('camera', weak, true)).toMatchObject({ codec: 'h264', hw: false });
    const soft = { ...cpu, software: true };
    expect(feed(planner, 'camera', soft, 3)).toEqual({ kind: 'hint', source: 'camera', reason: 'cpu' });
    expect(feed(planner, 'camera', soft, 3).kind).toBe('none');
    time.advance(5 * 60_000);
    expect(feed(planner, 'camera', soft, 3).kind).toBe('hint');
    expect(planner.current('camera')).toMatchObject({ codec: 'h264', hw: false });
    expect(planner.takeSwitches()).toEqual([]);
  });

  it('у камеры и показа свои сторожа', () => {
    const planner = new CodecPlanner(clock().now);
    planner.plan('camera', rtx40, true);
    planner.plan('screen', { ...rtx40, source: 'screen-smooth' }, true);
    expect(feed(planner, 'screen', cpu, 3).kind).toBe('switch');
    expect(planner.current('camera')?.codec).toBe('av1');
    expect(planner.info('camera')?.fallbacks).toBe(0);
  });

  it('зрители: без запаса — следующая ступень сразу, повторная смена — через 30 с', () => {
    const time = clock();
    const planner = new CodecPlanner(time.now);
    const tight: PlanInput = { ...rtx40, cores: 4, gpu: { vendors: ['nvidia'], source: 'shell' } };
    planner.plan('camera', tight, true);
    expect(planner.current('camera')?.codec).toBe('av1');
    const safari: Codec[] = ['h265', 'h264', 'vp9', 'vp8'];
    const [toH265] = planner.setViewers([safari]);
    expect(toH265).toMatchObject({ kind: 'switch', reason: 'viewers', from: 'av1' });
    // Тот же состав повторно — не событие.
    expect(planner.setViewers([safari])).toEqual([]);
    time.advance(5_000);
    expect(planner.setViewers([safari, ['h264', 'vp8']])).toEqual([]);
    expect(planner.info('camera')?.pending).toBe(true);
    time.advance(25_000);
    const later = planner.observe('camera', calm);
    expect(later).toMatchObject({ kind: 'switch', reason: 'viewers', from: 'h265' });
  });

  it('смена уровня человеком — смена формы без окна; новая публикация — не смена', () => {
    const planner = new CodecPlanner(clock().now);
    const sw: PlanInput = {
      ...rtx40,
      probe: probe(['vp9', 'L1T3', 'sw'], ['h264', 'L1T1', 'sw']),
      gpu: null,
    };
    expect(planner.plan('camera', sw, true).codec).toBe('vp9');
    expect(planner.takeSwitches()).toEqual([]);
    const big = { ...sw, level: { width: 1920, height: 1080, fps: 30, bitrate: 6_000_000 } };
    expect(planner.plan('camera', big, false).codec).toBe('h264');
    expect(planner.takeSwitches()).toEqual([{ source: 'camera', from: 'vp9', to: 'h264', reason: 'level' }]);
    planner.stop('camera');
    expect(planner.info('camera')).toBeNull();
    expect(planner.observe('camera', cpu).kind).toBe('none');
  });
});
