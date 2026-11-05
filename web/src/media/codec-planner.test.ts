import { describe, expect, it } from 'vitest';
import { CodecPlanner, type PlanInput } from './codec-planner';
import { memoryScope, type CodecMemory } from './codec-memory';
import { probeKey, type Codec, type FailReason, type ProbeAnswers, type Scalability } from './codec-policy';
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
/** Память машины без хранилища: что записали, то и отдаёт. */
function memory(): CodecMemory & { entries: Map<string, FailReason> } {
  const entries = new Map<string, FailReason>();
  return {
    entries,
    failed: () => new Map(entries),
    remember: (_source, _scope, _level, rung, reason) => void entries.set(rung, reason),
  };
}
function feed(planner: CodecPlanner, source: 'camera' | 'screen', sample: EncoderSample, times: number) {
  let last = planner.observe(source, sample);
  for (let i = 1; i < times; i++) last = planner.observe(source, sample);
  return last;
}

describe('планировщик кодеков', () => {
  it('камера: перегрузка — запись в память машины, не смена посреди потока; память действует при следующем старте', () => {
    const time = clock();
    const remembered = memory();
    const planner = new CodecPlanner(time.now, remembered);
    expect(planner.plan('camera', rtx40, true).codec).toBe('av1');
    expect(feed(planner, 'camera', cpu, 3).kind).toBe('none');
    expect(remembered.entries.get('av1:hw')).toBe('cpu');
    expect(planner.takeSwitches()).toEqual([]);
    expect(planner.current('camera')?.codec).toBe('av1');
    expect(planner.info('camera')).toMatchObject({ fallbacks: 1, switches: 0, pending: false });
    time.advance(60_000);
    // Сколько бы ни жаловался кодировщик дальше — камера та же.
    expect(feed(planner, 'camera', cpu, 30).kind).toBe('none');
    // Камеру включили заново — память отвергает AV1, старт сразу с H.265; это не «смена».
    const fresh = new CodecPlanner(time.now, remembered);
    expect(fresh.plan('camera', rtx40, true)).toMatchObject({ codec: 'h265', reason: 'fallback' });
    expect(fresh.takeSwitches()).toEqual([]);
    expect(memoryScope(rtx40.gpu)).toContain('|');
  });

  it('камера: спокойные замеры ничего не возвращают — возврат только через срок памяти', () => {
    const time = clock();
    const planner = new CodecPlanner(time.now, memory());
    planner.plan('camera', rtx40, true);
    feed(planner, 'camera', cpu, 3);
    time.advance(5 * 60_000);
    expect(feed(planner, 'camera', calm, 40).kind).toBe('none');
    planner.reconnected();
    expect(feed(planner, 'camera', calm, 40).kind).toBe('none');
    expect(planner.takeSwitches()).toEqual([]);
  });

  it('показ: один отступ за показ, без возврата; второй показ может отступить снова', () => {
    const time = clock();
    const planner = new CodecPlanner(time.now, memory());
    planner.plan('screen', { ...rtx40, source: 'screen-smooth' }, true);
    const first = feed(planner, 'screen', cpu, 3);
    expect(first).toMatchObject({ kind: 'switch', from: 'av1', reason: 'cpu' });
    expect(first.kind === 'switch' && first.decision.codec).toBe('h265');
    expect(planner.takeSwitches()).toEqual([{ source: 'screen', from: 'av1', to: 'h265', reason: 'cpu' }]);
    time.advance(60_000);
    expect(feed(planner, 'screen', cpu, 3).kind).toBe('none');
    expect(planner.info('screen')).toMatchObject({ fallbacks: 2, switches: 1 });
    expect(feed(planner, 'screen', cpu, 3).kind).toBe('none');
    time.advance(60_000);
    expect(feed(planner, 'screen', calm, 40).kind).toBe('none');
    expect(planner.current('screen')?.codec).toBe('h265');
    // Новый показ — память машины уже знает про AV1 и H.265: старт с H.264, один отступ снова доступен.
    planner.stop('screen');
    expect(planner.plan('screen', { ...rtx40, source: 'screen-smooth' }, true).codec).toBe('h264');
  });

  it('аппаратный AV1 оказался программным — в память, камера доживает поток на нём', () => {
    const time = clock();
    const remembered = memory();
    const planner = new CodecPlanner(time.now, remembered);
    planner.plan('camera', rtx40, true);
    const sw = { ...calm, software: true };
    expect(planner.observe('camera', sw).kind).toBe('none');
    expect(planner.observe('camera', sw).kind).toBe('none');
    expect(remembered.entries.get('av1:hw')).toBe('software');
    expect(planner.current('camera')?.codec).toBe('av1');
    expect(new CodecPlanner(time.now, remembered).plan('camera', rtx40, true).codec).toBe('h265');
  });

  it('программный H.264 при `cpu` — подсказка в журнал, не чаще раза в 5 минут; кадр и кодек те же', () => {
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
    const planner = new CodecPlanner(clock().now, memory());
    planner.plan('camera', rtx40, true);
    planner.plan('screen', { ...rtx40, source: 'screen-smooth' }, true);
    expect(feed(planner, 'screen', cpu, 3).kind).toBe('switch');
    expect(planner.current('camera')?.codec).toBe('av1');
    expect(planner.info('camera')?.fallbacks).toBe(0);
  });

  it('зрители: камера посреди потока не меняется — состав учтётся при следующем старте; показ меняется', () => {
    const time = clock();
    const planner = new CodecPlanner(time.now);
    const tight: PlanInput = { ...rtx40, cores: 4, gpu: { vendors: ['nvidia'], source: 'shell' } };
    planner.plan('camera', tight, true);
    planner.plan('screen', { ...tight, source: 'screen-smooth' }, true);
    expect(planner.current('camera')?.codec).toBe('av1');
    const safari: Codec[] = ['h265', 'h264', 'vp9', 'vp8'];
    const actions = planner.setViewers([safari]);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: 'switch', source: 'screen', reason: 'viewers', from: 'av1' });
    expect(planner.current('camera')?.codec).toBe('av1');
    expect(planner.setViewers([safari])).toEqual([]);
    time.advance(60_000);
    expect(feed(planner, 'camera', calm, 5).kind).toBe('none');
    // Следующее включение камеры — с учётом зрителя.
    expect(planner.plan('camera', tight, true).codec).toBe('h265');
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
