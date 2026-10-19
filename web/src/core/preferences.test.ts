import { beforeEach, expect, it } from 'vitest';
import { readPreferences, savePreferences } from './preferences';
beforeEach(() => localStorage.clear());
it('persists independent camera and screen profiles and discards invalid cached values', () => {
  // Умолчание — с сервера (здесь встроенное 720p30): «Авто» больше нет.
  expect(readPreferences().camera).toEqual({ resolution: 720, fps: 30 });
  savePreferences({ screen: { resolution: 1080, fps: 60 } });
  expect(readPreferences().screen.fps).toBe(60);
  expect(readPreferences().camera.resolution).toBe(720);
  localStorage.setItem(
    'cord:preferences:v1',
    JSON.stringify({ camera: { resolution: 9999, fps: -1 }, devices: { microphone: 42 } }),
  );
  expect(readPreferences().camera.fps).toBe(30);
  expect(readPreferences().devices).toEqual({});
});

/**
 * Старые записи: «Авто» и 1440p. Первое — уровень по умолчанию с сервера, второе — потолок.
 * Сама запись не переписывается: другой сервер может разрешать больше.
 */
it('мигрирует сохранённые «Авто» и 1440p к ближайшему допустимому уровню, не трогая запись', () => {
  const saved = {
    camera: { resolution: 1080, fps: 30, automatic: true },
    screen: { resolution: 1440, fps: 60, automatic: false },
  };
  localStorage.setItem('cord:preferences:v1', JSON.stringify(saved));
  expect(readPreferences().camera).toEqual({ resolution: 720, fps: 30 });
  expect(readPreferences().screen).toEqual({ resolution: 1080, fps: 60 });
  expect(JSON.parse(localStorage.getItem('cord:preferences:v1')!)).toEqual(saved);
  // Сервер, который разрешает 1440p, возвращает выбор человека сам.
  localStorage.setItem(
    'cord:quality:v1',
    JSON.stringify({
      default: { resolution: 720, fps: 30 },
      ceiling: { resolution: 1440, fps: 60 },
      settleMs: 4000,
      cameraYieldsToScreen: false,
    }),
  );
  expect(readPreferences().screen).toEqual({ resolution: 1440, fps: 60 });
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

/**
 * E03: громкость собеседников и «камера уступает показу» — новые ключи той же записи. Запись,
 * сохранённая до них, читается целиком как была: новые поля берут умолчания, старые не теряются.
 */
it('читает запись до E03 без потерь и даёт новым полям безопасные умолчания', () => {
  const before = {
    showPing: true,
    soundVolume: 40,
    micHotkey: { code: 'KeyJ', ctrl: true, alt: false, shift: false, meta: false },
    audio: { suppression: 'rnnoise', echoCancellation: false, autoGainControl: false, gain: 1.5 },
    yandexMusicToken: 'kept-token',
  };
  localStorage.setItem('cord:preferences:v1', JSON.stringify(before));
  expect(readPreferences()).toMatchObject({
    ...before,
    outputVolume: 100,
    cameraYieldsToScreen: false,
  });
  savePreferences({ outputVolume: 35, cameraYieldsToScreen: true });
  expect(readPreferences()).toMatchObject({ ...before, outputVolume: 35, cameraYieldsToScreen: true });
  localStorage.setItem(
    'cord:preferences:v1',
    JSON.stringify({ outputVolume: 400, cameraYieldsToScreen: 'yes' }),
  );
  expect(readPreferences()).toMatchObject({ outputVolume: 100, cameraYieldsToScreen: false });
});

it('keeps the network mode automatic until asked otherwise, and rejects an unknown one', () => {
  expect(readPreferences().network).toBe('auto');
  savePreferences({ network: 'stable' });
  expect(readPreferences().network).toBe('stable');
  localStorage.setItem('cord:preferences:v1', JSON.stringify({ network: 'as-fast-as-possible' }));
  expect(readPreferences().network).toBe('auto');
});

/**
 * Приём и отдача — разные решения. Раньше второе задавалось первым: выставил уровень камеры
 * руками, и вместе с ним выключалась адаптация приёма. Теперь у приёма своя память.
 */
it('помнит качество приёма отдельно от качества отдачи', () => {
  expect(readPreferences().reception).toBe('fit');
  savePreferences({ camera: { resolution: 1080, fps: 60 } });
  expect(readPreferences().reception).toBe('fit');
  savePreferences({ reception: 'best' });
  expect(readPreferences().reception).toBe('best');
  expect(readPreferences().camera).toEqual({ resolution: 1080, fps: 60 });
  localStorage.setItem('cord:preferences:v1', JSON.stringify({ reception: 'как можно лучше' }));
  expect(readPreferences().reception).toBe('fit');
});

it('stores the integration roster choice and Yandex token for this browser profile', () => {
  savePreferences({ showIntegrationPanel: false, yandexMusicToken: 'saved-yandex-token' });
  expect(readPreferences()).toMatchObject({
    showIntegrationPanel: false,
    yandexMusicToken: 'saved-yandex-token',
  });
});

it('помнит недавние ссылки кинозала — только ссылки на страницы и не больше десяти', () => {
  expect(readPreferences().cinemaLinks).toEqual([]);
  savePreferences({ cinemaLinks: ['https://youtu.be/dQw4w9WgXcQ'] });
  expect(readPreferences().cinemaLinks).toEqual(['https://youtu.be/dQw4w9WgXcQ']);
  const many = Array.from({ length: 14 }, (_, index) => `https://example.com/${index}`);
  localStorage.setItem(
    'cord:preferences:v1',
    JSON.stringify({
      cinemaLinks: ['javascript:alert(1)', 42, `https://example.com/${'a'.repeat(2000)}`, ...many],
    }),
  );
  expect(readPreferences().cinemaLinks).toEqual(many.slice(0, 10));
  localStorage.setItem('cord:preferences:v1', JSON.stringify({ cinemaLinks: 'https://youtu.be/x' }));
  expect(readPreferences().cinemaLinks).toEqual([]);
});
