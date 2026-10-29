import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalVideoTrack } from 'livekit-client';
import { readPreferences } from '../core/preferences';
import { DeviceCheck } from './DeviceCheck';

/*
  «Проверить камеру» в «Диагностике» и «Поддержке» — тоже включение камеры: на телефоне фронтальная
  (Р-35), а не запомненная после «перевернуть»; на компьютере — выбранная в настройках.
*/

vi.mock('livekit-client', async (load) => ({
  ...(await load<typeof import('livekit-client')>()),
  createLocalVideoTrack: vi.fn(async () => ({
    attach: vi.fn(),
    detach: vi.fn(),
    stop: vi.fn(),
    mediaStreamTrack: { getSettings: () => ({ facingMode: 'user' }) },
  })),
}));

const touch = (coarse: boolean) =>
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: coarse && query === '(pointer: coarse)',
    addEventListener: () => {},
    removeEventListener: () => {},
  }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  localStorage.clear();
});

describe('проверка камеры', () => {
  const check = async () => {
    localStorage.setItem('cord:preferences:v1', JSON.stringify({ devices: { camera: 'back-camera' } }));
    render(<DeviceCheck preferences={readPreferences()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Проверить камеру' }));
    await vi.waitFor(() => expect(createLocalVideoTrack).toHaveBeenCalledTimes(1));
    return vi.mocked(createLocalVideoTrack).mock.calls[0]![0]!;
  };

  it('на телефоне — фронтальная, хотя запомнена задняя', async () => {
    touch(true);
    const asked = await check();
    expect(asked).toMatchObject({ facingMode: 'user' });
    expect(asked.deviceId).toBeUndefined();
  });

  it('на компьютере — выбранная в настройках', async () => {
    touch(false);
    const asked = await check();
    expect(asked).toMatchObject({ deviceId: 'back-camera' });
    expect(asked.facingMode).toBeUndefined();
  });
});
