import { VideoPreset, type TrackPublishOptions, type VideoCodec } from 'livekit-client';

export type Resolution = 720 | 1080 | 1440;
export type FrameRate = 15 | 30 | 60;
export interface ScreenProfile {
  resolution: Resolution;
  fps: FrameRate;
  automatic: boolean;
  automaticFps?: boolean;
}
export const defaultProfile: ScreenProfile = { resolution: 1080, fps: 30, automatic: true };
const bitrates = {
  720: { 15: 1.5, 30: 3, 60: 5 },
  1080: { 15: 3, 30: 6, 60: 10 },
  1440: { 15: 5, 30: 10, 60: 16 },
};
/** What a level asks of the link, in bits per second. */
export function targetBitrate(level: Pick<ScreenProfile, 'resolution' | 'fps'>) {
  return bitrates[level.resolution][level.fps] * 1000000;
}
/**
 * A chosen level is published as a single layer. Simulcast exists so a receiver can be handed
 * a smaller copy, which is exactly what "send what I picked" must not do — and the encoder
 * splits its budget across the layers it publishes, so dropping them leaves the chosen one
 * with the whole allowance. maintain-framerate then keeps the frame rate as the last thing to
 * give way, because the rate is what people notice.
 *
 * The link itself is still the limit: no setting makes a connection carry more than it can.
 * What this removes is the software deciding to send less while the capacity is there.
 */
const forcedEncoding = { degradationPreference: 'maintain-framerate' as const, simulcast: false };
export function fitSource(width: number, height: number, resolution: Resolution) {
  const short = Math.min(width, height);
  const long = Math.max(width, height);
  const scale = Math.min(1, resolution / short, (resolution * 16) / 9 / long);
  return {
    width: Math.max(2, Math.floor((width * scale) / 2) * 2),
    height: Math.max(2, Math.floor((height * scale) / 2) * 2),
  };
}
export function screenOptions(profile: ScreenProfile, codec: VideoCodec): TrackPublishOptions {
  const encoding = { maxBitrate: targetBitrate(profile), maxFramerate: profile.fps };
  const base = {
    videoCodec: codec,
    backupCodec: codec === 'av1' || codec === 'vp9' ? ({ codec: 'vp8' } as const) : (false as const),
    screenShareEncoding: encoding,
  };
  if (!profile.automatic) return { ...base, ...forcedEncoding };
  return {
    ...base,
    simulcast: true,
    degradationPreference: 'balanced',
    screenShareSimulcastLayers: [
      new VideoPreset(640, 360, 500000, 15),
      ...(profile.resolution > 720 ? [new VideoPreset(1280, 720, 2000000, Math.min(profile.fps, 30))] : []),
    ],
  };
}
export function cameraCapture(profile: ScreenProfile) {
  return {
    resolution: {
      width: Math.round((profile.resolution * 16) / 9),
      height: profile.resolution,
      frameRate: profile.fps,
    },
  };
}
export function cameraOptions(profile: ScreenProfile): TrackPublishOptions {
  const bitrate =
    { 720: 2.5, 1080: 5, 1440: 8 }[profile.resolution] *
    (profile.fps === 60 ? 1.7 : profile.fps === 15 ? 0.65 : 1);
  const base = {
    videoCodec: 'vp8' as const,
    videoEncoding: { maxBitrate: bitrate * 1000000, maxFramerate: profile.fps },
  };
  if (!profile.automatic) return { ...base, ...forcedEncoding };
  return {
    ...base,
    simulcast: true,
    degradationPreference: 'maintain-framerate',
    videoSimulcastLayers: [
      new VideoPreset(320, 180, 150000, 15),
      new VideoPreset(640, 360, 500000, Math.min(30, profile.fps)),
    ],
  };
}
/**
 * Камера, пока идёт демонстрация экрана.
 *
 * Рядом с показываемым экраном камеру видно плиткой в угол экрана, и разницу между 360p
 * одним слоем и 720p тремя там никто не назовёт. Зато разница в том, что уходит в сеть,
 * шестикратная: 0,6 Мбит/с против 3,15 — и на два работающих кодировщика меньше.
 *
 * Слой здесь один намеренно. Simulcast нужен, чтобы отдать кому-то копию поменьше; когда
 * дорожка **и есть** копия поменьше, второй такой же смысла не имеет, а бюджет кодировщика
 * делит на всех именно он. Причина, по которой это вообще понадобилось, — в upstream.ts.
 */
export const companionCamera = { width: 640, height: 360, fps: 30 as FrameRate, bitrate: 600000 };
export function companionCameraCapture() {
  return {
    resolution: {
      width: companionCamera.width,
      height: companionCamera.height,
      frameRate: companionCamera.fps,
    },
  };
}
export function companionCameraOptions(): TrackPublishOptions {
  return {
    videoCodec: 'vp8',
    videoEncoding: { maxBitrate: companionCamera.bitrate, maxFramerate: companionCamera.fps },
    simulcast: false,
    // Лицо в маленькой плитке узнаётся движением, а не резкостью: частота кадров уступает
    // последней. Это тот же выбор, что и для выбранного вручную уровня демонстрации.
    degradationPreference: 'maintain-framerate',
  };
}
export async function chooseCodec(profile: ScreenProfile): Promise<VideoCodec> {
  const available = RTCRtpSender.getCapabilities?.('video')?.codecs ?? [];
  if (navigator.mediaCapabilities?.encodingInfo)
    for (const [codec, contentType] of [
      ['av1', 'video/AV1'],
      ['vp9', 'video/VP9'],
    ] as const) {
      if (!available.some((c) => c.mimeType.toLowerCase() === contentType.toLowerCase())) continue;
      try {
        const capability = await navigator.mediaCapabilities.encodingInfo({
          type: 'webrtc',
          video: {
            contentType,
            width: Math.round((profile.resolution * 16) / 9),
            height: profile.resolution,
            bitrate: bitrates[profile.resolution][profile.fps] * 1000000,
            framerate: profile.fps,
          },
        } as MediaEncodingConfiguration);
        if (capability.supported && capability.smooth && capability.powerEfficient) return codec;
      } catch {
        /* Conservative baseline when WebRTC encoding information is unavailable. */
      }
    }
  return available.some((c) => c.mimeType.toLowerCase() === 'video/h264') ? 'h264' : 'vp8';
}
