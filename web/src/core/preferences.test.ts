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

it('migrates the display name and validates stored audio and hotkeys', () => {
  localStorage.setItem('cord:name', 'Saved name');
  expect(readPreferences().name).toBe('Saved name');
  localStorage.setItem(
    'cord:preferences:v1',
    JSON.stringify({
      audio: { gain: -5, suppression: 'invalid' },
      micHotkey: { code: 'Escape' },
      showIntegrationPanel: 'no',
      yandexMusicToken: 123,
    }),
  );
  expect(readPreferences().audio).toMatchObject({ gain: 0, suppression: 'browser', echoCancellation: true });
  expect(readPreferences().micHotkey?.code).toBe('KeyM');
  expect(readPreferences().showIntegrationPanel).toBe(true);
  expect(readPreferences().yandexMusicToken).toBe('');
  savePreferences({ name: 'New name', micHotkey: null });
  expect(readPreferences().name).toBe('New name');
  expect(localStorage.getItem('cord:name')).toBe('New name');
  expect(readPreferences().micHotkey).toBeNull();
});

it('defaults to silent PING display and enabled notifications, then saves both independently', () => {
  expect(readPreferences()).toMatchObject({
    showPing: false,
    notificationSounds: true,
    showIntegrationPanel: true,
    yandexMusicToken: '',
  });
  savePreferences({ showPing: true, notificationSounds: false });
  expect(readPreferences()).toMatchObject({ showPing: true, notificationSounds: false });
  expect(readPreferences()).toMatchObject({
    showIntegrationPanel: true,
    yandexMusicToken: '',
  });
});

it('stores the integration roster choice and Yandex token for this browser profile', () => {
  savePreferences({ showIntegrationPanel: false, yandexMusicToken: 'saved-yandex-token' });
  expect(readPreferences()).toMatchObject({
    showIntegrationPanel: false,
    yandexMusicToken: 'saved-yandex-token',
  });
});
