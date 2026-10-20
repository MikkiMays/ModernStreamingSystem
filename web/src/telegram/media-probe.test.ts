import { describe, expect, it, vi } from 'vitest';
import { probeMicrophone } from './media-probe';

const refuse = (name: string) => ({
  getUserMedia: vi.fn().mockRejectedValue(Object.assign(new Error(name), { name })),
});

describe('микрофон внутри Telegram', () => {
  it('выдали — дорожки сразу отпускаются, камеру не спрашивают', async () => {
    const stop = vi.fn();
    const media = { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] }) };
    expect(await probeMicrophone(media as unknown as MediaDevices)).toBe('ok');
    expect(media.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(stop).toHaveBeenCalled();
  });

  it('отказ человека или клиента — «denied», нет устройства или API — «unsupported»', async () => {
    expect(await probeMicrophone(refuse('NotAllowedError') as unknown as MediaDevices)).toBe('denied');
    expect(await probeMicrophone(refuse('SecurityError') as unknown as MediaDevices)).toBe('denied');
    expect(await probeMicrophone(refuse('NotFoundError') as unknown as MediaDevices)).toBe('unsupported');
    expect(await probeMicrophone(undefined)).toBe('unsupported');
    expect(await probeMicrophone({} as MediaDevices)).toBe('unsupported');
  });
});
