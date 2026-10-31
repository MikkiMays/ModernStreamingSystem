import { describe, expect, it } from 'vitest';
import {
  EncoderHealth,
  readUpstream,
  softwareEncoder,
  upstreamDelta,
  type EncoderSample,
  type HealthContext,
} from './encoder-health';

const sample = (patch: Partial<EncoderSample> = {}): EncoderSample => ({
  limitation: 'none',
  encodeMs: 4,
  targetFps: 30,
  software: false,
  ...patch,
});
const hardware: HealthContext = { expectHw: true, lowest: false, restorable: false };
const fellBack: HealthContext = { expectHw: true, lowest: false, restorable: true };

describe('сторож кодировщика', () => {
  it('отступает после трёх жалоб на процессор подряд; спокойный замер начинает счёт заново', () => {
    const h = new EncoderHealth();
    expect(h.observe(sample({ limitation: 'cpu' }), hardware).verdict).toBe('none');
    expect(h.observe(sample(), hardware).verdict).toBe('none');
    expect(h.observe(sample({ limitation: 'cpu' }), hardware).verdict).toBe('none');
    expect(h.observe(sample({ limitation: 'cpu' }), hardware).verdict).toBe('none');
    expect(h.observe(sample({ limitation: 'cpu' }), hardware)).toEqual({
      verdict: 'fallback',
      reason: 'cpu',
    });
  });

  it('молчание Safari (`unknown`) не сбрасывает и не копит жалобы', () => {
    const h = new EncoderHealth();
    h.observe(sample({ limitation: 'cpu' }), hardware);
    h.observe(sample({ limitation: 'unknown', encodeMs: null }), hardware);
    h.observe(sample({ limitation: 'cpu' }), hardware);
    expect(h.observe(sample({ limitation: 'cpu' }), hardware).verdict).toBe('fallback');
  });

  it('время кадра больше 0,8 бюджета три раза подряд — отступ раньше, чем Chromium скажет `cpu`', () => {
    const h = new EncoderHealth();
    // 60 fps: бюджет 16,7 мс, порог 13,3 мс.
    const slow = sample({ targetFps: 60, encodeMs: 14 });
    expect(h.observe(slow, hardware).verdict).toBe('none');
    expect(h.observe(slow, hardware).verdict).toBe('none');
    expect(h.observe(slow, hardware)).toEqual({ verdict: 'fallback', reason: 'encode-time' });
    // 13 мс при 60 fps — в бюджете.
    const ok = new EncoderHealth();
    for (let i = 0; i < 5; i++)
      expect(ok.observe(sample({ targetFps: 60, encodeMs: 13 }), hardware).verdict).toBe('none');
  });

  it('ждали железо, а кодирует процессор — отступ после двух замеров; программную ступень это не трогает', () => {
    const h = new EncoderHealth();
    expect(h.observe(sample({ software: true }), hardware).verdict).toBe('none');
    expect(h.observe(sample({ software: true }), hardware)).toEqual({
      verdict: 'fallback',
      reason: 'software',
    });
    const sw = new EncoderHealth();
    for (let i = 0; i < 5; i++)
      expect(sw.observe(sample({ software: true }), { ...hardware, expectHw: false }).verdict).toBe('none');
  });

  it('на программном H.264 при `cpu` — подсказка стримеру, а не понижение', () => {
    const h = new EncoderHealth();
    const lowest: HealthContext = { expectHw: false, lowest: true, restorable: false };
    h.observe(sample({ limitation: 'cpu', software: true }), lowest);
    h.observe(sample({ limitation: 'cpu', software: true }), lowest);
    expect(h.observe(sample({ limitation: 'cpu', software: true }), lowest)).toEqual({
      verdict: 'hint',
      reason: 'cpu',
    });
    expect(h.loadFalls).toBe(0);
  });

  it('возвращается через 4 спокойных замера, каждый следующий раз вдвое терпеливее, после трёх — остаётся', () => {
    const h = new EncoderHealth();
    const fall = () => {
      let verdict = 'none';
      for (let i = 0; i < 3; i++) verdict = h.observe(sample({ limitation: 'cpu' }), hardware).verdict;
      return verdict;
    };
    const calm = (n: number) => {
      let verdict = 'none';
      for (let i = 0; i < n; i++) verdict = h.observe(sample({ limitation: 'bandwidth' }), fellBack).verdict;
      return verdict;
    };
    expect(fall()).toBe('fallback');
    expect(calm(3)).toBe('none');
    expect(calm(1)).toBe('restore');
    expect(fall()).toBe('fallback');
    expect(calm(7)).toBe('none');
    expect(calm(1)).toBe('restore');
    // Новый кодировщик после переопубликации: подряд — заново, но число отступов помнится.
    h.restart();
    expect(fall()).toBe('fallback');
    expect(calm(30)).toBe('none');
    expect(h.loadFalls).toBe(3);
  });

  it('без отступа из-за нагрузки возвращаться некуда', () => {
    const h = new EncoderHealth();
    for (let i = 0; i < 10; i++) expect(h.observe(sample(), hardware).verdict).toBe('none');
  });
});

describe('программный кодировщик по статистике', () => {
  it('сначала `powerEfficientEncoder`, потом имя', () => {
    expect(softwareEncoder({ powerEfficientEncoder: true, encoderImplementation: 'libvpx' })).toBe(false);
    expect(softwareEncoder({ powerEfficientEncoder: false })).toBe(true);
    expect(softwareEncoder({ encoderImplementation: 'SimulcastEncoderAdapter (libvpx, libvpx)' })).toBe(true);
    expect(softwareEncoder({ encoderImplementation: 'OpenH264' })).toBe(true);
    expect(softwareEncoder({ encoderImplementation: 'libaom' })).toBe(true);
    expect(
      softwareEncoder({
        encoderImplementation: 'MediaFoundationVideoEncodeAccelerator (NVIDIA AV1 Encoder MFT)',
      }),
    ).toBe(false);
    expect(softwareEncoder({})).toBeNull();
  });
});

/** Отчёт `getStats` своей видеодорожки: слои и кодек. */
function report(layers: Record<string, unknown>[], codec: Record<string, unknown> = {}) {
  return new Map<string, Record<string, unknown>>([
    ...layers.map(
      (layer, index) =>
        [
          `OT${index}`,
          { id: `OT${index}`, type: 'outbound-rtp', kind: 'video', codecId: 'C1', timestamp: 1000, ...layer },
        ] as [string, Record<string, unknown>],
    ),
    [
      'C1',
      {
        id: 'C1',
        type: 'codec',
        mimeType: 'video/AV1',
        sdpFmtpLine: 'level-idx=5;profile=0;tier=0',
        ...codec,
      },
    ],
  ]) as unknown as RTCStatsReport;
}

describe('отчёт отдачи', () => {
  it('самый крупный слой — «что мы отдаём»; кодек, профиль, слои и железо — его', () => {
    const reading = readUpstream(
      report([
        { frameWidth: 320, frameHeight: 180, bytesSent: 100, qualityLimitationReason: 'none' },
        {
          frameWidth: 1280,
          frameHeight: 720,
          framesPerSecond: 30,
          bytesSent: 900,
          qualityLimitationReason: 'bandwidth',
          scalabilityMode: 'L1T3',
          encoderImplementation: 'MediaFoundationVideoEncodeAccelerator (NVIDIA AV1 Encoder MFT)',
          powerEfficientEncoder: true,
          totalEncodeTime: 1.5,
          framesEncoded: 300,
          qualityLimitationDurations: { none: 8, cpu: 0, bandwidth: 2, other: 0 },
        },
      ]),
    );
    expect(reading).toMatchObject({
      width: 1280,
      height: 720,
      fps: 30,
      bytes: 1000,
      limitation: 'bandwidth',
      layers: 2,
    });
    expect(reading.top).toMatchObject({
      id: 'OT1',
      mime: 'video/AV1',
      fmtp: 'level-idx=5;profile=0;tier=0',
      scalabilityMode: 'L1T3',
      software: false,
      encodeTime: 1.5,
      frames: 300,
      limits: { cpu: 0, bandwidth: 2, other: 0 },
    });
    // Safari причину не называет.
    expect(readUpstream(report([{ frameWidth: 640 }])).limitation).toBe('unknown');
    expect(readUpstream(undefined)).toMatchObject({ layers: 0, top: null, limitation: 'none' });
  });

  it('разности: мс на кадр, секунды ограничений; другой верхний слой — счётчики заново', () => {
    const at = (timestamp: number, encodeTime: number, frames: number, cpu: number, id = 'OT0') =>
      readUpstream(
        report([
          {
            id,
            timestamp,
            frameWidth: 1920,
            bytesSent: timestamp * 100,
            totalEncodeTime: encodeTime,
            framesEncoded: frames,
            qualityLimitationDurations: { cpu, bandwidth: 0, other: 0 },
          },
        ]),
      );
    const first = at(1000, 1, 100, 0);
    const second = at(4000, 2.2, 190, 2.5);
    expect(upstreamDelta(undefined, first)).toMatchObject({ seconds: 0, encodeMs: null });
    const delta = upstreamDelta(first, second);
    expect(delta.seconds).toBe(3);
    expect(delta.bytes).toBe(300_000);
    expect(delta.encodeMs).toBeCloseTo((1.2 * 1000) / 90);
    expect(delta.limited).toEqual({ cpu: 2.5, bandwidth: 0, other: 0 });
    const republished = upstreamDelta(second, at(7000, 0.1, 10, 0, 'OT9'));
    expect(republished).toMatchObject({
      seconds: 3,
      encodeMs: null,
      limited: { cpu: 0, bandwidth: 0, other: 0 },
    });
  });
});
