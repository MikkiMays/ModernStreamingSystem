/**
 * Звук и текст чужого ролика: на каком языке он говорит и чем его подписать.
 *
 * ПОЧЕМУ ЭТО ВООБЩЕ ЕСТЬ. У ролика с озвучками YouTube кладёт в плейлист два десятка
 * звуковых дорожек и **ни одну** не помечает основной: у всех подряд стоит `DEFAULT=NO`.
 * Плеер в таком случае берёт первую по списку, а список у площадки отсортирован по коду
 * языка — арабский, бенгальский, немецкий, французский. Так английский ролик и начинал
 * говорить по-французски: выбора не было, был порядок строк.
 *
 * Оригинал у YouTube узнаётся двумя способами, и здесь используются оба: подпись дорожки
 * заканчивается на `- original` (у переозвучек — `- dubbed`), а сам ролик знает свой язык и
 * присылает его отдельным полем. Если не сошлось ни то, ни другое — остаётся первая дорожка,
 * то есть ровно прежнее поведение, но уже как последнее средство, а не как единственное.
 *
 * Названия языков здесь **не** берутся у площадки. Она пишет их по-своему («Français»,
 * «日本語», «Korean (Original)»), а меню должно читаться на языке того, кто в него смотрит.
 */
import type { CinemaCaption } from '../../../core/cinema';

/** Столько от дорожки HLS нужно для выбора; остальное у `hls.js` своё. */
export interface MediaTrack {
  name: string;
  lang?: string;
}

export interface AudioChoice {
  /** Место дорожки в `hls.audioTracks`. */
  index: number;
  label: string;
  /** Голос автора, а не переозвучка. */
  original: boolean;
}

/**
 * Выбор текста. `track` — номер дорожки в плейлисте, `url` — отдельный файл от нашего
 * сервера; одновременно бывает только одно из двух.
 */
export interface CaptionChoice {
  /** Чем выбор запоминается между роликами: язык и то, распознан он или написан. */
  id: string;
  label: string;
  auto: boolean;
  track: number;
  url?: string;
}

const ORIGINAL = /\s[-–—]\s*original\s*$/i;
const DUBBED = /\s[-–—]\s*dubbed\s*$/i;

/**
 * Языки у площадок написаны как попало: `en-US`, `ko-orig`, `zh-Hans`, `es-419`.
 *
 * Сравниваются они по тому же правилу, по которому это делает и сам плеер: совпали целиком
 * или один начинается с другого. Иначе выбранный «русский» не нашёл бы `ru-RU`, а `en`
 * разошёлся бы с `en-US` — то есть с самым частым способом записать «оригинал».
 */
export function sameLanguage(one: string | undefined, other: string | undefined): boolean {
  const first = (one ?? '').toLowerCase();
  const second = (other ?? '').toLowerCase();
  if (!first || !second) return false;
  return first.length === second.length
    ? first === second
    : first.startsWith(second) || second.startsWith(first);
}

let display: Intl.DisplayNames | undefined | null;
/**
 * Название языка по-русски: `ko` — «Корейский», `en-US` — «Английский (США)».
 *
 * Запасной вариант — подпись самой площадки: она есть всегда, просто написана на чужом
 * языке. Пустой ответ тоже бывает: у выдуманных кодов вроде `ko-orig` названия нет.
 */
export function languageName(code: string | undefined, fallback = ''): string {
  const clean = (code ?? '').replace(/-orig$/i, '');
  if (clean) {
    if (display === undefined) {
      try {
        display = new Intl.DisplayNames(['ru'], { type: 'language' });
      } catch {
        display = null;
      }
    }
    try {
      const name = display?.of(clean);
      if (name && name.toLowerCase() !== clean.toLowerCase())
        return name.charAt(0).toUpperCase() + name.slice(1);
    } catch {
      /* Непонятный код — значит, подпись площадки. */
    }
  }
  return fallback || clean;
}

/** Дорожка озвучки в виде строки меню. */
export function audioChoices(tracks: MediaTrack[]): AudioChoice[] {
  return tracks.map((track, index) => ({
    index,
    original: ORIGINAL.test(track.name ?? ''),
    label: languageName(track.lang, (track.name ?? '').replace(ORIGINAL, '').replace(DUBBED, '')),
  }));
}

/**
 * Какую дорожку включить: выбранную человеком, иначе оригинальную.
 *
 * `wanted` — язык, который человек выбрал руками в прошлый раз; у ролика без такой озвучки
 * он молча уступает оригиналу, а не оставляет первую попавшуюся.
 */
export function pickAudio(tracks: MediaTrack[], wanted: string, original: string): number {
  if (!tracks.length) return -1;
  const chosen = wanted ? tracks.findIndex((track) => sameLanguage(track.lang, wanted)) : -1;
  if (chosen >= 0) return chosen;
  const marked = tracks.findIndex((track) => ORIGINAL.test(track.name ?? ''));
  if (marked >= 0) return marked;
  const spoken = original ? tracks.findIndex((track) => sameLanguage(track.lang, original)) : -1;
  return spoken >= 0 ? spoken : 0;
}

/**
 * Все субтитры одним списком.
 *
 * Их два источника, и человеку об этом знать незачем: написанные руками лежат в самом
 * плейлисте (их достаёт плеер), распознанные речью приносит наш сервер отдельными файлами —
 * в плейлисте YouTube их нет вовсе, а у большинства роликов других и не бывает.
 */
export function captionChoices(tracks: MediaTrack[], extra: CinemaCaption[]): CaptionChoice[] {
  const written = tracks.map((track, index) => ({
    id: `${track.lang || track.name || index}`,
    label: languageName(track.lang, track.name ?? ''),
    auto: false,
    track: index,
  }));
  const recognised = extra.map((caption) => ({
    id: `${caption.lang}${caption.auto ? '~auto' : ''}`,
    label: languageName(caption.lang, caption.label),
    auto: caption.auto,
    track: -1,
    url: caption.url,
  }));
  return [...written, ...recognised];
}

/**
 * Какие субтитры включить у следующего ролика.
 *
 * Помнится язык, а не строка меню: у одного ролика русские субтитры написаны автором, у
 * другого распознаны речью, и человек, включивший русские, хочет русские и там, и там.
 * Ничего похожего нет — субтитры остаются выключенными; предлагать вместо русских чужой
 * язык было бы хуже, чем не предлагать ничего.
 */
export function pickCaption(choices: CaptionChoice[], wanted: string): string {
  if (!wanted) return '';
  const exact = choices.find((choice) => choice.id === wanted);
  if (exact) return exact.id;
  const language = wanted.replace('~auto', '');
  const near = choices.find((choice) => sameLanguage(choice.id.replace('~auto', ''), language));
  return near ? near.id : '';
}
