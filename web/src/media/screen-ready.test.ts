import { describe, expect, it } from 'vitest';
import { readScreenSample, ScreenReadiness } from './screen-ready';

const target = { width: 1920, height: 1080 };

describe('когда показ можно открывать зрителям', () => {
  it('готов, как только верхний слой закодировал кадр целевого размера', () => {
    const ready = new ScreenReadiness(target, 4000, 0);
    expect(ready.observe(null, 100)).toBe('waiting');
    expect(ready.observe({ width: 960, height: 540, framesEncoded: 12 }, 500)).toBe('waiting');
    expect(ready.observe({ width: 1920, height: 1080, framesEncoded: 0 }, 900)).toBe('waiting');
    expect(ready.observe({ width: 1920, height: 1080, framesEncoded: 1 }, 1200)).toBe('ready');
  });

  it('выравнивание кодировщика — не разгон: 1072 вместо 1080 считается готовым', () => {
    const ready = new ScreenReadiness(target, 4000, 0);
    expect(ready.observe({ width: 1904, height: 1072, framesEncoded: 3 }, 300)).toBe('ready');
  });

  it('по истечении окна открывает то, что есть', () => {
    const ready = new ScreenReadiness(target, 4000, 1000);
    expect(ready.observe({ width: 640, height: 360, framesEncoded: 50 }, 4999)).toBe('waiting');
    expect(ready.observe({ width: 640, height: 360, framesEncoded: 60 }, 5000)).toBe('expired');
    expect(ready.observe(null, 9000)).toBe('expired');
  });

  it('из отчёта берёт самый крупный кодируемый слой', () => {
    const report = new Map<string, Record<string, unknown>>([
      ['q', { type: 'outbound-rtp', kind: 'video', frameWidth: 480, frameHeight: 270, framesEncoded: 40 }],
      ['f', { type: 'outbound-rtp', kind: 'video', frameWidth: 1920, frameHeight: 1080, framesEncoded: 2 }],
      ['a', { type: 'outbound-rtp', kind: 'audio' }],
      ['t', { type: 'transport' }],
    ]) as unknown as RTCStatsReport;
    expect(readScreenSample(report)).toEqual({ width: 1920, height: 1080, framesEncoded: 2 });
    expect(readScreenSample(new Map() as unknown as RTCStatsReport)).toBeNull();
  });
});
