import { demotedFamilies, type VideoFamily } from './decode';

/**
 * Что умеет это устройство с видео — то, от чего зависит, как плеер догоняет комнату и какой кодек берёт
 * (R216, жалоба владельца с телевизора 09.11.2026).
 *
 * СКОРОСТЬ. Комната догоняет небольшое расхождение скоростью 0,9–1,1 (`core/watch.ts`). На компьютере и
 * телефоне это незаметно: браузер держит высоту тона (`preservesPitch`). Телевизоры (Tizen, webOS и
 * их родня) играют скорость ≠ 1 своим конвейером как «перемотку с просмотром» и звук на это время глушат,
 * а движок без `preservesPitch` меняет тон. Там скорость не трогаем: расхождение до перемотки терпим.
 *
 * КОДЕК. В мастере YouTube одна и та же высота есть в H.264, VP9, а у части роликов и в AV1. AV1 и VP9
 * дешевле по байтам, но честны только там, где их декодирует железо: программный декодер 1080p60 на
 * телевизоре или слабом ноутбуке рядом со звонком — это потерянные кадры и зависания. H.264 железо
 * декодирует везде. Поэтому AV1, затем VP9 — только если `MediaCapabilities` обещает плавно и экономно
 * (`smooth` и `powerEfficient`), иначе — H.264 (`videoCodecs`). По ходу просмотра кодек облегчается сам,
 * если устройство не тянет (`decode.ts`); человек выбирает только высоту.
 */

/**
 * Признаки телевизора и приставки в строке браузера: Samsung (Tizen, Samsung Internet для ТВ), LG (webOS),
 * Sony, Philips, Panasonic, Android TV, Fire TV, Chromecast, Яндекс и Сбер, консоли.
 *
 * Строки Samsung, которые должны узнаваться (R216, телевизор владельца — Samsung со своим браузером):
 * `(SMART-TV; LINUX; Tizen 6.5) … TV Safari/537.36`, `(SMART-TV; Linux; Tizen 7.0) … SamsungBrowser/5.2
 * Chrome/94… TV Safari/537.36`, `(Linux; Tizen 8.0) … SamsungBrowser/7.0 … TV Safari/537.36`. Телефон Samsung —
 * `SamsungBrowser/… Mobile Safari`, без `TV` и без `Tizen`.
 */
const TV =
  /\b(?:SMART-?TV|Smart ?TV|Tizen|Web0S|webOS|NetCast|HbbTV|BRAVIA|AFT[A-Z]{1,4}|CrKey|GoogleTV|Android ?TV|MiTV|MIBOX\d*|VIDAA|Viera|NETTV|PhilipsTV|Roku|PlayStation|Xbox|SberBox|SaluteTV|Opera TV|TV Safari)\b|\bSamsungBrowser\/[\d.]+\b(?=.*\bTV\b)/i;
/**
 * Признаки, которые бывают и у телефонов: Hisense и `YNDX-` выпускали и телефоны (`Hisense E50`, «Яндекс
 * Телефон» `YNDX-000SB`), `DTV` встречается в моделях. Они значат телевизор, только если браузер не
 * мобильный (`Mobile` у Chrome и Samsung Internet на телефонах есть всегда).
 */
const TV_WEAK = /\b(?:Hisense|YNDX-|DTV)\b/i;

export interface MediaProfile {
  /** Телевизор или приставка. */
  tv: boolean;
  /** Можно ли догонять комнату скоростью воспроизведения. */
  rateSafe: boolean;
}

export function mediaProfile(signals: { userAgent: string; element?: object | null }): MediaProfile {
  const agent = signals.userAgent;
  const tv = TV.test(agent) || (TV_WEAK.test(agent) && !/\bMobile\b/.test(agent));
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

/**
 * Самые тяжёлые ступени AV1 и VP9 у YouTube, на которые плеер пойдёт без ручного выбора: 1080p60. Обещание
 * «плавно и экономно» для них — значит, декодер железный и потянет всё, что ниже.
 */
const PROBES: Record<'av01' | 'vp09', VideoConfiguration> = {
  av01: {
    contentType: 'video/mp4; codecs="av01.0.09M.08"',
    width: 1920,
    height: 1080,
    bitrate: 4_000_000,
    framerate: 60,
  },
  vp09: {
    contentType: 'video/mp4; codecs="vp09.00.41.08"',
    width: 1920,
    height: 1080,
    bitrate: 5_000_000,
    framerate: 60,
  },
};
/** Дольше этого ответа `MediaCapabilities` не ждём: первый кадр важнее. */
const ASK_MS = 400;

/**
 * Какими кодеками картинки устройство играет лучше всего — по порядку: AV1 и VP9, если `MediaCapabilities`
 * обещает их плавно и экономно (`smooth` и `powerEfficient`, то есть железом), и H.264 — всегда последним.
 * Кодек, от которого это устройство недавно отказалось посреди просмотра (`decode.ts`, `demoted`), не
 * предлагается. Телевизору — только H.264: его браузерным обещаниям про VP9 и AV1 верить нельзя, а H.264
 * железо телевизора декодирует всегда (Samsung Tizen, LG webOS).
 */
export async function videoCodecs(
  profile: MediaProfile,
  capabilities: Pick<MediaCapabilities, 'decodingInfo'> | undefined = typeof navigator === 'undefined'
    ? undefined
    : navigator.mediaCapabilities,
  demoted: ReadonlySet<VideoFamily> = demotedFamilies(),
): Promise<VideoFamily[]> {
  if (profile.tv || !capabilities?.decodingInfo) return ['avc1'];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ASK_MS);
  });
  const fits = async (family: 'av01' | 'vp09') => {
    if (demoted.has(family)) return false;
    try {
      const info = await Promise.race([
        capabilities.decodingInfo({ type: 'media-source', video: PROBES[family] }),
        late,
      ]);
      return !!(info?.supported && info.smooth && info.powerEfficient);
    } catch {
      return false;
    }
  };
  try {
    const [av1, vp9] = await Promise.all([fits('av01'), fits('vp09')]);
    return [...(av1 ? (['av01'] as const) : []), ...(vp9 ? (['vp09'] as const) : []), 'avc1'];
  } finally {
    clearTimeout(timer);
  }
}
