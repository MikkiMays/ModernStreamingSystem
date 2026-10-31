import { BackupCodecPolicy, type TrackPublishOptions } from 'livekit-client';
import { BASELINE, type PolicyLevel, type PolicySource, type PublishShape } from './codec-policy';

/** 480 — только у камеры (`CAMERA_RESOLUTIONS`); показ начинается с 720. */
export type Resolution = 480 | 720 | 1080 | 1440;
export type FrameRate = 15 | 30 | 60;
/**
 * Уровень отдачи, выбранный человеком: кадр и частота.
 *
 * «Авто» здесь больше нет (T44, П2). Оно было лестницей, которая начиналась с середины,
 * спускалась до 720p15 и пробовала вверх сама, — и это и был «начал показ, а там 15 fps».
 * Уровень по умолчанию и потолок задаёт сервер (`media/capabilities.ts`), выбранное публикуется
 * сразу и ничем не понижается (R91, X10): выбранное — нижняя граница.
 */
export interface ScreenProfile {
  resolution: Resolution;
  fps: FrameRate;
  /** Режим показа (R95). Нет — `smooth`: так читают старые записи и камера. */
  mode?: ScreenMode;
  /** Слать ли зрителям превью показа (R80). Нет — да. */
  preview?: boolean;
  /**
   * Звук показа, выбранный в окне показа клиента Windows в прошлый раз (R60): окно открывается с
   * ним. Нет — без звука. Сам звук берёт оболочка (`core/desktop-capture.ts`), здесь — только память.
   */
  audio?: ScreenAudio;
}
/** Звук показа в клиенте Windows: без звука, весь звук системы, звук приложения, система кроме Cord. */
export type ScreenAudio = 'none' | 'system' | 'app' | 'system-except-cord';
export const screenAudios: readonly ScreenAudio[] = ['none', 'system', 'app', 'system-except-cord'];
/**
 * Два режима показа, как у Discord («Игры» / «Пользовательские», R95).
 *
 * `smooth` — игры и видео: выбранная частота, полоса под движение. `sharp` — текст, рабочий стол,
 * презентации: чёткость всегда, при нехватке полосы кодировщик сбрасывает кадры (5–10 fps —
 * как у Телемоста), разрешение не трогается ни в одном режиме (X10).
 */
export type ScreenMode = 'smooth' | 'sharp';
export const screenModes: ScreenMode[] = ['smooth', 'sharp'];
export const defaultScreenMode: ScreenMode = 'smooth';
export const modeOf = (profile: Pick<ScreenProfile, 'mode'>): ScreenMode =>
  profile.mode === 'sharp' ? 'sharp' : 'smooth';
const bitrates = {
  480: { 15: 0.75, 30: 1.2, 60: 2 },
  720: { 15: 1.5, 30: 3, 60: 5 },
  1080: { 15: 3, 30: 6, 60: 10 },
  1440: { 15: 5, 30: 10, 60: 16 },
};
/**
 * Полоса режима «чёткость» не зависит от частоты: кадров там столько, сколько влезает, а
 * каждый — почти ключевой. Два мегабита на 720p, четыре на 1080p, шесть на 1440p (§9.2).
 */
const sharpBitrates: Record<Resolution, number> = { 480: 1, 720: 2, 1080: 4, 1440: 6 };
/** What a level asks of the link, in bits per second. */
export function targetBitrate(level: Pick<ScreenProfile, 'resolution' | 'fps' | 'mode'>) {
  if (modeOf(level) === 'sharp') return sharpBitrates[level.resolution] * 1000000;
  return bitrates[level.resolution][level.fps] * 1000000;
}
/**
 * Что просить у `getDisplayMedia` (или у оболочки) под выбранный уровень.
 *
 * `ideal`, а не `exact`: экран меньше запрошенного не растянуть, и требовать этого нельзя —
 * `exact` означал бы отказ захватывать вовсе. Частота — и `ideal`, и `max`: больше выбранного
 * браузер не отдаёт, меньше — отдаёт только если не может (в `sharp` это ожидаемо).
 */
export function captureConstraints(
  profile: Pick<ScreenProfile, 'resolution' | 'fps'>,
): MediaTrackConstraints {
  return {
    width: { ideal: Math.round((profile.resolution * 16) / 9) },
    height: { ideal: profile.resolution },
    frameRate: { ideal: profile.fps, max: profile.fps },
  };
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
/**
 * Показ экрана: выбранное — нижняя граница, а не цель (R91, X10).
 *
 * ЗАЧЕМ ЭТО ПЕРЕПИСАНО. Экран публиковался как камера: `contentHint = 'motion'`,
 * `degradationPreference: 'maintain-framerate'` и simulcast из трёх слоёв. Для Chromium это
 * значило: quality scaler включён, адаптация разрешения разрешена, три кодировщика на машине
 * стримящего. Статичный экран выглядел чётко, а стоило подвигать окно — QP рос, scaler резал
 * разрешение, и «пиксели в движении» были не сбоем, а штатной работой этих трёх настроек.
 *
 * ЧТО ВМЕСТО. `screenHint = 'detail'` переводит кодировщик в screencast-режим: инструменты
 * для текста (screen content tools VP9/AV1), без шумодава, **без quality scaler и без
 * понижения разрешения** — при нехватке полосы libwebrtc сбрасывает кадры, а не чёткость.
 * `maintain-resolution` говорит то же самое про перегрузку процессора. Один слой вместо трёх:
 * один кодировщик, а зрителю со слабым каналом SFU отдаёт меньше кадров того же размера
 * (временные слои `L1T3` у VP9/AV1), не трогая поток у остальных. `priority: 'high'` — при
 * дележе полосы с камерой экран первый.
 */
export const screenHint = 'detail' as const;
/**
 * Запасной кодек — рядом, а не вместо (Р-47): `SIMULCAST` вместо умолчания LiveKit `PREFER_REGRESSION`,
 * при котором один зритель без декодера VP9/AV1/H.265 переводил на H.264 всю комнату. Копию SFU
 * просит у издателя только когда её действительно подписывает несовместимый зритель.
 */
function backupOptions(shape: PublishShape): Pick<TrackPublishOptions, 'backupCodec' | 'backupCodecPolicy'> {
  return shape.backup
    ? { backupCodec: { codec: shape.backup }, backupCodecPolicy: BackupCodecPolicy.SIMULCAST }
    : { backupCodec: false };
}
/**
 * Опции публикации показа из решения политики (`codec-policy.ts`): кодек, слои и запасной — оттуда,
 * полоса и частота — из уровня. Без решения — VP8 одним слоем.
 *
 * `maintain-resolution` держит разрешение У ИЗДАТЕЛЯ (X10): он роняет кадры, не чёткость. Слоями
 * (simulcast) публикует только клиент Windows (Р-36, Р-47): слабому зрителю «Go Live» SFU отдаёт версию
 * поменьше вместо фриза — сознательно ослабляем X10 для приёмника, не для издателя.
 */
export function screenOptions(profile: ScreenProfile, shape: PublishShape = BASELINE): TrackPublishOptions {
  return {
    videoCodec: shape.codec,
    ...backupOptions(shape),
    screenShareEncoding: {
      maxBitrate: targetBitrate(profile),
      maxFramerate: profile.fps,
      priority: 'high',
    },
    degradationPreference: 'maintain-resolution',
    simulcast: shape.simulcast,
    ...(shape.scalabilityMode ? { scalabilityMode: shape.scalabilityMode } : {}),
  };
}
/** Источник политики: камера или показ в своём режиме. */
export const policySourceOf = (
  kind: 'camera' | 'screen',
  profile: Pick<ScreenProfile, 'mode'>,
): PolicySource =>
  kind === 'camera' ? 'camera' : modeOf(profile) === 'sharp' ? 'screen-sharp' : 'screen-smooth';
/**
 * Под что спрашивать кодировщик (`encodingInfo`): тот кадр, частота и битрейт, что пойдут в сеть. Кадр
 * камеры — как его просит `cameraCapture`, экрана — 16:9 выбранной высоты.
 */
export function policyLevel(kind: 'camera' | 'screen', profile: ScreenProfile): PolicyLevel {
  const width =
    kind === 'camera'
      ? cameraCapture(profile).resolution.width
      : Math.round((profile.resolution * 8) / 9) * 2;
  return {
    width,
    height: profile.resolution,
    fps: profile.fps,
    bitrate: targetBitrate(kind === 'camera' ? { ...profile, mode: 'smooth' } : profile),
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
  // Чётная ширина: 480 × 16/9 = 853,3, а кодировщику нужен чётный кадр — 854.
  const width = Math.round((profile.resolution * 8) / 9) * 2;
  const height = profile.resolution;
  const cap = (value: number, range?: { max?: number }) =>
    range?.max !== undefined ? Math.min(value, range.max) : value;
  return {
    resolution: {
      width: cap(width, capabilities?.width),
      height: cap(height, capabilities?.height),
      frameRate: cap(profile.fps, capabilities?.frameRate),
    },
    // Зум (R36) — только у телефона: без этой просьбы Chromium на Android не отдаёт
    // `getCapabilities().zoom`. На компьютере не просим: у веб-камеры с PTZ `zoom: true` поднимает
    // отдельный вопрос «использовать и перемещать камеру» — и у тех, кто камеру уже разрешил, — а в
    // клиенте Windows такого разрешения нет вовсе. Камера без зума просьбу молча пропускает.
    ...(touchFirst() ? { zoom: true } : {}),
  };
}

/** Основной указатель — палец (телефон, планшет): у ноутбука с сенсорным экраном основной — мышь. */
export function touchFirst(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}
/**
 * Что просить у камеры для превью (настройки, предпросмотр): тот же кадр и частота, что пойдут во
 * встречу, но пожеланием — превью не повод для отказа камеры.
 */
export function previewConstraints(profile: ScreenProfile): MediaTrackConstraints {
  const { width, height, frameRate } = cameraCapture(profile).resolution;
  return { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: frameRate } };
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
 * ПОЧЕМУ ЭТО ЛЕСТНИЦА, А НЕ ОДНА ПРОСЬБА. `min` — жёсткое условие, а размер кадра просился
 * как `ideal`, то есть как пожелание. Для камеры, которая умеет 60 кадров только в 720p —
 * а таких большинство, 1080p60 живёт в MJPEG и далеко не везде, — это означало вот что:
 * человек выбирал 1080p60 и молча получал 720p, растянутый до 1080. «Принудительное
 * качество хуже автоматического» — это оно и есть.
 *
 * Выбранное разрешение важнее выбранной частоты: в списке оно и называется «Качество», а
 * частота — «Плавность». Поэтому сначала просим и то и другое жёстко, потом отпускаем
 * частоту, оставив кадр, и лишь напоследок отпускаем всё. Первое, что камера согласится
 * выполнить, тем разговор и пойдёт, а недобор честно виден в плашке отдачи.
 */
export function forcedCameraConstraints(
  profile: ScreenProfile,
  capabilities?: MediaTrackCapabilities,
): MediaTrackConstraints[] {
  const { resolution } = cameraCapture(profile, capabilities);
  const frame = {
    width: { min: resolution.width, ideal: resolution.width },
    height: { min: resolution.height, ideal: resolution.height },
  };
  return [
    { ...frame, frameRate: { min: resolution.frameRate, ideal: resolution.frameRate } },
    { ...frame, frameRate: { ideal: resolution.frameRate } },
    {
      width: { ideal: resolution.width },
      height: { ideal: resolution.height },
      frameRate: { ideal: resolution.frameRate },
    },
  ];
}
/**
 * Что камера отдаёт в сеть: ровно выбранный уровень, как показ экрана (`screenOptions`).
 *
 * ЗАЧЕМ БЕЗ СЛОЁВ. Камера публиковалась simulcast: выбранный уровень и под ним подпорка 360p на
 * 15 кадров. Какой слой отдать зрителю, решал сервер — по высоте плитки, — и у телефона, который
 * держат вертикально, подпорка 360×640 по высоте «годилась» в основную плитку компьютера. Верхний
 * слой засыпал, телефон показывал «640p · 15 fps» при выставленных 720p30, зритель видел мыло.
 * Выставленное должно идти таким, как выставили, а не «стремиться» к нему, — значит, слой один.
 *
 * `maintain-resolution` — как у экрана: при нехватке канала или процессора кодировщик сбрасывает
 * кадры, а кадр не уменьшает; недобор виден в плашке с причиной (`outbound-note.ts`). Зрителю со
 * слабым каналом VP9/AV1 отдают меньше кадров того же размера (временные слои `L1T3`).
 *
 * Битрейт берётся из той же таблицы, что и у экрана: одно и то же число в двух местах рано или
 * поздно расходится.
 *
 * СЛОИ (Р-36 → Р-47). Р-32 убрал подпорки, потому что сервер выбирал слой по высоте плитки и
 * ронял портрет телефона в 360p. Тот баг — про ИЗДАТЕЛЯ-телефон: десктоп держат горизонтально, у него
 * мощная машина и хороший канал (как у Discord). Поэтому слоями публикует только клиент Windows, и с
 * 31.10.2026 это simulcast из слоёв `L1T3`/`L1T1`, каждый — отдельная аппаратная сессия, а не K-SVC
 * `L3T3_KEY`: пространственных слоёв Media Foundation не кодирует вовсе («MediaFoundation does not
 * support spatial layer encoding»), и `L3T3_KEY` молча уходил в libvpx → `cpu` → H.264. K-SVC остался
 * только там, где кодирует и так процессор и ядер хватает. Телефон и веб — одним слоем (Р-32). Какую
 * форму брать, решает `codec-policy.ts`; здесь — только опции LiveKit из неё.
 */
export function cameraOptions(profile: ScreenProfile, shape: PublishShape = BASELINE): TrackPublishOptions {
  return {
    videoCodec: shape.codec,
    ...backupOptions(shape),
    videoEncoding: { maxBitrate: targetBitrate(profile), maxFramerate: profile.fps },
    degradationPreference: 'maintain-resolution',
    simulcast: shape.simulcast,
    ...(shape.scalabilityMode ? { scalabilityMode: shape.scalabilityMode } : {}),
  };
}
/** Слой simulcast так, как он был опубликован: короткая сторона кадра, битрейт и частота. */
export interface LayerShape {
  height: number;
  bitrate: number;
  fps: number;
}
/** Что сказать кодировщику про один слой — ровно три поля `RTCRtpEncodingParameters`. */
export interface LayerTune {
  scaleResolutionDownBy: number;
  maxBitrate: number;
  maxFramerate: number;
}
/**
 * Слои под новый уровень отдачи — на лету, без переопубликации.
 *
 * ЗАЧЕМ. Раньше каждый шаг лестницы снимал камеру с публикации и публиковал заново. У зрителя
 * это новая дорожка: плитка гаснет, подписка начинается с нижнего слоя, битрейт разгоняется
 * заново с одного мегабита — то самое «камера моргнула, полсекунды мыло, потом нормально».
 * Так же подстраиваются слои после смены устройства (`reapplyCameraLevel`).
 *
 * Уровень — это три числа у существующих слоёв: во сколько раз ужать кадр, сколько битрейта и
 * кадров разрешить. Их браузер меняет в работающем кодировщике (`setParameters`), и зритель
 * продолжает ту же дорожку: кадр просто становится другим внутри потока.
 *
 * Верхний слой становится уровнем. Подпорки остаются собой, пока они мельче слоя над ними;
 * если уровень опустился до размера подпорки, та ужимается вдвое от слоя выше, а битрейт —
 * пропорционально площади: две одинаковые копии одного кадра — это вдвое больше работы и
 * мегабит ровно тогда, когда удержание спустилось, чтобы их сэкономить.
 *
 * @param sourceShort короткая сторона того, что сейчас снимается
 * @param helpers подпорки снизу вверх — так, как их опубликовали
 * @returns параметры слоёв снизу вверх, на один больше, чем подпорок
 */
export function layerTunes(
  sourceShort: number,
  level: Pick<ScreenProfile, 'resolution' | 'fps'>,
  helpers: LayerShape[],
): LayerTune[] {
  const scale = (height: number) => Math.max(1, sourceShort / Math.max(2, height));
  const top = Math.min(sourceShort, level.resolution);
  const tunes: LayerTune[] = [
    { scaleResolutionDownBy: scale(top), maxBitrate: targetBitrate(level), maxFramerate: level.fps },
  ];
  let above = top;
  for (let index = helpers.length - 1; index >= 0; index--) {
    const helper = helpers[index]!;
    const height = helper.height < above * 0.85 ? helper.height : Math.round(above / 2);
    const area = Math.min(1, (height / Math.max(1, helper.height)) ** 2);
    tunes.unshift({
      scaleResolutionDownBy: scale(height),
      maxBitrate: Math.max(100000, Math.round(helper.bitrate * area)),
      maxFramerate: Math.min(helper.fps, level.fps),
    });
    above = height;
  }
  return tunes;
}
/**
 * Чем подсказать кодировщику, что это за кадр.
 *
 * `motion` — живое видео: шумодав и настройки под лица, а не screencast-режим экрана (`detail`).
 * Что уступать при нехватке, задаёт не подсказка, а `degradationPreference` в `cameraOptions`.
 */
export const cameraHint = 'motion' as const;
