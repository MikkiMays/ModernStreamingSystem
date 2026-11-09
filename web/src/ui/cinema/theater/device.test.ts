import { describe, expect, it, vi } from 'vitest';
import { mediaProfile, preferredVideoCodec } from './device';

const PITCH = { preservesPitch: true };

describe('что умеет устройство с видео (R216)', () => {
  it('телевизоры и приставки узнаются по строке браузера — скорость там не трогаем', () => {
    for (const userAgent of [
      'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.5) AppleWebKit/537.36 (KHTML, like Gecko) 85.0.4183.93/6.5 TV Safari/537.36',
      'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.88 Safari/537.36 WebAppManager',
      'Mozilla/5.0 (Linux; Android 9; SHIELD Android TV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      'Mozilla/5.0 (Linux; Android 10; BRAVIA 4K VH2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0 Safari/537.36',
      'Mozilla/5.0 (Linux; Android 9; AFTKA) AppleWebKit/537.36 (KHTML, like Gecko) Silk/112.3.1 like Chrome/112.0 Safari/537.36',
      'Mozilla/5.0 (Linux; Android 11; YNDX-00091) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0 YaBrowser/23.3 Safari/537.36',
    ]) {
      expect(mediaProfile({ userAgent, element: PITCH }), userAgent).toEqual({ tv: true, rateSafe: false });
    }
  });

  it('компьютер и телефон с сохранением тона — скорость честная; движок без него — нет', () => {
    const chrome =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
    const iphone =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
    expect(mediaProfile({ userAgent: chrome, element: PITCH })).toEqual({ tv: false, rateSafe: true });
    expect(mediaProfile({ userAgent: iphone, element: { webkitPreservesPitch: true } })).toEqual({
      tv: false,
      rateSafe: true,
    });
    expect(mediaProfile({ userAgent: chrome, element: {} })).toEqual({ tv: false, rateSafe: false });
  });

  it('VP9 — только если железо обещает плавно и экономно; иначе и без ответа — H.264', async () => {
    const pc = { tv: false, rateSafe: true };
    const answer = (info: Partial<MediaCapabilitiesDecodingInfo>) => ({
      decodingInfo: vi.fn(() => Promise.resolve(info as MediaCapabilitiesDecodingInfo)),
    });
    expect(
      await preferredVideoCodec(pc, answer({ supported: true, smooth: true, powerEfficient: true })),
    ).toBe(undefined);
    expect(
      await preferredVideoCodec(pc, answer({ supported: true, smooth: true, powerEfficient: false })),
    ).toBe('avc1');
    expect(
      await preferredVideoCodec(pc, answer({ supported: false, smooth: false, powerEfficient: false })),
    ).toBe('avc1');
    expect(await preferredVideoCodec(pc, undefined)).toBe('avc1');
    expect(
      await preferredVideoCodec(pc, { decodingInfo: vi.fn(() => Promise.reject(new TypeError('no'))) }),
    ).toBe('avc1');
    // Телевизор — H.264 без вопросов: его обещаниям про VP9 в браузере верить нельзя.
    const tv = answer({ supported: true, smooth: true, powerEfficient: true });
    expect(await preferredVideoCodec({ tv: true, rateSafe: false }, tv)).toBe('avc1');
    expect(tv.decodingInfo).not.toHaveBeenCalled();
  });

  it('молчащий `MediaCapabilities` не держит первый кадр дольше 400 мс', async () => {
    vi.useFakeTimers();
    try {
      const silent = { decodingInfo: vi.fn(() => new Promise<MediaCapabilitiesDecodingInfo>(() => {})) };
      const asked = preferredVideoCodec({ tv: false, rateSafe: true }, silent);
      await vi.advanceTimersByTimeAsync(400);
      expect(await asked).toBe('avc1');
    } finally {
      vi.useRealTimers();
    }
  });
});
