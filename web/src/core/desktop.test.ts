// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

/** Поддельный мост v2, как его выставляет preload Electron. */
function fakeDesktop(features: string[] = ['hotkeys', 'overlay', 'update']) {
  const listeners = new Map<string, Set<(data: Record<string, unknown>) => void>>();
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
    invoke: vi.fn(async (method: string) =>
      method === 'update.status' ? { status: 'Установлена последняя версия.', available: false } : null,
    ),
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
  delete (window as unknown as { chrome?: unknown }).chrome;
  vi.resetModules();
});

describe('мост v2 — адаптер', () => {
  it('в браузере оболочки нет', async () => {
    const desktop = await import('./desktop');
    expect(desktop.isDesktop()).toBe(false);
    expect(desktop.hasFeature('hotkeys')).toBe(false);
    expect(() => desktop.notifyDesktop('state', { page: 'home' })).not.toThrow();
  });

  it('видит window.cordDesktop и его флаги, версию отдаёт «О программе»', async () => {
    fakeDesktop();
    const desktop = await import('./desktop');
    expect(desktop.isDesktop()).toBe(true);
    expect(desktop.hasFeature('overlay')).toBe(true);
    expect(desktop.hasFeature('session')).toBe(false);
    expect(desktop.hasFeature('sidebar')).toBe(false);
    expect(desktop.desktopVersion(desktop.desktopUpdate.get())).toBe('1.0.0');
  });

  it('переводит имена v1 в v2: call-state, close-ready, hotkey.configure', async () => {
    const api = fakeDesktop();
    const desktop = await import('./desktop');
    desktop.notifyDesktop('call-state', { inCall: true });
    desktop.notifyDesktop('close-ready');
    const key = { code: 'KeyM', ctrl: true, alt: false, shift: true, meta: false };
    desktop.notifyDesktop('hotkey.configure', { hotkey: key });
    desktop.notifyDesktop('hotkey.configure', { hotkey: null });
    expect(api.send.mock.calls).toEqual([
      ['call.state', { inCall: true }],
      ['close.ready', {}],
      ['hotkeys.configure', { bindings: [{ action: 'mic.toggle', mode: 'toggle', key }] }],
      ['hotkeys.configure', { bindings: [] }],
    ]);
  });

  it('сочетания микрофона и оверлея уходят одним набором; на время записи — пустым', async () => {
    const api = fakeDesktop();
    const desktop = await import('./desktop');
    const mic = { code: 'KeyM', ctrl: true, alt: false, shift: true, meta: false };
    const overlay = { code: 'KeyO', ctrl: true, alt: false, shift: true, meta: false };
    desktop.notifyDesktop('hotkey.configure', { hotkey: mic, overlay });
    desktop.notifyDesktop('hotkey.configure', { paused: true });
    desktop.notifyDesktop('hotkey.configure', { overlay: null, paused: false });
    desktop.notifyDesktop('hotkey.configure', { hotkey: null });
    expect(api.send.mock.calls).toEqual([
      [
        'hotkeys.configure',
        {
          bindings: [
            { action: 'mic.toggle', mode: 'toggle', key: mic },
            { action: 'overlay.toggle', mode: 'toggle', key: overlay },
          ],
        },
      ],
      ['hotkeys.configure', { bindings: [] }],
      ['hotkeys.configure', { bindings: [{ action: 'mic.toggle', mode: 'toggle', key: mic }] }],
      ['hotkeys.configure', { bindings: [] }],
    ]);
  });

  it('WinUI получает только сочетание микрофона — об оверлее и паузе он не знает', async () => {
    const posted: unknown[] = [];
    (window as unknown as { chrome?: unknown }).chrome = {
      webview: {
        postMessage: (m: unknown) => posted.push(m),
        addEventListener() {},
        removeEventListener() {},
      },
    };
    const desktop = await import('./desktop');
    const mic = { code: 'KeyM', ctrl: true, alt: false, shift: true, meta: false };
    desktop.notifyDesktop('hotkey.configure', { hotkey: null, paused: true });
    desktop.notifyDesktop('hotkey.configure', { overlay: mic, paused: false });
    desktop.notifyDesktop('hotkey.configure', { hotkey: mic, overlay: null });
    expect(posted).toEqual([
      { version: 1, type: 'hotkey.configure', hotkey: null },
      { version: 1, type: 'hotkey.configure', hotkey: mic },
    ]);
  });

  it('состояние сочетания оверлея — своей строкой; события app.settings — подпиской', async () => {
    const api = fakeDesktop(['hotkeys', 'overlay', 'app.settings']);
    const desktop = await import('./desktop');
    const stop = desktop.onDesktopCommand(() => {});
    api.emit('hotkeys.status', { status: { 'mic.toggle': 'taken', 'overlay.toggle': 'window-only' } });
    expect(desktop.desktopHotkeyStatus.get()).toBe('taken');
    expect(desktop.desktopOverlayHotkeyStatus.get()).toBe('window-only');
    stop();
    const seen: unknown[] = [];
    const off = desktop.onDesktopEvent('app.settings', (data) => seen.push(data));
    api.emit('app.settings', { overlay: true });
    off();
    api.emit('app.settings', { overlay: false });
    expect(seen).toEqual([{ overlay: true }]);
  });

  it('«нажми и говори» с флагом ptt — действие ptt с удержанием; без флага — прежнее переключение', async () => {
    const mic = { code: 'Mouse4', ctrl: false, alt: false, shift: false, meta: false };
    let api = fakeDesktop(['hotkeys', 'ptt']);
    let desktop = await import('./desktop');
    desktop.notifyDesktop('hotkey.configure', { hotkey: mic, overlay: null, mode: 'hold' });
    // Пауза записи и её конец режим не теряют.
    desktop.notifyDesktop('hotkey.configure', { hotkey: null, paused: true });
    desktop.notifyDesktop('hotkey.configure', { hotkey: mic, paused: false });
    desktop.notifyDesktop('hotkey.configure', { mode: 'toggle' });
    expect(api.send.mock.calls).toEqual([
      ['hotkeys.configure', { bindings: [{ action: 'ptt', mode: 'hold', key: mic }] }],
      ['hotkeys.configure', { bindings: [] }],
      ['hotkeys.configure', { bindings: [{ action: 'ptt', mode: 'hold', key: mic }] }],
      ['hotkeys.configure', { bindings: [{ action: 'mic.toggle', mode: 'toggle', key: mic }] }],
    ]);
    vi.resetModules();
    api = fakeDesktop(['hotkeys']);
    desktop = await import('./desktop');
    desktop.notifyDesktop('hotkey.configure', { hotkey: mic, mode: 'hold' });
    expect(api.send.mock.calls).toEqual([
      ['hotkeys.configure', { bindings: [{ action: 'mic.toggle', mode: 'toggle', key: mic }] }],
    ]);
  });

  it('hotkey {action: ptt, phase} → microphone.hold с фазой; состояние сочетания — и для ptt', async () => {
    const api = fakeDesktop(['hotkeys', 'ptt']);
    const desktop = await import('./desktop');
    const seen: unknown[] = [];
    const stop = desktop.onDesktopCommand((command) => seen.push(command));
    api.emit('hotkey', { action: 'ptt', phase: 'down' });
    api.emit('hotkey', { action: 'ptt', phase: 'up' });
    api.emit('hotkey', { action: 'ptt', phase: 'sideways' });
    api.emit('hotkeys.status', { status: { ptt: 'global-raw' } });
    stop();
    expect(seen).toEqual([
      { version: 1, type: 'microphone.hold', phase: 'down' },
      { version: 1, type: 'microphone.hold', phase: 'up' },
      { version: 1, type: 'hotkey.status', detail: 'global-raw' },
    ]);
    expect(desktop.desktopHotkeyStatus.get()).toBe('global-raw');
  });

  it('update.version — запрос состояния обновления', async () => {
    const api = fakeDesktop();
    const desktop = await import('./desktop');
    desktop.notifyDesktop('update.version');
    await vi.waitFor(() => expect(desktop.desktopUpdate.get().status).toBe('Установлена последняя версия.'));
    expect(api.invoke).toHaveBeenCalledWith('update.status');
  });

  it('команды оболочки приходят в прежних именах: hotkey → microphone.toggle, status, deeplink, thumbar', async () => {
    const api = fakeDesktop();
    const desktop = await import('./desktop');
    const seen: unknown[] = [];
    const stop = desktop.onDesktopCommand((command) => seen.push(command));
    api.emit('hotkey', { action: 'mic.toggle', phase: 'down' });
    api.emit('hotkey', { action: 'mic.toggle', phase: 'up' });
    api.emit('hotkeys.status', { status: { 'mic.toggle': 'duplicate' } });
    api.emit('deeplink', { room: { code: '123456789' } });
    api.emit('thumbar', { action: 'camera' });
    api.emit('navigate', { page: 'create' });
    api.emit('update.status', { status: 'Доступно обновление приложения.', available: true });
    expect(seen).toEqual([
      { version: 1, type: 'microphone.toggle' },
      { version: 1, type: 'hotkey.status', detail: 'duplicate' },
      { version: 1, type: 'deeplink', code: '123456789' },
      { version: 1, type: 'thumbar', action: 'camera' },
      { version: 1, type: 'navigate', page: 'create' },
      {
        version: 1,
        type: 'update.status',
        name: '1.0.0',
        detail: 'Доступно обновление приложения.',
        available: true,
      },
    ]);
    expect(desktop.desktopHotkeyStatus.get()).toBe('duplicate');
    expect(desktop.desktopUpdate.get()).toEqual({
      version: '1.0.0',
      status: 'Доступно обновление приложения.',
      available: true,
    });
    stop();
    api.emit('navigate', { page: 'home' });
    expect(seen).toHaveLength(6);
  });

  it('WinUI (v1) по-прежнему узнаётся и говорит через postMessage', async () => {
    const posted: unknown[] = [];
    (window as unknown as { chrome?: unknown }).chrome = {
      webview: {
        postMessage: (m: unknown) => posted.push(m),
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    };
    const desktop = await import('./desktop');
    expect(desktop.isDesktop()).toBe(true);
    expect(desktop.hasFeature('session')).toBe(true);
    expect(desktop.hasFeature('sidebar')).toBe(true);
    desktop.notifyDesktop('call-state', { inCall: false });
    expect(posted).toEqual([{ version: 1, type: 'call-state', inCall: false }]);
  });
});

/*
  R22, X1: состояние сочетания оболочка присылает кодом, слова — из каталога на языке интерфейса.
  «Работает поверх других программ» — норма, о ней не говорят. Старая оболочка (1.0.4) шлёт русские
  фразы — их не показываем: на семи других языках это была бы русская строка посреди интерфейса.
*/
describe('состояние сочетания — кодом оболочки (R22)', () => {
  it('слова — только у того, что мешает: занято, дубль, только в окне', async () => {
    const { hotkeyStatusText } = await import('./desktop');
    const { t } = await import('../i18n');
    expect(hotkeyStatusText(t, 'taken')).toBe(
      'Сочетание занято другой программой: в окне Cord оно работает, для фона выберите другое.',
    );
    expect(hotkeyStatusText(t, 'duplicate')).toBe('Это сочетание уже назначено другому действию Cord.');
    expect(hotkeyStatusText(t, 'window-only')).toBe('Сейчас сочетание работает только в окне Cord.');
    for (const quiet of ['global', 'global-raw', 'disabled', null] as const)
      expect(hotkeyStatusText(t, quiet)).toBeNull();
  });

  it('русская фраза старой оболочки и незнакомое — не показываются', async () => {
    const api = fakeDesktop(['hotkeys', 'overlay']);
    const desktop = await import('./desktop');
    const seen: unknown[] = [];
    const stop = desktop.onDesktopCommand((command) => seen.push(command));
    api.emit('hotkeys.status', {
      status: {
        'mic.toggle': 'Работает поверх других программ всегда, пока Cord запущен.',
        'overlay.toggle': 'teapot',
      },
    });
    stop();
    expect(desktop.desktopHotkeyStatus.get()).toBeNull();
    expect(desktop.desktopOverlayHotkeyStatus.get()).toBeNull();
    expect(seen).toEqual([{ version: 1, type: 'hotkey.status' }]);
  });
});
