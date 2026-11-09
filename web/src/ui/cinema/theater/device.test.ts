import { describe, expect, it, vi } from 'vitest';
import { mediaProfile, videoCodecs } from './device';

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
      // Samsung со своим браузером (телевизор владельца, R216): Tizen, SMART-TV, Samsung Internet для ТВ.
      'Mozilla/5.0 (SMART-TV; Linux; Tizen 7.0) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/5.2 Chrome/94.0.4606.31 TV Safari/537.36',
      'Mozilla/5.0 (Linux; Tizen 8.0) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/7.0 Chrome/108.0.5359.1 TV Safari/537.36',
      'Mozilla/5.0 (Linux; U; Linux) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/6.5 Chrome/103.0 TV Safari/537.36',
      'Mozilla/5.0 (Linux; Android 9; MIBOX4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/106.0 Safari/537.36',
      'Mozilla/5.0 (Linux; VIDAA 7.0; Hisense) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/89.0 Safari/537.36',
    ]) {
      expect(mediaProfile({ userAgent, element: PITCH }), userAgent).toEqual({ tv: true, rateSafe: false });
    }
  });

  it('телефоны с похожими словами в строке — не телевизоры', () => {
    for (const userAgent of [
      'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36',
      'Mozilla/5.0 (Linux; Android 10; Hisense E50 Lite) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
      'Mozilla/5.0 (Linux; Android 9; YNDX-000SB) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0 YaBrowser/23.3 Mobile Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
    ]) {
      expect(mediaProfile({ userAgent, element: PITCH }).tv, userAgent).toBe(false);
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

  it('кодеки — AV1, затем VP9, только если железо обещает плавно и экономно; H.264 — всегда последним', async () => {
    const pc = { tv: false, rateSafe: true };
    const none = new Set<never>();
    const answer = (by: Record<string, Partial<MediaCapabilitiesDecodingInfo>>) => ({
      decodingInfo: vi.fn((config: MediaDecodingConfiguration) => {
        const family = config.video!.contentType.includes('av01') ? 'av01' : 'vp09';
        return Promise.resolve((by[family] ?? { supported: false }) as MediaCapabilitiesDecodingInfo);
      }),
    });
    const hw = { supported: true, smooth: true, powerEfficient: true };
    const soft = { supported: true, smooth: true, powerEfficient: false };
    expect(await videoCodecs(pc, answer({ av01: hw, vp09: hw }), none)).toEqual(['av01', 'vp09', 'avc1']);
    expect(await videoCodecs(pc, answer({ av01: soft, vp09: hw }), none)).toEqual(['vp09', 'avc1']);
    expect(await videoCodecs(pc, answer({ av01: soft, vp09: soft }), none)).toEqual(['avc1']);
    expect(await videoCodecs(pc, undefined, none)).toEqual(['avc1']);
    expect(
      await videoCodecs(pc, { decodingInfo: vi.fn(() => Promise.reject(new TypeError('no'))) }, none),
    ).toEqual(['avc1']);
    // Кодек, от которого устройство недавно отказалось посреди просмотра (`decode.ts`), не предлагается.
    expect(await videoCodecs(pc, answer({ av01: hw, vp09: hw }), new Set(['av01'] as const))).toEqual([
      'vp09',
      'avc1',
    ]);
    // Телевизор — H.264 без вопросов: его обещаниям про VP9 и AV1 в браузере верить нельзя.
    const tv = answer({ av01: hw, vp09: hw });
    expect(await videoCodecs({ tv: true, rateSafe: false }, tv, none)).toEqual(['avc1']);
    expect(tv.decodingInfo).not.toHaveBeenCalled();
  });

  it('молчащий `MediaCapabilities` не держит первый кадр дольше 400 мс', async () => {
    vi.useFakeTimers();
    try {
      const silent = { decodingInfo: vi.fn(() => new Promise<MediaCapabilitiesDecodingInfo>(() => {})) };
      const asked = videoCodecs({ tv: false, rateSafe: true }, silent, new Set());
      await vi.advanceTimersByTimeAsync(400);
      expect(await asked).toEqual(['avc1']);
    } finally {
      vi.useRealTimers();
    }
  });
});
