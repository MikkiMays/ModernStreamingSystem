import { describe, expect, it } from 'vitest';
import {
  cameraOptions,
  companionCameraCapture,
  companionCameraOptions,
  fitSource,
  screenOptions,
} from './profiles';

describe('screen profiles', () => {
  it('preserves portrait, ultrawide and conventional source geometry', () => {
    expect(fitSource(1080, 1920, 720)).toEqual({ width: 720, height: 1280 });
    expect(fitSource(5120, 1440, 1440)).toEqual({ width: 2560, height: 720 });
    expect(fitSource(3840, 2160, 1440)).toEqual({ width: 2560, height: 1440 });
    expect(fitSource(640, 480, 1080)).toEqual({ width: 640, height: 480 });
  });
  it('sends a chosen level as one layer so nobody is handed a smaller copy', () => {
    const options = screenOptions({ resolution: 1440, fps: 60, automatic: false }, 'av1');
    expect(options.screenShareEncoding?.maxBitrate).toBe(16000000);
    expect(options.screenShareEncoding?.maxFramerate).toBe(60);
    expect(options.backupCodec).toEqual({ codec: 'vp8' });
    expect(options.simulcast).toBe(false);
    expect(options.screenShareSimulcastLayers).toBeUndefined();
    expect(options.degradationPreference).toBe('maintain-framerate');
  });
  it('keeps the smaller layers when quality is automatic', () => {
    const options = screenOptions({ resolution: 1080, fps: 30, automatic: true }, 'vp8');
    expect(options.simulcast).toBe(true);
    expect(options.screenShareSimulcastLayers?.length).toBeGreaterThan(0);
    expect(options.degradationPreference).toBe('balanced');
  });
  it('applies the same rule to the camera', () => {
    expect(cameraOptions({ resolution: 1080, fps: 60, automatic: false }).simulcast).toBe(false);
    expect(cameraOptions({ resolution: 1080, fps: 60, automatic: true }).simulcast).toBe(true);
  });
  it('камера рядом с показом идёт одним слоем и заметно дешевле самой скромной обычной', () => {
    const companion = companionCameraOptions();
    const smallest = cameraOptions({ resolution: 720, fps: 15, automatic: true });
    expect(companion.simulcast).toBe(false);
    expect(companion.videoSimulcastLayers).toBeUndefined();
    expect(companion.videoEncoding!.maxBitrate).toBeLessThan(smallest.videoEncoding!.maxBitrate!);
    expect(companionCameraCapture().resolution.height).toBe(360);
  });
});
