import { describe, expect, it } from 'vitest';
import { fitSource, screenOptions } from './profiles';

describe('screen profiles', () => {
  it('preserves portrait, ultrawide and conventional source geometry', () => {
    expect(fitSource(1080, 1920, 720)).toEqual({ width: 720, height: 1280 });
    expect(fitSource(5120, 1440, 1440)).toEqual({ width: 2560, height: 720 });
    expect(fitSource(3840, 2160, 1440)).toEqual({ width: 2560, height: 1440 });
    expect(fitSource(640, 480, 1080)).toEqual({ width: 640, height: 480 });
  });
  it('keeps text sharp and offers a compatible backup for advanced codecs', () => {
    const options = screenOptions({ resolution: 1440, fps: 60, mode: 'text', automatic: false }, 'av1');
    expect(options.screenShareEncoding?.maxBitrate).toBe(16000000);
    expect(options.backupCodec).toEqual({ codec: 'vp8' });
    expect(options.degradationPreference).toBe('maintain-resolution');
  });
});
