import { VideoPreset, type TrackPublishOptions, type VideoCodec } from 'livekit-client';

export type Resolution = 720 | 1080 | 1440;
export type FrameRate = 15 | 30 | 60;
export interface ScreenProfile {
  resolution: Resolution;
  fps: FrameRate;
  /**
   * Автоматический уровень: и кадр, и частоту выбирает лестница из `auto-quality.ts`.
   *
   * Раньше частота имела собственный флаг `automaticFps`, который никуда не передавался:
   * «Плавность: Авто» просто записывала 30 и ничего больше не значила. Полусостояние
   * «разрешение автоматическое, частота выбрана» обещало то, чего не было, поэтому его нет.
   */
  automatic: boolean;
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
/**
 * Что просить у камеры.
 *
 * Раньше здесь стояли голые числа, а голое число в `getUserMedia` — это `ideal`: камера,
 * которая не умеет 2560×1440, молча отдаёт 1920×1080, и никто об этом не узнаёт. Поэтому
 * запрос идёт диапазоном с `max`, а `capabilities` (когда устройство их сообщает) зажимают
 * его в то, что устройство действительно умеет. Фактический результат всё равно читается
 * из `getSettings()` после захвата и показывается человеку — см. `reportCapture` в session.ts.
 */
export function cameraCapture(profile: ScreenProfile, capabilities?: MediaTrackCapabilities) {
  const width = Math.round((profile.resolution * 16) / 9);
  const height = profile.resolution;
  const cap = (value: number, range?: { max?: number }) =>
    range?.max !== undefined ? Math.min(value, range.max) : value;
  return {
    resolution: {
      width: cap(width, capabilities?.width),
      height: cap(height, capabilities?.height),
      frameRate: cap(profile.fps, capabilities?.frameRate),
    },
  };
}
/**
 * Что камера отдаёт в сеть.
 *
 * Битрейт берётся из той же таблицы, что и у экрана: раньше у камеры была своя формула, и
 * 1440p60 просил 13,6 Мбит/с там, где экран того же уровня просит 16. Одно и то же число
 * в двух местах рано или поздно расходится — теперь оно одно.
 */
export function cameraOptions(profile: ScreenProfile, codec: VideoCodec = 'vp8'): TrackPublishOptions {
  const base = {
    videoCodec: codec,
    backupCodec: codec === 'av1' || codec === 'vp9' ? ({ codec: 'vp8' } as const) : (false as const),
    videoEncoding: { maxBitrate: targetBitrate(profile), maxFramerate: profile.fps },
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
 * Чем подсказать кодировщику, что важнее в этом кадре.
 *
 * До этого камера не получала подсказки вовсе — её задавали только демонстрации экрана. На
 * 60 fps это заметно: без `motion` браузер волен отдать предпочтение резкости и уронить
 * частоту, то есть ровно то, ради чего 60 и выбирают.
 */
export function cameraHint(profile: ScreenProfile): 'motion' | 'detail' {
  return !profile.automatic || profile.fps >= 60 ? 'motion' : 'detail';
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
export function companionCameraOptions(codec: VideoCodec = 'vp8'): TrackPublishOptions {
  return {
    videoCodec: codec,
    backupCodec: codec === 'av1' || codec === 'vp9' ? ({ codec: 'vp8' } as const) : (false as const),
    videoEncoding: { maxBitrate: companionCamera.bitrate, maxFramerate: companionCamera.fps },
    simulcast: false,
    // Лицо в маленькой плитке узнаётся движением, а не резкостью: частота кадров уступает
    // последней. Это тот же выбор, что и для выбранного вручную уровня демонстрации.
    degradationPreference: 'maintain-framerate',
  };
}
/** Умеет ли эта машина кодировать такой поток аппаратно и без рывков. */
async function powerEfficient(contentType: string, profile: ScreenProfile) {
  if (!navigator.mediaCapabilities?.encodingInfo) return false;
  const available = RTCRtpSender.getCapabilities?.('video')?.codecs ?? [];
  if (!available.some((c) => c.mimeType.toLowerCase() === contentType.toLowerCase())) return false;
  try {
    const capability = await navigator.mediaCapabilities.encodingInfo({
      type: 'webrtc',
      video: {
        contentType,
        width: Math.round((profile.resolution * 16) / 9),
        height: profile.resolution,
        bitrate: targetBitrate(profile),
        framerate: profile.fps,
      },
    } as MediaEncodingConfiguration);
    return !!(capability.supported && capability.smooth && capability.powerEfficient);
  } catch {
    /* Conservative baseline when WebRTC encoding information is unavailable. */
    return false;
  }
}
export async function chooseCodec(profile: ScreenProfile): Promise<VideoCodec> {
  for (const [codec, contentType] of [
    ['av1', 'video/AV1'],
    ['vp9', 'video/VP9'],
  ] as const)
    if (await powerEfficient(contentType, profile)) return codec;
  const available = RTCRtpSender.getCapabilities?.('video')?.codecs ?? [];
  return available.some((c) => c.mimeType.toLowerCase() === 'video/h264') ? 'h264' : 'vp8';
}
/**
 * Каким кодеком отдавать камеру.
 *
 * Здесь годами стоял жёсткий VP8 — и это и есть ответ на «заявлено 60 fps, идёт 40». VP8
 * почти нигде не кодируется и не декодируется железом: на 1080p60 кодировщик упирается в
 * процессор и роняет частоту, а у того, кто смотрит, то же самое происходит с декодером.
 *
 * `powerEfficient` — единственный признак аппаратного пути, который браузер вообще сообщает.
 * H.264 идёт первым намеренно: у него аппаратный кодировщик есть почти везде, тогда как
 * VP9/AV1 в железе встречаются реже и их отказ обходится дороже. VP8 остаётся последним —
 * тем, что работает всегда.
 */
export async function chooseCameraCodec(profile: ScreenProfile): Promise<VideoCodec> {
  for (const [codec, contentType] of [
    ['h264', 'video/H264'],
    ['vp9', 'video/VP9'],
    ['av1', 'video/AV1'],
  ] as const)
    if (await powerEfficient(contentType, profile)) return codec;
  const available = RTCRtpSender.getCapabilities?.('video')?.codecs ?? [];
  return available.some((c) => c.mimeType.toLowerCase() === 'video/h264') ? 'h264' : 'vp8';
}
