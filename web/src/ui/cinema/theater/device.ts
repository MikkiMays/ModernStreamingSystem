/**
 * Что умеет это устройство с видео — то, от чего зависит, как плеер догоняет комнату и какой кодек берёт
 * (R216, жалоба владельца с телевизора 09.11.2026).
 *
 * СКОРОСТЬ. Комната догоняет небольшое расхождение скоростью 0,9–1,1 (`core/watch.ts`). На компьютере и
 * телефоне это незаметно: браузер держит высоту тона (`preservesPitch`). Телевизоры (Tizen, webOS и
 * их родня) играют скорость ≠ 1 своим конвейером как «перемотку с просмотром» и звук на это время глушат,
 * а движок без `preservesPitch` меняет тон. Там скорость не трогаем: расхождение до перемотки терпим.
 *
 * КОДЕК. В мастере YouTube одна и та же высота есть в H.264 и в VP9, и hls.js сам берёт VP9 (он дешевле
 * по байтам). Но VP9 честен только там, где его декодирует железо: программный декодер 1080p60 на
 * телевизоре или слабом ноутбуке рядом со звонком — это потерянные кадры и зависания. H.264 железо
 * декодирует везде. Поэтому VP9 — только если `MediaCapabilities` обещает плавно и экономно
 * (`smooth` и `powerEfficient`), иначе — H.264.
 */

/** Признаки телевизора и приставки в строке браузера: Samsung, LG, Sony, Philips, Hisense, Android TV… */
const TV =
  /\b(?:SMART-?TV|SmartTV|Tizen|Web0S|webOS|NetCast|HbbTV|BRAVIA|AFT[A-Z]{1,4}|CrKey|GoogleTV|Android ?TV|MiTV|VIDAA|Hisense|Viera|NETTV|PhilipsTV|Roku|PlayStation|Xbox|YNDX-|SberBox|SaluteTV|Opera TV|DTV)\b/i;

export interface MediaProfile {
  /** Телевизор или приставка. */
  tv: boolean;
  /** Можно ли догонять комнату скоростью воспроизведения. */
  rateSafe: boolean;
}

export function mediaProfile(signals: { userAgent: string; element?: object | null }): MediaProfile {
  const tv = TV.test(signals.userAgent);
  const element = signals.element ?? {};
  const pitch =
    'preservesPitch' in element || 'webkitPreservesPitch' in element || 'mozPreservesPitch' in element;
  return { tv, rateSafe: !tv && pitch };
}

let current: MediaProfile | null = null;

/** Профиль этого браузера — один раз на вкладку. */
export function deviceProfile(): MediaProfile {
  if (current) return current;
  const element = typeof document === 'undefined' ? null : document.createElement('video');
  current = mediaProfile({ userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent, element });
  return current;
}

/** Самая тяжёлая ступень VP9 у YouTube, на которую плеер пойдёт без ручного выбора. */
const VP9 = {
  contentType: 'video/mp4; codecs="vp09.00.41.08"',
  width: 1920,
  height: 1080,
  bitrate: 5_000_000,
  framerate: 60,
};
/** Дольше этого ответа `MediaCapabilities` не ждём: первый кадр важнее. */
const ASK_MS = 400;

/**
 * Какой кодек картинки просить у hls.js: `'avc1'` (H.264) — или `undefined`, когда VP9 устройству по силам
 * (`smooth` и `powerEfficient` у `MediaCapabilities.decodingInfo`), и выбирать можно самому hls.js.
 */
export async function preferredVideoCodec(
  profile: MediaProfile,
  capabilities: Pick<MediaCapabilities, 'decodingInfo'> | undefined = typeof navigator === 'undefined'
    ? undefined
    : navigator.mediaCapabilities,
): Promise<'avc1' | undefined> {
  if (profile.tv || !capabilities?.decodingInfo) return 'avc1';
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ASK_MS);
    });
    const info = await Promise.race([capabilities.decodingInfo({ type: 'media-source', video: VP9 }), late]);
    return info?.supported && info.smooth && info.powerEfficient ? undefined : 'avc1';
  } catch {
    return 'avc1';
  } finally {
    clearTimeout(timer);
  }
}
