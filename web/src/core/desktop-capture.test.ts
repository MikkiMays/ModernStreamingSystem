// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

/** Мост v2 с флагами и ответами на `invoke`, как его выставляет preload Electron. */
function fakeDesktop(features: string[], invoke: (method: string, payload?: object) => Promise<unknown>) {
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
    invoke: vi.fn(invoke),
    on: vi.fn(() => () => {}),
  };
  (window as unknown as { cordDesktop?: unknown }).cordDesktop = api;
  return api;
}

afterEach(() => {
  delete (window as unknown as { cordDesktop?: unknown }).cordDesktop;
  delete (window as unknown as { chrome?: unknown }).chrome;
  vi.resetModules();
});

const thumb = 'data:image/png;base64,AAAA';

describe('окно выбора источника в вебе (E01-B2, ADR §4.1)', () => {
  it('в браузере и в WinUI своего окна нет — показ идёт браузерным путём', async () => {
    const capture = await import('./desktop-capture');
    expect(capture.desktopPicker()).toBe(false);
    (window as unknown as { chrome?: unknown }).chrome = {
      webview: { postMessage() {}, addEventListener() {}, removeEventListener() {} },
    };
    expect(capture.desktopPicker()).toBe(false);
  });

  it('в Electron с флагом capture — своё окно; системный звук — по своему флагу', async () => {
    fakeDesktop(['capture'], async () => null);
    let capture = await import('./desktop-capture');
    expect(capture.desktopPicker()).toBe(true);
    expect(capture.systemAudioAvailable()).toBe(false);
    vi.resetModules();
    fakeDesktop(['capture', 'capture.system-audio'], async () => null);
    capture = await import('./desktop-capture');
    expect(capture.systemAudioAvailable()).toBe(true);
  });

  it('список источников проверяется: чужой id, не картинка, длинное имя', () => {
    return import('./desktop-capture').then(({ parseCaptureSources }) => {
      const parsed = parseCaptureSources({
        systemAudio: true,
        sources: [
          { id: 'screen:0:0', name: 'Экран 1', kind: 'screen', thumbnail: thumb, icon: '' },
          { id: 'window:42:0', name: 'x'.repeat(200), kind: 'window', thumbnail: thumb, icon: thumb },
          {
            id: 'window:43:0',
            name: 'Плеер',
            kind: 'window',
            thumbnail: 'https://evil.example/a.png',
            icon: 'javascript:1',
          },
          { id: 'file:///etc/passwd', name: 'Чужое', kind: 'window', thumbnail: thumb, icon: '' },
          null,
        ],
      });
      expect(parsed.systemAudio).toBe(true);
      expect(parsed.appAudio).toBe(false);
      expect(parsed.sources.map((source) => source.id)).toEqual(['screen:0:0', 'window:42:0', 'window:43:0']);
      expect(parsed.sources[1]!.name).toHaveLength(80);
      expect(parsed.sources[2]).toMatchObject({ thumbnail: '', icon: '' });
      expect(parseCaptureSources(null)).toEqual({ systemAudio: false, appAudio: false, sources: [] });
      expect(parseCaptureSources([{ id: 'screen:1:0', name: 'Экран 2', thumbnail: thumb }]).sources).toEqual([
        { id: 'screen:1:0', name: 'Экран 2', kind: 'screen', thumbnail: thumb, icon: '' },
      ]);
    });
  });

  it('выбор — запрос с ответом до getDisplayMedia; старая оболочка — сообщением', async () => {
    const api = fakeDesktop(['capture'], async (method) =>
      method === 'capture.select' ? { ok: true } : null,
    );
    const capture = await import('./desktop-capture');
    await capture.selectCaptureSource('window:42:0', 'system');
    expect(api.invoke).toHaveBeenCalledWith('capture.select', { id: 'window:42:0', audio: 'system' });
    expect(api.send).not.toHaveBeenCalled();
    api.invoke.mockImplementation(async () => {
      throw new Error('Недоступно.');
    });
    await capture.selectCaptureSource('screen:0:0', 'none');
    expect(api.send).toHaveBeenCalledWith('capture.select', { id: 'screen:0:0', audio: 'none' });
  });

  it('listCaptureSources спрашивает оболочку и разбирает ответ; отказ — пустой список', async () => {
    const api = fakeDesktop(['capture'], async () => ({
      systemAudio: false,
      sources: [{ id: 'screen:0:0', name: 'Экран 1', kind: 'screen', thumbnail: thumb, icon: '' }],
    }));
    const capture = await import('./desktop-capture');
    expect((await capture.listCaptureSources()).sources).toHaveLength(1);
    expect(api.invoke).toHaveBeenCalledWith('capture.sources', {});
    api.invoke.mockImplementation(async () => {
      throw new Error('нет');
    });
    expect(await capture.listCaptureSources()).toEqual({ systemAudio: false, appAudio: false, sources: [] });
  });
});

/**
 * Мост с событиями, как preload E01-B3: `on('capture.audio')` отдаёт новому подписчику последнее
 * состояние сразу (микрозадачей), остальное — когда оболочка пришлёт.
 */
function bridgeWithEvents(features: string[], stored: Record<string, unknown> | null = null) {
  const listeners = new Map<string, Set<(data: Record<string, unknown>) => void>>();
  const api = fakeDesktop(features, async () => null);
  api.on.mockImplementation(((type: string, listener: (data: Record<string, unknown>) => void) => {
    let set = listeners.get(type);
    if (!set) listeners.set(type, (set = new Set()));
    set.add(listener);
    if (type === 'capture.audio' && stored) {
      const current = { ...stored };
      queueMicrotask(() => listener(current));
    }
    return () => void set?.delete(listener);
  }) as unknown as typeof api.on);
  return {
    api,
    emit(type: string, data: Record<string, unknown>) {
      for (const listener of listeners.get(type) ?? []) listener(data);
    },
    count: (type: string) => listeners.get(type)?.size ?? 0,
  };
}

/** Скрытый элемент preload с дорожкой в `srcObject` (jsdom его не умеет — свойство подставляется). */
function captureElement(mode: string, readyState: MediaStreamTrackState = 'live') {
  const track = { kind: 'audio', readyState, stop: vi.fn() } as unknown as MediaStreamTrack;
  const element = document.createElement('audio');
  element.id = 'cord-desktop-capture-audio';
  element.dataset.mode = mode;
  Object.defineProperty(element, 'srcObject', { value: { getAudioTracks: () => [track] } });
  document.body.append(element);
  return track;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('звук приложения в показе (E01-B3, capture.app-audio)', () => {
  afterEach(() => document.getElementById('cord-desktop-capture-audio')?.remove());

  it('режимы окна выбора — только с флагом и ответом оболочки; «Звук приложения» — только у окна', async () => {
    fakeDesktop(['capture', 'capture.system-audio', 'capture.app-audio'], async () => null);
    let capture = await import('./desktop-capture');
    const found = { systemAudio: true, appAudio: true, sources: [] };
    expect(capture.captureAudioModes('window', found)).toEqual([
      'none',
      'system',
      'app',
      'system-except-cord',
    ]);
    expect(capture.captureAudioModes('screen', found)).toEqual(['none', 'system', 'system-except-cord']);
    expect(capture.captureAudioModes('screen', { ...found, systemAudio: false })).toEqual([
      'none',
      'system-except-cord',
    ]);
    // Модуль упал после запуска: оболочка не обещает звук приложения — прежний выключатель.
    expect(capture.captureAudioModes('window', { ...found, appAudio: false })).toBeNull();
    vi.resetModules();
    fakeDesktop(['capture', 'capture.system-audio'], async () => null);
    capture = await import('./desktop-capture');
    expect(capture.captureAudioModes('window', found)).toBeNull();
    expect(capture.parseCaptureSources({ systemAudio: true, appAudio: true, sources: [] }).appAudio).toBe(
      true,
    );
  });

  it('без звука и звук системы — без своей дорожки: источник звука не нужен', async () => {
    fakeDesktop(['capture', 'capture.app-audio'], async () => null);
    const capture = await import('./desktop-capture');
    expect(capture.desktopCaptureAudio('none')).toBeUndefined();
    expect(capture.desktopCaptureAudio('system')).toBeUndefined();
    expect(capture.desktopCaptureAudio('app')).toBeDefined();
    expect(capture.desktopCaptureAudio('system-except-cord')).toBeDefined();
  });

  it('ready → дорожка из #cord-desktop-capture-audio; ended — конец; отписка снимает слушателя', async () => {
    const bridge = bridgeWithEvents(['capture', 'capture.app-audio']);
    const capture = await import('./desktop-capture');
    const seen: unknown[] = [];
    const stop = capture.desktopCaptureAudio('app')!.watch((event) => seen.push(event));
    await tick();
    const track = captureElement('app');
    bridge.emit('capture.audio', { state: 'ready', mode: 'app' });
    bridge.emit('capture.audio', { state: 'ended', mode: 'app' });
    expect(seen).toEqual([{ state: 'ready', track }, { state: 'ended' }]);
    stop();
    expect(bridge.count('capture.audio')).toBe(0);
  });

  it('failed — короткая подсказка по-русски с причиной; чужой режим не трогает', async () => {
    const bridge = bridgeWithEvents(['capture', 'capture.app-audio']);
    const capture = await import('./desktop-capture');
    const seen: { state: string; message?: string }[] = [];
    capture.desktopCaptureAudio('app')!.watch((event) => seen.push(event as (typeof seen)[number]));
    await tick();
    bridge.emit('capture.audio', { state: 'failed', mode: 'system-except-cord', reason: 'x' });
    bridge.emit('capture.audio', { state: 'failed', mode: 'app', reason: 'not-a-window' });
    bridge.emit('capture.audio', { state: 'failed', mode: 'app', reason: 'unavailable' });
    bridge.emit('capture.audio', { state: 'failed', mode: 'app', reason: 'окно источника уже закрыто' });
    expect(seen.map((event) => event.state)).toEqual(['failed', 'failed', 'failed']);
    expect(seen[0]!.message).toMatch(/только у окна/);
    expect(seen[1]!.message).toMatch(/без звука/);
    expect(seen[2]!.message).toContain('окно источника уже закрыто');
    expect(seen[2]!.message).toMatch(/без звука/);
  });

  it('состояние прошлого показа, которое preload отдаёт новому подписчику сразу, не считается', async () => {
    const bridge = bridgeWithEvents(['capture', 'capture.app-audio'], {
      state: 'failed',
      mode: 'app',
      reason: 'прошлый раз',
    });
    const capture = await import('./desktop-capture');
    const seen: unknown[] = [];
    capture.desktopCaptureAudio('app')!.watch((event) => seen.push(event));
    await tick();
    expect(seen).toEqual([]);
    // Готовность без живой дорожки в элементе — не готовность.
    captureElement('app', 'ended');
    bridge.emit('capture.audio', { state: 'ready', mode: 'app' });
    expect(seen).toEqual([]);
  });
});
