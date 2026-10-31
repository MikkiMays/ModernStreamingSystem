import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodableCodecs, decodesOption, parseDecodes } from './decode-caps';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Что перечисляет приёмник и что отвечает `decodingInfo` по кодеку. */
function stub(listed: string[], answers: Record<string, Partial<MediaCapabilitiesDecodingInfo> | 'throw'>) {
  vi.stubGlobal('RTCRtpReceiver', {
    getCapabilities: () => ({ codecs: listed.map((mimeType) => ({ mimeType, clockRate: 90000 })) }),
  });
  const decodingInfo = vi.fn(async (config: MediaDecodingConfiguration) => {
    const answer = answers[config.video!.contentType];
    if (answer === 'throw') throw new TypeError('webrtc');
    return {
      supported: false,
      smooth: false,
      powerEfficient: false,
      ...answer,
    } as MediaCapabilitiesDecodingInfo;
  });
  vi.stubGlobal('navigator', { ...navigator, mediaCapabilities: { decodingInfo } });
  return decodingInfo;
}

describe('что декодирует этот браузер (R152)', () => {
  it('Chromium на ПК: всё перечисленное и плавное; VP8 и H.264 — без вопросов', async () => {
    const ask = stub(['video/VP8', 'video/H264', 'video/VP9', 'video/AV1', 'video/H265', 'video/rtx'], {
      'video/AV1': { supported: true, smooth: true, powerEfficient: false },
      'video/VP9': { supported: true, smooth: true, powerEfficient: false },
      'video/H265': { supported: true, smooth: true, powerEfficient: true },
    });
    expect(await decodableCodecs(false)).toEqual(['av1', 'h265', 'vp9', 'h264', 'vp8']);
    expect(ask).toHaveBeenCalledTimes(3);
    expect(ask.mock.calls[0]![0]).toMatchObject({
      type: 'webrtc',
      video: { width: 1920, height: 1080, framerate: 30 },
    });
  });

  it('Firefox — без H.265: его нет в списке приёмника, и спрашивать незачем', async () => {
    stub(['video/VP8', 'video/VP9', 'video/AV1', 'video/H264'], {
      'video/AV1': { supported: true, smooth: true },
      'video/VP9': { supported: true, smooth: true },
    });
    expect(await decodableCodecs(false)).toEqual(['av1', 'vp9', 'h264', 'vp8']);
  });

  it('телефон: AV1 и H.265 — только в железе; программный AV1 1080p телефону не по силам', async () => {
    stub(['video/VP8', 'video/H264', 'video/VP9', 'video/AV1', 'video/H265'], {
      'video/AV1': { supported: true, smooth: true, powerEfficient: false },
      'video/VP9': { supported: true, smooth: true, powerEfficient: false },
      'video/H265': { supported: true, smooth: true, powerEfficient: true },
    });
    expect(await decodableCodecs(true)).toEqual(['h265', 'vp9', 'h264', 'vp8']);
  });

  it('спросить нечем (старый Safari) — перечисленному верим', async () => {
    stub(['video/H264', 'video/VP8', 'video/VP9'], { 'video/VP9': 'throw' });
    expect(await decodableCodecs(false)).toEqual(['vp9', 'h264', 'vp8']);
  });

  it('словом для команды и обратно — по порядку лестницы, без чужого', () => {
    expect(decodesOption(['vp8', 'h264', 'av1', 'h264'])).toBe('av1-h264-vp8');
    expect(decodesOption(['av1', 'h265', 'vp9', 'h264', 'vp8']).length).toBeLessThanOrEqual(24);
    expect(parseDecodes(['vp8', 'hevc', 'AV1', 'av1'])).toEqual(['av1', 'vp8']);
    expect(parseDecodes(undefined)).toBeNull();
    expect(parseDecodes('av1')).toBeNull();
    expect(parseDecodes([])).toEqual([]);
  });
});
