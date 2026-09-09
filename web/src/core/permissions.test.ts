import { afterEach, expect, it, vi } from 'vitest';
import { requestDevicePermissions } from './permissions';
afterEach(() => vi.unstubAllGlobals());
it('coalesces permission checks and stops every acquired track while leaving browser grants authoritative', async () => {
  const stop = vi.fn();
  const capture = vi.fn(async () => ({ getTracks: () => [{ stop }] }));
  const query = vi.fn(async () => ({ state: 'prompt' }));
  vi.stubGlobal('navigator', { permissions: { query }, mediaDevices: { getUserMedia: capture } });
  const first = requestDevicePermissions();
  expect(requestDevicePermissions()).toBe(first);
  expect(await first).toEqual({ microphone: 'granted', camera: 'granted' });
  expect(stop).toHaveBeenCalledTimes(2);
  query.mockResolvedValue({ state: 'granted' });
  await requestDevicePermissions();
  expect(capture).toHaveBeenCalledTimes(2);
});
