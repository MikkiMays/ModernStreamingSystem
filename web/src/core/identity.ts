/**
 * Профиль устройства — единственная «личность» Cord без учётных записей.
 *
 * Это случайный секрет (32 байта, 43 знака base64url) в `cord:profile:v1`. Раньше его знало только
 * избранное — как `Authorization` своих запросов. Теперь тот же секрет уходит заголовком
 * `X-Cord-Profile` во все входы во встречу: по нему ядро держит одну активную встречу на профиль
 * (T52), а дальше — пределы на профиль (E11) и уникальные устройства в статистике (E10). Ядро
 * хранит не секрет, а его хэш, и наружу его не отдаёт (`contracts/headers.md`).
 *
 * Модуль без зависимостей: его читают и `api/client.ts`, и избранное.
 */
export const PROFILE_KEY = 'cord:profile:v1';
const SECRET = /^[A-Za-z0-9_-]{43}$/;
let volatileProfile: string | undefined;

/** Секрет профиля этого браузера; создаётся при первом вызове и дальше не меняется. */
export function profileSecret(): string {
  try {
    const saved = localStorage.getItem(PROFILE_KEY);
    if (saved && SECRET.test(saved)) return saved;
  } catch {
    /* Private browsing can disable storage. */
  }
  volatileProfile ??= btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
  try {
    localStorage.setItem(PROFILE_KEY, volatileProfile);
  } catch {
    /* Session-only identity. */
  }
  return volatileProfile;
}

/**
 * Заголовки входа во встречу: профиль, а после «Выйти оттуда и войти сюда» — ещё и встреча, из
 * которой ядро выведет в том же шаге (`X-Cord-Leave`).
 */
export function entryHeaders(leave?: string): Record<string, string> {
  return { 'X-Cord-Profile': profileSecret(), ...(leave ? { 'X-Cord-Leave': leave } : {}) };
}

/** Встреча, в которой этот профиль уже есть, — из отказа ядра `409 ALREADY_IN_MEETING`. */
export interface ElsewhereMeeting {
  roomId: string;
  title: string;
}

/** Отказ «вы уже во встрече» — с её адресом и названием; любой другой отказ — `null`. */
export function alreadyInMeeting(error: unknown): ElsewhereMeeting | null {
  const refusal = error as { code?: unknown; problem?: { roomId?: unknown; title?: unknown } } | null;
  if (!refusal || typeof refusal !== 'object' || refusal.code !== 'ALREADY_IN_MEETING') return null;
  const { roomId, title } = refusal.problem ?? {};
  return typeof roomId === 'string' && typeof title === 'string' ? { roomId, title } : null;
}
