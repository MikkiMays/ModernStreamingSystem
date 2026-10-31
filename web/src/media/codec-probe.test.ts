import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseShellGpu, policyPlatform, probeEncoders, vendorOf } from './codec-probe';
import { probeKey } from './codec-policy';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const level = { width: 1280, height: 720, fps: 30, bitrate: 3_000_000 };

/** Chromium с RTCRtpSender и `encodingInfo`, который отвечает «в железе» только на `hw`. */
function chromium(hw: string[], options: { webrtc?: boolean } = {}) {
  vi.stubGlobal('RTCRtpSender', {
    getCapabilities: () => ({
      codecs: ['video/VP8', 'video/H264', 'video/VP9', 'video/AV1', 'video/H265'].map((mimeType) => ({
        mimeType,
        clockRate: 90000,
      })),
    }),
  });
  const encodingInfo = vi.fn(async (config: MediaEncodingConfiguration) => {
    if (options.webrtc === false)
      throw new TypeError("The provided value 'webrtc' is not a valid enum value");
    const video = config.video as VideoConfiguration & { scalabilityMode?: string };
    const key = `${video.contentType}${video.scalabilityMode ? `/${video.scalabilityMode}` : ''}`;
    return {
      supported: true,
      smooth: true,
      powerEfficient: hw.includes(key),
    } as MediaCapabilitiesEncodingInfo;
  });
  vi.stubGlobal('navigator', { userAgent: 'Chrome/150 test', mediaCapabilities: { encodingInfo } });
  return encodingInfo;
}

describe('вопросы кодировщику (R152)', () => {
  it('у VP9/AV1 — с тем режимом слоёв, что пойдёт в сеть; у H.264/H.265 — без режима', async () => {
    const ask = chromium(['video/AV1/L1T3', 'video/H265']);
    const answers = await probeEncoders(
      [
        { codec: 'av1', mode: 'L1T3' },
        { codec: 'av1', mode: 'L1T1' },
        { codec: 'h265', mode: 'L1T1' },
        { codec: 'vp9', mode: 'L3T3_KEY' },
      ],
      level,
      'nvidia:2786:RTX 4070/32.0',
    );
    expect(answers[probeKey('av1', 'L1T3')]?.powerEfficient).toBe(true);
    expect(answers[probeKey('av1', 'L1T1')]?.powerEfficient).toBe(false);
    expect(answers[probeKey('h265', 'L1T1')]?.powerEfficient).toBe(true);
    expect(answers[probeKey('vp9', 'L3T3_KEY')]?.powerEfficient).toBe(false);
    const asked = ask.mock.calls.map(
      ([config]) => config.video as VideoConfiguration & { scalabilityMode?: string },
    );
    // Первый вопрос — проверка, знает ли браузер `type: 'webrtc'`.
    expect(asked.slice(1)).toEqual([
      {
        contentType: 'video/AV1',
        width: 1280,
        height: 720,
        bitrate: 3_000_000,
        framerate: 30,
        scalabilityMode: 'L1T3',
      },
      {
        contentType: 'video/AV1',
        width: 1280,
        height: 720,
        bitrate: 3_000_000,
        framerate: 30,
        scalabilityMode: 'L1T1',
      },
      { contentType: 'video/H265', width: 1280, height: 720, bitrate: 3_000_000, framerate: 30 },
      {
        contentType: 'video/VP9',
        width: 1280,
        height: 720,
        bitrate: 3_000_000,
        framerate: 30,
        scalabilityMode: 'L3T3_KEY',
      },
    ]);
    // Ответы — в кэш: тот же браузер и та же видеокарта больше не спрашивают.
    ask.mockClear();
    await probeEncoders([{ codec: 'av1', mode: 'L1T3' }], level, 'nvidia:2786:RTX 4070/32.0');
    expect(ask).not.toHaveBeenCalled();
    // Другой уровень — другой вопрос.
    await probeEncoders([{ codec: 'av1', mode: 'L1T3' }], { ...level, fps: 60 }, 'nvidia:2786:RTX 4070/32.0');
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('браузер не знает `type: webrtc` — ответов нет вовсе, политика решит вслепую', async () => {
    chromium([], { webrtc: false });
    expect(await probeEncoders([{ codec: 'h264', mode: 'L1T1' }], level, 'x')).toEqual({});
  });
});

describe('видеокарта и платформа', () => {
  it('поставщик по PCI-коду и по строке рендерера', () => {
    expect(vendorOf(0x10de)).toBe('nvidia');
    expect(vendorOf(0x1002)).toBe('amd');
    expect(vendorOf(0x8086)).toBe('intel');
    expect(vendorOf(0x1234)).toBe('other');
    expect(
      vendorOf('ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 (0x00002786) Direct3D11 vs_5_0 ps_5_0, D3D11)'),
    ).toBe('nvidia');
    expect(vendorOf('ANGLE (AMD, AMD Radeon RX 7800 XT Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('amd');
    expect(vendorOf('ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe(
      'intel',
    );
    expect(vendorOf('Apple GPU')).toBe('apple');
    expect(vendorOf('Adreno (TM) 740')).toBe('qualcomm');
  });

  it('ответ оболочки без устройств — не подсказка', () => {
    expect(parseShellGpu({ devices: [], av1hw: { enabled: false } })).toEqual({
      vendors: [],
      av1hw: false,
      source: 'shell',
      identity: '',
    });
  });

  it('Telegram и телефон — свои лестницы; ПК в браузере — «desktop»', () => {
    const base = { os: 'other', mobile: false, standalone: false, app: false, telegram: false } as const;
    expect(policyPlatform({ ...base, telegram: true })).toBe('telegram');
    expect(policyPlatform({ ...base, os: 'android', mobile: true })).toBe('mobile');
    expect(policyPlatform({ ...base, app: true })).toBe('mobile');
    expect(policyPlatform(base)).toBe('desktop');
  });
});
