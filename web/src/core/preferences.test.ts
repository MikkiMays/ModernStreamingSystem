import { beforeEach, expect, it } from 'vitest';
import { readPreferences, savePreferences } from './preferences';
beforeEach(() => localStorage.clear());
it('persists independent camera and screen profiles and discards invalid cached values', () => {
  expect(readPreferences().camera.automatic).toBe(true);
  savePreferences({
    screen: { resolution: 1440, fps: 60, automatic: false, automaticFps: false, mode: 'motion' },
  });
  expect(readPreferences().screen.fps).toBe(60);
  expect(readPreferences().camera.resolution).toBe(720);
  localStorage.setItem(
    'cord:preferences:v1',
    JSON.stringify({ camera: { resolution: 9999, fps: -1 }, devices: { microphone: 42 } }),
  );
  expect(readPreferences().camera.fps).toBe(30);
  expect(readPreferences().devices).toEqual({});
});
