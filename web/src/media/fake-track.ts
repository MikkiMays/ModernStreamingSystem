import { vi } from 'vitest';
import { LocalVideoTrack } from 'livekit-client';

/**
 * Дорожка LiveKit без браузера: прототип настоящий (чтобы `instanceof` в сессии её признал),
 * а отправитель и захват подставные. Слои — как их кладёт LiveKit для выбранных 1440p60:
 * подпорки 360p и 720p и верхний слой во весь кадр.
 */
export function fakeCameraTrack(size = { width: 2560, height: 1440 }) {
  const settings = { ...size, frameRate: 60 };
  const media = {
    kind: 'video',
    readyState: 'live',
    contentHint: '',
    getSettings: () => settings,
    getCapabilities: () => ({}),
    applyConstraints: vi.fn(async () => {}),
  };
  const published: RTCRtpEncodingParameters[] = [
    { rid: 'q', scaleResolutionDownBy: 4, maxBitrate: 500000, maxFramerate: 15 },
    { rid: 'h', scaleResolutionDownBy: 2, maxBitrate: 2000000, maxFramerate: 30 },
    { rid: 'f', scaleResolutionDownBy: 1, maxBitrate: 16000000, maxFramerate: 60 },
  ];
  let current = published.map((encoding) => ({ ...encoding, active: true }));
  const sender = {
    getParameters: () => ({ encodings: current.map((encoding) => ({ ...encoding })) }),
    setParameters: vi.fn(async (params: { encodings: RTCRtpEncodingParameters[] }) => {
      current = params.encodings.map((encoding) => ({ ...encoding, active: encoding.active ?? true }));
    }),
  };
  const lock = { lock: vi.fn(async () => () => {}) };
  const track = Object.create(LocalVideoTrack.prototype) as LocalVideoTrack;
  Object.assign(track, { _sender: sender, _mediaStreamTrack: media, encodings: published, senderLock: lock });
  return { track, media, sender, lock, settings, layers: () => current };
}
