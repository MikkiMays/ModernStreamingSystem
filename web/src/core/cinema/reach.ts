import { ApiError } from '../../api/client';

/**
 * Площадка, до которой сервер не достаёт (R112).
 *
 * Служба сама знает, что этот сервер не достаёт до площадки (автомат `services/…/cinema/reach.py`):
 * такой вопрос она отказывает сразу — `503 CINEMA_UNREACHABLE`, — а вопрос, на который площадка не
 * ответила за срок службы, — `504 CINEMA_TIMEOUT`. В обоих отказах есть `provider`: по нему каталог
 * называет площадку на языке человека, а не русскими словами службы.
 *
 * Срок есть и у браузера: даже если служба замолчит совсем, «Спрашиваем площадку…» не висит дольше
 * её собственного срока — ответ приходит или словами службы, или своим «Сервер не ответил вовремя».
 */
export const UNREACHABLE = 'CINEMA_UNREACHABLE';
export const LATE = 'CINEMA_TIMEOUT';
/**
 * Те же два отказа у музыки (поиск и ссылки YouTube идут тем же yt-dlp и тем же автоматом площадки,
 * что и кинозал): `503 MUSIC_UNREACHABLE` и `504 MUSIC_TIMEOUT`, площадка — в поле `source`.
 */
export const MUSIC_UNREACHABLE = 'MUSIC_UNREACHABLE';
export const MUSIC_LATE = 'MUSIC_TIMEOUT';

/** Чьи отказы: коды и поле, где служба называет площадку. */
const AREAS = {
  cinema: { down: UNREACHABLE, late: LATE, field: 'provider' },
  music: { down: MUSIC_UNREACHABLE, late: MUSIC_LATE, field: 'source' },
} as const;
export type ReachArea = keyof typeof AREAS;

/**
 * Сколько браузер ждёт ответ каталога: срок службы на вопрос к площадке (`CATALOG_DEADLINE`, 25 с)
 * и ещё пять — на дорогу и проверку участника. Дольше этого ответа уже не будет.
 */
export const CATALOG_TIMEOUT = 30000;
/** Разбор ролика в поток: срок службы (`RESOLVE_DEADLINE`, 30 с) и те же пять секунд. */
export const RESOLVE_TIMEOUT = 35000;
/** Ссылка «По ссылке» — разбор чужой страницы: у службы на него до сорока секунд. */
export const LINK_TIMEOUT = 45000;

/** Сигнал отмены, который срабатывает и по своему сроку: отмена запроса и срок — что раньше. */
export function within(ms: number, signal?: AbortSignal): AbortSignal {
  const timer = AbortSignal.timeout(ms);
  if (!signal) return timer;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timer]);
  const both = new AbortController();
  const stop = (source: AbortSignal) => () => both.abort(source.reason);
  if (signal.aborted) both.abort(signal.reason);
  signal.addEventListener('abort', stop(signal), { once: true });
  timer.addEventListener('abort', stop(timer), { once: true });
  return both.signal;
}

/**
 * Отказ службы — про площадку (недоступна отсюда или не ответила вовремя)? Тогда — имя площадки из
 * отказа, как его назвала служба; своя ли это площадка, решает тот, кто её называет (`notes.tsx`).
 * Модуль нарочно без реестра площадок: его берёт и сборка приложения (`App.tsx`), а реестр — со значками.
 * `area` — чьи это отказы: кинозала (по умолчанию) или музыки.
 */
export function refusedBy(problem: unknown, area: ReachArea = 'cinema'): string | null {
  const { down, late, field } = AREAS[area];
  if (!(problem instanceof ApiError) || (problem.code !== down && problem.code !== late)) return null;
  const id = problem.problem[field];
  return typeof id === 'string' ? id : null;
}

/** Отказ — «площадка недоступна с этого сервера» (а не вышедший срок)? */
export function unreachableRefusal(problem: unknown): boolean {
  return problem instanceof ApiError && (problem.code === UNREACHABLE || problem.code === MUSIC_UNREACHABLE);
}

/** Вышел ли срок ожидания у самого браузера. */
export function timedOut(problem: unknown): boolean {
  return problem instanceof DOMException && problem.name === 'TimeoutError';
}

/**
 * Повторять ли вопрос каталога сам, без человека. Мигнувшую сеть и отказ площадки — один раз, как и
 * раньше. Площадку, недоступную отсюда, и вышедший срок — нет: служба ответит тем же, а второй срок
 * ожидания удвоил бы «Спрашиваем площадку…». Для них у отказа есть кнопка «Повторить».
 */
export function retryCatalog(failures: number, problem: unknown): boolean {
  if (timedOut(problem)) return false;
  if (problem instanceof ApiError && (problem.code === UNREACHABLE || problem.code === LATE)) return false;
  return failures < 1;
}
