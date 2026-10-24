// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useTrayChat } from './useTrayChat';

/*
  «Чат · N» в меню трея клиента Windows (R103): оболочка поднимает окно и шлёт `chat.open`, встреча
  открывает панель чата — открывает, а не переключает.
*/

function fakeDesktop() {
  const listeners = new Map<string, Set<(data: Record<string, unknown>) => void>>();
  const api = {
    protocol: { major: 2, minor: 0 },
    features: ['tray'],
    app: { version: '1.0.6', arch: 'x64' },
    bootstrap: {
      profile: 'x'.repeat(43),
      theme: 'system',
      language: null,
      showPing: false,
      notificationSounds: true,
      autoConnect: true,
    },
    send: vi.fn(),
    invoke: vi.fn(async () => null),
    on: vi.fn((type: string, listener: (data: Record<string, unknown>) => void) => {
      let set = listeners.get(type);
      if (!set) listeners.set(type, (set = new Set()));
      set.add(listener);
      return () => void set?.delete(listener);
    }),
    emit(type: string, data: Record<string, unknown> = {}) {
      for (const listener of listeners.get(type) ?? []) listener(data);
    },
  };
  (window as unknown as { cordDesktop?: unknown }).cordDesktop = api;
  return api;
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { cordDesktop?: unknown }).cordDesktop;
});

describe('чат из меню трея (R103)', () => {
  it('chat.open открывает панель чата — каждый раз «открыть», а не «переключить»', () => {
    const api = fakeDesktop();
    const setPanel = vi.fn();
    const { unmount } = renderHook(() => useTrayChat(setPanel));
    act(() => api.emit('chat.open'));
    act(() => api.emit('chat.open'));
    expect(setPanel.mock.calls).toEqual([['chat'], ['chat']]);
    // Чужие команды оболочки чат не трогают.
    act(() => api.emit('navigate', { page: 'home' }));
    expect(setPanel).toHaveBeenCalledTimes(2);
    // Встреча закрыта — подписки нет, событие пропадает.
    unmount();
    act(() => api.emit('chat.open'));
    expect(setPanel).toHaveBeenCalledTimes(2);
  });

  it('в браузере оболочки нет — и подписываться не на что', () => {
    const setPanel = vi.fn();
    expect(() => renderHook(() => useTrayChat(setPanel)).unmount()).not.toThrow();
    expect(setPanel).not.toHaveBeenCalled();
  });
});
