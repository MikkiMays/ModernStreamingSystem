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
      expect(parsed.sources.map((source) => source.id)).toEqual(['screen:0:0', 'window:42:0', 'window:43:0']);
      expect(parsed.sources[1]!.name).toHaveLength(80);
      expect(parsed.sources[2]).toMatchObject({ thumbnail: '', icon: '' });
      expect(parseCaptureSources(null)).toEqual({ systemAudio: false, sources: [] });
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
    expect(await capture.listCaptureSources()).toEqual({ systemAudio: false, sources: [] });
  });
});
