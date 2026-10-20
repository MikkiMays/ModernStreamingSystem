import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CALL_PLUGIN,
  callEnded,
  callStarted,
  isMobileApp,
  onAppCommand,
  type CapacitorBridge,
} from './mobile-app';

function bridge(native = true) {
  const listeners = new Map<string, (data: unknown) => void>();
  const cap = {
    isNativePlatform: () => native,
    nativePromise: vi.fn(async () => ({})),
    addListener: vi.fn((plugin: string, event: string, callback: (data: unknown) => void) => {
      listeners.set(`${plugin}:${event}`, callback);
      return {
        remove: vi.fn(() => {
          listeners.delete(`${plugin}:${event}`);
        }),
      };
    }),
  } satisfies CapacitorBridge;
  window.Capacitor = cap;
  return { cap, emit: (data: unknown) => listeners.get(`${CALL_PLUGIN}:command`)?.(data), listeners };
}

afterEach(() => {
  delete window.Capacitor;
});

describe('мост с приложением Cord для телефона', () => {
  it('в браузере моста нет — всё молча ничего не делает', async () => {
    expect(isMobileApp()).toBe(false);
    expect(await callStarted({ title: 'Планёрка', microphone: true })).toBe(false);
    await callEnded();
    expect(onAppCommand(() => {})).toBeTypeOf('function');
  });

  it('мост Capacitor, но не родная платформа (веб-сборка Capacitor) — тоже браузер', async () => {
    const { cap } = bridge(false);
    expect(isMobileApp()).toBe(false);
    await callStarted({ title: 'x', microphone: false });
    expect(cap.nativePromise).not.toHaveBeenCalled();
  });

  it('в приложении: разговор начался и кончился — плагину CordCall', async () => {
    const { cap } = bridge();
    expect(isMobileApp()).toBe(true);
    expect(await callStarted({ title: 'Планёрка', microphone: true })).toBe(true);
    await callEnded();
    expect(cap.nativePromise.mock.calls).toEqual([
      [CALL_PLUGIN, 'start', { title: 'Планёрка', microphone: true }],
      [CALL_PLUGIN, 'stop'],
    ]);
  });

  it('служба не поднялась (нет доступа к микрофону, старая оболочка) — встреча идёт как в браузере', async () => {
    const { cap } = bridge();
    cap.nativePromise.mockRejectedValueOnce(new Error('microphone permission missing'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await callStarted({ title: 'x', microphone: true })).toBe(false);
    warn.mockRestore();
  });

  it('нажатия в уведомлении приходят командами; чужие события и отписка — без последствий', () => {
    const { emit, listeners } = bridge();
    const seen: string[] = [];
    const off = onAppCommand((command) => seen.push(command));
    emit({ action: 'hangup' });
    emit({ action: 'microphone' });
    emit({ action: 'format-disk' });
    emit(null);
    expect(seen).toEqual(['hangup', 'microphone']);
    off();
    expect(listeners.size).toBe(0);
  });
});
