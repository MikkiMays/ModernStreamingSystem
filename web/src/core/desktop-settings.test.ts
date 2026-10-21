// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

const values = {
  tray: true,
  thumbar: true,
  badge: true,
  flash: true,
  sleepBlocker: true,
  overlay: false,
  autostart: false,
};

/** Оболочка v2 с переключателями: `invoke('app.settings', патч)` применяет и отвечает значениями. */
function fakeDesktop(features: string[], fail = false) {
  const listeners = new Map<string, Set<(data: Record<string, unknown>) => void>>();
  let state = { ...values };
  const api = {
    protocol: { major: 2, minor: 0 },
    features,
    app: { version: '1.0.0', arch: 'x64' },
    bootstrap: {
      profile: 'x'.repeat(43),
      theme: 'system',
      showPing: false,
      notificationSounds: true,
      autoConnect: true,
    },
    send: vi.fn(),
    invoke: vi.fn(async (method: string, payload?: object) => {
      if (method !== 'app.settings') return null;
      if (fail) throw new Error('Недоступно.');
      state = { ...state, ...(payload as Partial<typeof values>) };
      return state;
    }),
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

afterEach(() => {
  delete (window as unknown as { cordDesktop?: unknown }).cordDesktop;
  vi.resetModules();
});

describe('переключатели «Windows» (E03, T53) — состояние в вебе', () => {
  it('раздел есть только в оболочке v2 с app.settings', async () => {
    let settings = await import('./desktop-settings');
    expect(settings.desktopSettingsAvailable()).toBe(false);
    vi.resetModules();
    fakeDesktop(['overlay']);
    settings = await import('./desktop-settings');
    expect(settings.desktopSettingsAvailable()).toBe(false);
    vi.resetModules();
    fakeDesktop(['app.settings', 'tray']);
    settings = await import('./desktop-settings');
    expect(settings.desktopSettingsAvailable()).toBe(true);
  });

  it('ответ оболочки читается без доверия: всё true/false, иначе null', async () => {
    const { parseDesktopSettings } = await import('./desktop-settings');
    expect(parseDesktopSettings(values)).toEqual(values);
    expect(parseDesktopSettings({ ...values, tray: 'yes' })).toBeNull();
    expect(parseDesktopSettings({ ...values, extra: true })).toEqual(values);
    expect(parseDesktopSettings(null)).toBeNull();
  });

  it('загрузка и смена: сразу на экране, потом — как ответила оболочка', async () => {
    const api = fakeDesktop(['app.settings', 'tray', 'overlay']);
    const settings = await import('./desktop-settings');
    expect(await settings.loadDesktopSettings()).toEqual(values);
    expect(api.invoke).toHaveBeenCalledWith('app.settings', {});
    const pending = settings.changeDesktopSettings({ tray: false });
    expect(settings.desktopSettings.get()?.tray).toBe(false);
    await pending;
    expect(api.invoke).toHaveBeenLastCalledWith('app.settings', { tray: false });
    expect(settings.desktopSettings.get()).toEqual({ ...values, tray: false });
  });

  it('оболочка отказала — переключатель возвращается назад', async () => {
    fakeDesktop(['app.settings', 'tray']);
    const settings = await import('./desktop-settings');
    settings.desktopSettings.set({ ...values });
    (window as unknown as { cordDesktop: { invoke: unknown } }).cordDesktop.invoke = vi.fn(async () => {
      throw new Error('Недоступно.');
    });
    await settings.changeDesktopSettings({ autostart: true });
    expect(settings.desktopSettings.get()?.autostart).toBe(false);
  });

  it('событие app.settings (клавиша оверлея) меняет состояние; переключить оверлей из окна', async () => {
    const api = fakeDesktop(['app.settings', 'overlay']);
    const settings = await import('./desktop-settings');
    const stop = settings.watchDesktopSettings();
    api.emit('app.settings', { ...values, overlay: true });
    expect(settings.desktopSettings.get()?.overlay).toBe(true);
    stop();
    await settings.toggleDesktopOverlay();
    expect(api.invoke).toHaveBeenLastCalledWith('app.settings', { overlay: false });
  });
});
