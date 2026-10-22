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
  expect(readPreferences().screen).toMatchObject({ resolution: 1080, fps: 60 });
  expect(JSON.parse(localStorage.getItem('cord:preferences:v1')!)).toEqual(saved);
  // Сервер, который разрешает 1440p, возвращает выбор человека сам.
  localStorage.setItem(
    'cord:quality:v1',
    JSON.stringify({
      default: { resolution: 720, fps: 30 },
      ceiling: { resolution: 1440, fps: 60 },
      settleMs: 4000,
    }),
  );
  expect(readPreferences().screen).toMatchObject({ resolution: 1440, fps: 60 });
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

it('overlay hotkey (E01-B2): unassigned by default, a valid one is kept, a broken one is dropped', () => {
  expect(readPreferences().overlayHotkey).toBeNull();
  const key = { code: 'KeyO', ctrl: true, alt: false, shift: true, meta: false };
  savePreferences({ overlayHotkey: key });
  expect(readPreferences().overlayHotkey).toEqual(key);
  localStorage.setItem('cord:preferences:v1', JSON.stringify({ overlayHotkey: { code: 'Escape' } }));
  expect(readPreferences().overlayHotkey).toBeNull();
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
  expect(readPreferences()).toMatchObject({ ...before, outputVolume: 100 });
  savePreferences({ outputVolume: 35 });
  expect(readPreferences()).toMatchObject({ ...before, outputVolume: 35 });
  localStorage.setItem('cord:preferences:v1', JSON.stringify({ outputVolume: 400 }));
  expect(readPreferences()).toMatchObject({ outputVolume: 100 });
});

it('забывает убранные настройки — режим сети, приём, уступку камеры — без ошибок и без следа (R06/R08)', () => {
  localStorage.setItem(
    'cord:preferences:v1',
    JSON.stringify({ network: 'stable', reception: 'best', cameraYieldsToScreen: true, outputVolume: 50 }),
  );
  const read = readPreferences() as unknown as Record<string, unknown>;
  expect(read.outputVolume).toBe(50);
  expect('network' in read).toBe(false);
  expect('reception' in read).toBe(false);
  expect('cameraYieldsToScreen' in read).toBe(false);
  savePreferences({ outputVolume: 60 });
  const stored = JSON.parse(localStorage.getItem('cord:preferences:v1')!) as Record<string, unknown>;
  expect('network' in stored).toBe(false);
  expect('cameraYieldsToScreen' in stored).toBe(false);
});

/**
 * Приём и отдача — разные решения. Раньше второе задавалось первым: выставил уровень камеры
 * руками, и вместе с ним выключалась адаптация приёма. Теперь у приёма своя память.
 */

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

it('помнит прошлый выбор площадки у музыки и кинозала — только имя площадки (T59)', () => {
  expect(readPreferences().lastPlatform).toEqual({});
  savePreferences({ lastPlatform: { music: 'soundcloud', cinema: 'rutube' } });
  expect(readPreferences().lastPlatform).toEqual({ music: 'soundcloud', cinema: 'rutube' });
  localStorage.setItem(
    'cord:preferences:v1',
    JSON.stringify({ lastPlatform: { music: '<script>', cinema: 42, games: 'poker' } }),
  );
  expect(readPreferences().lastPlatform).toEqual({});
  localStorage.setItem('cord:preferences:v1', JSON.stringify({ lastPlatform: 'youtube' }));
  expect(readPreferences().lastPlatform).toEqual({});
});

it('показ помнит режим и превью (R95/R80): старые записи — «плавность» и превью есть, уровень без них их не стирает', () => {
  localStorage.setItem('cord:preferences:v1', JSON.stringify({ screen: { resolution: 1080, fps: 30 } }));
  expect(readPreferences().screen).toMatchObject({
    resolution: 1080,
    fps: 30,
    mode: 'smooth',
    preview: true,
  });
  savePreferences({ screen: { resolution: 1080, fps: 30, mode: 'sharp', preview: false } });
  expect(readPreferences().screen).toMatchObject({ mode: 'sharp', preview: false });
  // Ряд качества знает только кадр и частоту — режим и превью остаются.
  savePreferences({ screen: { resolution: 720, fps: 60 } });
  expect(readPreferences().screen).toMatchObject({ resolution: 720, fps: 60, mode: 'sharp', preview: false });
  localStorage.setItem(
    'cord:preferences:v1',
    JSON.stringify({ screen: { resolution: 1080, fps: 30, mode: 'blurry' } }),
  );
  expect(readPreferences().screen.mode).toBe('smooth');
});
