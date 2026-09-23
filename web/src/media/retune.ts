import type { LocalVideoTrack } from 'livekit-client';
import { layerTunes, type LayerShape, type ScreenProfile } from './profiles';

/**
 * Ступень лестницы качества — на работающей дорожке, без переопубликации.
 *
 * Переопубликация — это новая дорожка у каждого зрителя: плитка гаснет, подписка начинается с
 * нижнего слоя, полоса разгоняется заново. Здесь то же решение делается тремя числами у слоёв,
 * которые уже идут (`RTCRtpSender.setParameters`): зритель остаётся на той же дорожке, и кадр
 * меняется внутри потока. Почему числа именно такие — `layerTunes` в profiles.ts.
 */

/**
 * С какими подпорками дорожку опубликовали. От этого считается любая ступень: если считать от
 * уже подстроенных слоёв, подпорка, однажды ужатая под низкую ступень, не выросла бы обратно.
 *
 * `source` — массив исходных слоёв, который LiveKit держит у дорожки. Он меняется, когда
 * LiveKit сам пересчитывает слои (после `restartTrack` с другой камерой), и тогда запись
 * снимается заново: у новой камеры другой кадр.
 */
interface Layout {
  source: unknown;
  helpers: LayerShape[];
}
const layouts = new WeakMap<RTCRtpSender, Layout>();

/** То, что LiveKit держит у дорожки и не объявляет публичным: исходные слои и замок отправителя. */
interface Internals {
  encodings?: RTCRtpEncodingParameters[];
  senderLock?: { lock(): Promise<() => void> };
}

function shortSide(track: LocalVideoTrack) {
  const { width = 0, height = 0 } = track.mediaStreamTrack.getSettings();
  return Math.min(width, height);
}

/**
 * Запомнить опубликованную раскладку слоёв. Звать до того, как менять захват: подпорки
 * записываются в пикселях того кадра, с которым их публиковали.
 */
export function rememberLayout(track: LocalVideoTrack): boolean {
  const sender = track.sender;
  if (!sender) return false;
  const published = (track as unknown as Internals).encodings;
  const known = layouts.get(sender);
  if (known && known.source === published) return true;
  const encodings = published ?? sender.getParameters().encodings;
  const short = shortSide(track);
  if (!encodings?.length || !short) return false;
  layouts.set(sender, {
    source: published,
    helpers: encodings.slice(0, -1).map((encoding) => ({
      height: Math.round(short / (encoding.scaleResolutionDownBy ?? 1)),
      bitrate: encoding.maxBitrate ?? 0,
      fps: encoding.maxFramerate ?? 30,
    })),
  });
  return true;
}

/**
 * Перевести опубликованную дорожку на ступень `level`.
 *
 * @returns false, если сделать это на месте нельзя (дорожка не опубликована, число слоёв не
 * то, что было записано) — тогда вызывающий волен переопубликовать по-старому.
 */
export async function retune(
  track: LocalVideoTrack,
  level: Pick<ScreenProfile, 'resolution' | 'fps'>,
): Promise<boolean> {
  if (!rememberLayout(track)) return false;
  const sender = track.sender!;
  const tunes = layerTunes(shortSide(track), level, layouts.get(sender)!.helpers);
  // Тот же замок, под которым LiveKit гасит и зажигает слои (dynacast): `setParameters` верен
  // только против последнего `getParameters`, и два писателя вперемешку теряют правки друг друга.
  const lock = (track as unknown as Internals).senderLock;
  const unlock = lock ? await lock.lock() : undefined;
  try {
    const params = sender.getParameters();
    if (params.encodings?.length !== tunes.length) return false;
    params.encodings.forEach((encoding, index) => {
      // Firefox не умеет `active: false`, и LiveKit гасит там слой битрейтом в 10 бит/с. Вернуть
      // такому слою настоящий битрейт значит включить то, что выключили намеренно.
      if (encoding.maxBitrate !== undefined && encoding.maxBitrate <= 10) return;
      Object.assign(encoding, tunes[index]);
    });
    await sender.setParameters(params);
    return true;
  } finally {
    unlock?.();
  }
}
