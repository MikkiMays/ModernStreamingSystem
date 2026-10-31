import { CODECS, codecMime, isCodec, type Codec } from './codec-policy';

/**
 * Что этот браузер декодирует — для чужого выбора кодека (R152, Р-47 п. 3).
 *
 * ЗАЧЕМ. Издатель берёт основной кодек, только если его декодируют все зрители, иначе держит рядом
 * H.264 (политика SIMULCAST) или спускается по лестнице. Узнать это от SFU нельзя: LiveKit сам
 * переводил комнату на запасной по первому несовместимому зрителю (`PREFER_REGRESSION`). Атрибуты
 * LiveKit тоже не годятся — права на данные участникам не выдаются (`CanPublishData(false)`).
 * Поэтому — командой ядра `media.decode` в поле участника снимка (`decodes`).
 *
 * ЧТО СЧИТАЕТСЯ «ДЕКОДИРУЕТ». Кодек есть в `RTCRtpReceiver.getCapabilities('video')` и
 * `decodingInfo({type:'webrtc'})` говорит «поддержан и плавно» на 1080p30. На телефоне AV1 и H.265 —
 * только в железе: программный AV1 1080p телефон греет и не тянет.
 */
const PROBE = { width: 1920, height: 1080, bitrate: 6_000_000, framerate: 30 };

export async function decodableCodecs(mobile: boolean): Promise<Codec[]> {
  const listed = new Set(
    (globalThis.RTCRtpReceiver?.getCapabilities?.('video')?.codecs ?? []).map((c) =>
      c.mimeType.toLowerCase(),
    ),
  );
  const result: Codec[] = [];
  for (const codec of CODECS) {
    if (!listed.has(codecMime[codec].toLowerCase())) continue;
    // VP8 и H.264 WebRTC декодирует всегда, где они перечислены.
    if (codec === 'vp8' || codec === 'h264') {
      result.push(codec);
      continue;
    }
    const info = await decodeInfo(codecMime[codec]);
    if (info === null) {
      // Спросить нечем (старый Safari) — перечисленному верим.
      result.push(codec);
      continue;
    }
    const strict = mobile && (codec === 'av1' || codec === 'h265');
    if (info.supported && info.smooth !== false && (!strict || info.powerEfficient)) result.push(codec);
  }
  return result;
}

async function decodeInfo(contentType: string): Promise<MediaCapabilitiesDecodingInfo | null> {
  if (typeof navigator === 'undefined' || !navigator.mediaCapabilities?.decodingInfo) return null;
  try {
    return await navigator.mediaCapabilities.decodingInfo({
      type: 'webrtc',
      video: { contentType, ...PROBE },
    } as MediaDecodingConfiguration);
  } catch {
    return null;
  }
}

/**
 * Набор кодеков словом для поля `option` команды: `av1-h265-vp9-h264-vp8` — по порядку лестницы, без
 * повторов; в 24 знака поля влезает весь набор (21).
 */
export function decodesOption(codecs: readonly Codec[]): string {
  return CODECS.filter((codec) => codecs.includes(codec)).join('-');
}

/** Поле `decodes` участника из снимка: список известных кодеков или `null` — не сообщал. */
export function parseDecodes(value: unknown): Codec[] | null {
  if (!Array.isArray(value)) return null;
  return CODECS.filter((codec) => value.some((item) => isCodec(item) && item === codec));
}
