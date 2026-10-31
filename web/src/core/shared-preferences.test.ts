// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readPreferences, savePreferences, type Preferences } from './preferences';
import {
  acceptCarriedPreferences,
  changedShared,
  chunkEntries,
  DEVICE_KEY,
  labelsOf,
  LOCAL_KEYS,
  PER_SERVER_STORAGE,
  prefsFragment,
  resetSharedPreferences,
  resolveDevices,
  SECRET_KEYS,
  SHARED_KEYS,
  sharedValues,
  startSharedPreferences,
  takePrefsFragment,
} from './shared-preferences';

/*
  R146, Р-39: настройки общие для всех серверов, у сервера свои — только комнаты. Клиент Windows
  хранит общее у оболочки (флаг prefs.shared), браузер несёт несекретное во фрагменте адреса при
  «Сменить сервер». Устройства — по названию: deviceId у каждого origin свой.
*/

const TOKEN = 'y0_AgAAAAB1-secret';
const device = (kind: MediaDeviceKind, deviceId: string, label: string) => ({
  kind,
  deviceId,
  label,
  groupId: '',
});

function fakeDesktop(features: string[], bootstrap: Record<string, unknown> = {}) {
  const listeners = new Map<string, Set<(data: Record<string, unknown>) => void>>();
  const api = {
    protocol: { major: 2, minor: 1 },
    features,
    app: { version: '1.1.0', arch: 'x64' },
    bootstrap: {
      profile: 'x'.repeat(43),
      theme: 'system',
      language: null,
      showPing: false,
      notificationSounds: true,
      autoConnect: true,
      shared: {},
      yandexMusicToken: null,
      ...bootstrap,
    },
    send: vi.fn(),
    invoke: vi.fn(async () => null),
    on: vi.fn((type: string, listener: (data: Record<string, unknown>) => void) => {
      let set = listeners.get(type);
      if (!set) listeners.set(type, (set = new Set()));
      set.add(listener);
      return () => void set?.delete(listener);
    }),
    emit(type: string, data: Record<string, unknown>) {
      for (const listener of listeners.get(type) ?? []) listener(data);
    },
  };
  (window as unknown as { cordDesktop?: unknown }).cordDesktop = api;
  return api;
}
const sent = (api: ReturnType<typeof fakeDesktop>) =>
  api.send.mock.calls
    .filter(([type]) => type === 'preferences.changed')
    .map(([, payload]) => payload as Record<string, unknown>);

function mockDevices(list: ReturnType<typeof device>[]) {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      enumerateDevices: vi.fn(async () => list),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
}

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, '', '/');
});
afterEach(() => {
  resetSharedPreferences();
  vi.useRealTimers();
  delete (window as unknown as { cordDesktop?: unknown }).cordDesktop;
  delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
});

describe('что общее, а что у сервера своё (R146)', () => {
  it('каждое поле настроек в одном списке: общие, секрет, устройства по названию или своё', () => {
    const lists = [...SHARED_KEYS, ...SECRET_KEYS, DEVICE_KEY, ...LOCAL_KEYS];
    expect(new Set(lists).size).toBe(lists.length);
    expect([...lists].sort()).toEqual(Object.keys(readPreferences()).sort());
  });

  it('общие — всё человека и устройства, как велел владелец; токен — секрет', () => {
    expect(SHARED_KEYS).toEqual(
      expect.arrayContaining([
        'language',
        'name',
        'avatar',
        'audio',
        'micHotkey',
        'deafened',
        'screen',
        'camera',
        'showPing',
      ]),
    );
    expect(SECRET_KEYS).toEqual(['yandexMusicToken']);
    expect(SHARED_KEYS).not.toContain('yandexMusicToken');
  });

  it('свои у сервера: избранное, автовход, недавние, сессия, пароль сервера, громкости участников, кеш, вход владельца, встреча', () => {
    expect(PER_SERVER_STORAGE).toEqual(
      expect.arrayContaining([
        'cord:favorites:v1',
        'cord:autojoin:v1',
        'cord:recent:v1',
        'cord:session:v1',
        'cord:servers:v1',
        'cord:volumes:v1',
        'cord:quality:v1',
        'cord:admin:v1',
        'cord:active-meeting',
      ]),
    );
  });
});

describe('изменилось ли общее (R146)', () => {
  it('качество выше потолка этого сервера — не изменение: желаемое другого сервера не «зажимается»', () => {
    // Потолок этого сервера — 1080p60 (встроенный), у оболочки — 1440p60 с другого сервера.
    const known = { screen: { resolution: 1440, fps: 60, mode: 'sharp', preview: true, audio: 'none' } };
    localStorage.setItem('cord:preferences:v1', JSON.stringify(known));
    const before = readPreferences();
    expect(before.screen.resolution).toBe(1080);
    savePreferences({ outputVolume: 50 });
    expect(changedShared(before, readPreferences(), known)).toEqual({ outputVolume: 50 });
    // Выбрал меньше потолка сам — это изменение.
    const was = readPreferences();
    savePreferences({ screen: { resolution: 720, fps: 30 } as Preferences['screen'] });
    expect(changedShared(was, readPreferences(), known)).toMatchObject({
      screen: { resolution: 720, fps: 30 },
    });
  });

  it('уходит только правка этого сохранения: своё устаревшее не перебивает общее', () => {
    localStorage.setItem('cord:name', 'Старое имя');
    const before = readPreferences();
    savePreferences({ layout: 'speaker' });
    expect(changedShared(before, readPreferences(), { name: 'Ника', layout: 'grid' })).toEqual({
      layout: 'speaker',
    });
  });

  it('имя и токен (R157) — общие; то, что оболочка уже знает, не повторяется', () => {
    let before = readPreferences();
    savePreferences({ name: 'Ника' });
    expect(changedShared(before, readPreferences(), {})).toEqual({ name: 'Ника' });
    before = readPreferences();
    savePreferences({ yandexMusicToken: TOKEN });
    expect(changedShared(before, readPreferences(), { name: 'Ника' })).toEqual({ yandexMusicToken: TOKEN });
    expect(changedShared(before, readPreferences(), { name: 'Ника', yandexMusicToken: TOKEN })).toEqual({});
  });

  it('пачки не больше предела оболочки: аватар и ссылки кинозала не роняют сообщение', () => {
    const avatar = 'data:image/png;base64,' + 'A'.repeat(3478);
    const links = Array.from({ length: 10 }, (_, i) => `https://example.com/${i}/` + 'a'.repeat(1900));
    localStorage.setItem('cord:preferences:v1', JSON.stringify({ avatar, cinemaLinks: links }));
    const values = sharedValues(readPreferences());
    expect(JSON.stringify(values.cinemaLinks).length).toBeLessThanOrEqual(6000);
    const entries = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value, at: 1 }]));
    const chunks = chunkEntries({ ...entries, yandexMusicToken: { value: 't'.repeat(1000), at: 1 } });
    for (const chunk of chunks) expect(JSON.stringify({ shared: chunk }).length).toBeLessThan(16384);
    expect(Object.assign({}, ...chunks)).toHaveProperty('avatar.value', avatar);
  });
});

describe('устройства по названию (deviceId у каждого origin свой)', () => {
  const list = [
    device('audioinput', 'default', 'По умолчанию - USB Mic'),
    device('audioinput', 'mic-b', 'USB Mic'),
    device('videoinput', 'cam-b1', 'HD Webcam'),
    device('videoinput', 'cam-b2', 'HD Webcam'),
    device('videoinput', 'cam-b3', 'Logi C920'),
    device('audiooutput', 'out-b', 'Наушники'),
  ];

  it('выбор → названия; нет устройства или названия — прежнее название, не пустота', () => {
    expect(labelsOf({ microphone: 'mic-b', camera: 'cam-b3' }, list)).toEqual({
      microphone: 'USB Mic',
      camera: 'Logi C920',
    });
    expect(labelsOf({ microphone: 'gone' }, list, { microphone: 'Старый микрофон' })).toEqual({
      microphone: 'Старый микрофон',
    });
    expect(labelsOf({}, list, { microphone: 'USB Mic' }), 'по умолчанию системы — без названия').toEqual({});
  });

  it('названия → свои id: одно совпадение — оно; два одинаковых или ни одного — по умолчанию системы', () => {
    expect(
      resolveDevices({ microphone: 'USB Mic', speaker: 'Наушники', camera: 'Logi C920' }, list, {}),
    ).toEqual({
      microphone: 'mic-b',
      speaker: 'out-b',
      camera: 'cam-b3',
    });
    expect(
      resolveDevices({ camera: 'HD Webcam' }, list, { camera: 'cam-b1' }),
      'две одинаковые камеры',
    ).toEqual({});
    expect(resolveDevices({ microphone: 'Нет такого' }, list, { microphone: 'mic-b' })).toEqual({});
  });

  it('чужой deviceId не попадает в выбор никогда; без разрешения (названий нет) — свой выбор как был', () => {
    const resolved = resolveDevices({ microphone: 'USB Mic' }, list, {});
    expect(Object.values(resolved).every((id) => list.some((item) => item.deviceId === id))).toBe(true);
    const hidden = list.map((item) => ({ ...item, label: '' }));
    expect(
      resolveDevices({ microphone: 'USB Mic', camera: 'HD Webcam' }, hidden, { camera: 'cam-local' }),
    ).toEqual({
      camera: 'cam-local',
    });
  });
});

describe('клиент Windows с prefs.shared: общее у оболочки (R146)', () => {
  it('общего у оболочки нет — первая страница переносит всё своё с seed: true; пустой токен не переносится', async () => {
    mockDevices([device('audioinput', 'mic-a', 'USB Mic')]);
    localStorage.setItem(
      'cord:preferences:v1',
      JSON.stringify({ outputVolume: 40, devices: { microphone: 'mic-a' } }),
    );
    localStorage.setItem('cord:name', 'Ника');
    const api = fakeDesktop(['prefs.shared']);
    await startSharedPreferences();
    const [message] = sent(api);
    expect(message).toMatchObject({ seed: true });
    const shared = message!.shared as Record<string, { value: unknown; at: number }>;
    expect(shared.outputVolume!.value).toBe(40);
    expect(shared.name!.value).toBe('Ника');
    expect(shared.devices!.value).toEqual({ microphone: 'USB Mic' });
    expect(shared).not.toHaveProperty('yandexMusicToken');
    expect(typeof shared.outputVolume!.at).toBe('number');
  });

  it('общее есть — переноса нет; правка уходит только изменившимся ключом, ползунок — одной пачкой', async () => {
    vi.useFakeTimers();
    mockDevices([]);
    const api = fakeDesktop(['prefs.shared'], { shared: { outputVolume: 100, name: 'Ника' } });
    await startSharedPreferences();
    expect(sent(api)).toEqual([]);
    for (const volume of [90, 80, 70, 60]) savePreferences({ outputVolume: volume });
    expect(sent(api), 'не на каждый шаг').toEqual([]);
    vi.advanceTimersByTime(200);
    expect(sent(api)).toHaveLength(1);
    const shared = sent(api)[0]!.shared as Record<string, { value: unknown; at: number }>;
    expect(Object.keys(shared)).toEqual(['outputVolume']);
    expect(shared.outputVolume!.value).toBe(60);
    // То же значение ещё раз — ничего не уходит.
    savePreferences({ outputVolume: 60 });
    vi.advanceTimersByTime(200);
    expect(sent(api)).toHaveLength(1);
    // Токен (R157) — тоже общий, но секрет: уходит оболочке, а не в общие значения.
    savePreferences({ yandexMusicToken: TOKEN });
    vi.advanceTimersByTime(200);
    expect(sent(api).at(-1)).toMatchObject({ shared: { yandexMusicToken: { value: TOKEN } } });
  });

  it('выбрал устройство — оболочке его название, а не deviceId', async () => {
    mockDevices([device('videoinput', 'cam-local-id', 'Logi C920')]);
    vi.useFakeTimers();
    const api = fakeDesktop(['prefs.shared'], { shared: { name: 'Ника' } });
    await startSharedPreferences();
    savePreferences({ devices: { camera: 'cam-local-id' } });
    await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
    vi.advanceTimersByTime(200);
    expect(sent(api).at(-1)).toMatchObject({ shared: { devices: { value: { camera: 'Logi C920' } } } });
    expect(JSON.stringify(sent(api))).not.toContain('cam-local-id');
  });

  it('при запуске названия с другого сервера → свои id этого; без пары — по умолчанию системы', async () => {
    mockDevices([device('audioinput', 'mic-here', 'USB Mic'), device('videoinput', 'cam-here', 'HD Webcam')]);
    localStorage.setItem(
      'cord:preferences:v1',
      JSON.stringify({ devices: { microphone: 'old-mic', camera: 'old-cam' } }),
    );
    const api = fakeDesktop(['prefs.shared'], {
      shared: { devices: { microphone: 'USB Mic', camera: 'Другая камера' } },
    });
    await startSharedPreferences();
    expect(readPreferences().devices).toEqual({ microphone: 'mic-here' });
    expect(sent(api), 'найденное по названию оболочке не отправляется').toEqual([]);
  });

  it('оболочка прислала победившее — кладётся у себя без отправки обратно, страница узнаёт событием', async () => {
    vi.useFakeTimers();
    mockDevices([]);
    const api = fakeDesktop(['prefs.shared'], { shared: { name: 'Ника', outputVolume: 50 } });
    await startSharedPreferences();
    const seen = vi.fn();
    window.addEventListener('cord:preferences', seen);
    api.emit('preferences.changed', { shared: { outputVolume: 30, name: 'Ника К.', favorites: ['чужое'] } });
    window.removeEventListener('cord:preferences', seen);
    expect(seen).toHaveBeenCalled();
    expect(readPreferences()).toMatchObject({ outputVolume: 30, name: 'Ника К.' });
    expect(JSON.parse(localStorage.getItem('cord:preferences:v1')!)).not.toHaveProperty('favorites');
    savePreferences({ layout: 'speaker' });
    vi.advanceTimersByTime(200);
    expect(Object.keys(sent(api).at(-1)!.shared as object)).toEqual(['layout']);
  });

  it('оболочка без prefs.shared — всё как раньше: только PING и сигналы, без shared', async () => {
    const api = fakeDesktop(['mini']);
    await startSharedPreferences();
    savePreferences({ outputVolume: 10, name: 'Ника' });
    expect(sent(api)).toEqual([]);
    savePreferences({ showPing: true });
    expect(sent(api)).toEqual([{ showPing: true, notificationSounds: true }]);
  });
});

describe('браузер: «Сменить сервер» несёт настройки во фрагменте адреса', () => {
  const catalog = async () => [
    { id: 'a', url: 'https://cord.nikg.tech/', name: { ru: 'А' } },
    { id: 'b', url: 'https://cordcam.ru/', name: { ru: 'Б' } },
  ];

  it('во фрагменте — несекретное общее и тема; токена и устройств нет никогда', () => {
    savePreferences({
      yandexMusicToken: TOKEN,
      name: 'Ника',
      outputVolume: 33,
      devices: { microphone: 'mic-id' },
    });
    const fragment = prefsFragment(readPreferences(), 'dark');
    expect(fragment.startsWith('#cord-prefs=')).toBe(true);
    const decoded = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(fragment.slice(12).replace(/-/g, '+').replace(/_/g, '/')), (c) =>
          c.charCodeAt(0),
        ),
      ),
    );
    expect(decoded).toMatchObject({ name: 'Ника', outputVolume: 33, theme: 'dark' });
    expect(fragment).not.toContain(btoa(TOKEN).slice(0, 8));
    expect(decoded).not.toHaveProperty('yandexMusicToken');
    expect(decoded).not.toHaveProperty('devices');
  });

  it('сервер-получатель сразу стирает фрагмент и берёт только белый список; токен из чужой ссылки — нет', () => {
    const forged = {
      name: 'Ника',
      outputVolume: 33,
      yandexMusicToken: 'stolen',
      favorites: ['x'],
      devices: { camera: 'x' },
      theme: 'dark',
      layout: 7,
    };
    const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(forged))))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    history.replaceState(null, '', `/room/abc?x=1#cord-prefs=${encoded}`);
    const carried = takePrefsFragment();
    expect(location.hash).toBe('');
    expect(location.pathname + location.search).toBe('/room/abc?x=1');
    expect(carried).toEqual({ patch: { name: 'Ника', outputVolume: 33, layout: 'grid' }, theme: 'dark' });
  });

  it('испорченный фрагмент — тоже стирается, и ничего не принимается', () => {
    history.replaceState(null, '', '/#cord-prefs=%%%не-base64');
    expect(takePrefsFragment()).toBeNull();
    expect(location.hash).toBe('');
    history.replaceState(null, '', '/#other');
    expect(takePrefsFragment()).toBeNull();
    expect(location.hash).toBe('#other');
  });

  it('принимается только переход с сервера каталога; чужая ссылка и пустой адрес — нет', async () => {
    const carried = { patch: { name: 'Ника', outputVolume: 33 }, theme: 'dark' };
    expect(await acceptCarriedPreferences(carried, 'https://evil.example/', catalog)).toBe(false);
    expect(await acceptCarriedPreferences(carried, '', catalog)).toBe(false);
    expect(readPreferences().name).toBe('');
    expect(await acceptCarriedPreferences(carried, 'https://cordcam.ru/', catalog)).toBe(true);
    expect(readPreferences()).toMatchObject({ name: 'Ника', outputVolume: 33 });
    expect(localStorage.getItem('cord:theme')).toBe('dark');
  });
});
