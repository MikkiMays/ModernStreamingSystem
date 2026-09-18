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
 * Выбранный уровень — это про **верхний** слой, а не про то, что слоёв один.
 *
 * ЗАЧЕМ ЭТО ПЕРЕПИСАНО. Раньше ручной выбор публиковался одним слоем: `simulcast: false`.
 * Рассуждение было такое — simulcast существует, чтобы отдать кому-то копию поменьше, а
 * «шлите, как я выбрал» именно этого и не должно допускать. Оно перепутало две разные вещи.
 * Копия поменьше не заменяет выбранный слой, она **добавляется** рядом с ним: кто тянет,
 * тот и получает верхний. А без неё тому, кто не тянет, отдать нечего вообще — у него
 * картинка замирает там, где могла бы просто стать мельче. Один слой наказывал не автора
 * выбора, а тех, кто на другом конце.
 *
 * Поэтому выбранный уровень остаётся верхним слоем и не понижается ничем: лестница его не
 * трогает (`screenAutomatic`/`cameraAutomatic`), `maintain-framerate` велит кодировщику
 * отдавать частоту последней. Под ним идут два дешёвых слоя — вместе меньше мегабита, —
 * которые существуют только для тех, кому верхний не доехал.
 *
 * Сам канал по-прежнему предел: никакая настройка не заставит связь пронести больше, чем
 * она может. Убрано здесь другое — решение программы отдавать меньше, когда запас есть.
 */
const forcedEncoding = { degradationPreference: 'maintain-framerate' as const };
/**
 * Слои-подпорки под выбранным вручную уровнем.
 *
 * Не «лишь бы что-то было»: приёмник выбирает слой под размер своей плитки, и если между
 * выбранным уровнем и подпоркой пропасть, он падает на дно этой пропасти. С парой 1080p/360p
 * плитка в семьсот пикселей получала 360p — вдвое меньше того, что в неё влезает. Поэтому
 * ступень 720p есть всегда, когда верхний слой выше неё, и **экрану она нужна не меньше**:
 * текст в 360p — это серая рябь, то есть показ формально идёт, а читать в нём нечего.
 *
 * Мегабиты здесь считаются в последнюю очередь: уровень выбран руками, а такой выбор — это
 * согласие платить за него. Экономит «Авто», у которого подпорки свои и дешёвые.
 */
function chosenHelpers(level: Pick<ScreenProfile, 'resolution' | 'fps'>) {
  const layers = [new VideoPreset(640, 360, 500000, 15)];
  if (level.resolution > 720) layers.push(new VideoPreset(1280, 720, 2000000, Math.min(30, level.fps)));
  return layers;
}
/** «Авто» бережёт канал: лицо в мелкой плитке узнаётся движением, а не резкостью. */
function autoCameraHelpers(level: Pick<ScreenProfile, 'resolution' | 'fps'>) {
  return [new VideoPreset(320, 180, 150000, 15), new VideoPreset(640, 360, 500000, Math.min(30, level.fps))];
}
/** «Авто» для экрана: мельче 360p показ бессмыслен, крупнее 720p — уже не подпорка. */
function autoScreenHelpers(level: Pick<ScreenProfile, 'resolution' | 'fps'>) {
  const layers = [new VideoPreset(640, 360, 500000, 15)];
  if (level.resolution > 720) layers.push(new VideoPreset(1280, 720, 2000000, Math.min(30, level.fps)));
  return layers;
}
/**
 * Что просить у источника, чтобы уровень был достижим в принципе.
 *
 * В «Авто» это верх лестницы, а не текущая ступень: захват под текущую ступень означал бы,
 * что подняться выше уже нельзя — источник не отдаст того, чего не снимает.
 */
export function captureCeiling(profile: ScreenProfile): { resolution: Resolution; fps: FrameRate } {
  return profile.automatic ? { resolution: 1440, fps: 60 } : profile;
}
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
  if (!profile.automatic)
    return {
      ...base,
      ...forcedEncoding,
      simulcast: true,
      screenShareSimulcastLayers: chosenHelpers(profile),
    };
  return {
    ...base,
    simulcast: true,
    degradationPreference: 'balanced',
    screenShareSimulcastLayers: autoScreenHelpers(profile),
  };
}
/**
 * Что просить у камеры.
 *
 * Голое число в `getUserMedia` — это `ideal`, то есть пожелание: камера, которая не умеет
 * 2560×1440, молча отдаёт 1920×1080, и никто об этом не узнаёт. `capabilities` (когда
 * устройство их сообщает) заранее зажимают запрос в то, что оно действительно умеет, а
 * фактический результат читается из `getSettings()` после захвата — см. `reportCapture`.
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
 * Частота как требование, а не как пожелание.
 *
 * ЗАЧЕМ. «Выбрал 30 — плашка показывает 22» почти всегда не про кодировщик и не про канал:
 * это сама камера удлиняет выдержку в полумраке и отдаёт кадров меньше, чем умеет. Для
 * `ideal` это законное поведение, и ни битрейт, ни `maxFramerate` на него не влияют — оба
 * только ограничивают сверху. Нижнюю границу задаёт `min`, и только он.
 *
 * Применяется отдельным `applyConstraints`, а не в запросе захвата, намеренно: `min` —
 * жёсткое условие, и в самом `getUserMedia` его отказ означал бы «камера не включилась
 * вовсе». Здесь же отказ стоит ровно того, что было до него, и виден в плашке.
 *
 * Кадр приходится повторять, хотя меняется только частота: `applyConstraints` **заменяет**
 * весь набор ограничений, а не дополняет его, и запрос из одной частоты отпустил бы
 * разрешение на волю устройства.
 *
 * Только для выбранного вручную уровня: в «Авто» частоту двигает лестница, и запрещать ей
 * опускаться значит отменять сам смысл «Авто».
 */
export function forcedCameraConstraints(
  profile: ScreenProfile,
  capabilities?: MediaTrackCapabilities,
): MediaTrackConstraints | null {
  if (profile.automatic) return null;
  const { resolution } = cameraCapture(profile, capabilities);
  return {
    width: { ideal: resolution.width },
    height: { ideal: resolution.height },
    frameRate: { min: resolution.frameRate, ideal: resolution.frameRate },
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
  if (!profile.automatic)
    return { ...base, ...forcedEncoding, simulcast: true, videoSimulcastLayers: chosenHelpers(profile) };
  return {
    ...base,
    simulcast: true,
    degradationPreference: 'maintain-framerate',
    videoSimulcastLayers: autoCameraHelpers(profile),
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
