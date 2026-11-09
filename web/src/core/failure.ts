import { i18next, SOURCE_LANGUAGE, t } from '../i18n';
import { noteError } from './support';

/*
  Ошибки для человека (R180, Р-80).

  ПРАВИЛО. Человек видит короткую фразу на своём языке: что случилось и что ему сделать (или что мы
  сделаем сами). Без портов, протоколов, кодов, имён исключений, адресов и английских текстов
  браузера и библиотек («Failed to fetch», «NotAllowedError», «could not establish pc connection»).
  Подробности — в журнал браузера (`console.warn` с местом и кодом), в «Недавние ошибки» обращения в
  поддержку (`noteError`) и в счётчик ядра `cord_client_errors_total{place,code}`. Технику показывает
  только «Диагностика» — это её назначение.

  ОДНА ТОЧКА ПЕРЕВОДА — `failureText(error, place)`: по коду ядра или службы — текст отказа (реестр
  `contracts/errors.json` и его переводы), по виду ошибки браузера, сети или медиа — свои фразы, всё
  неизвестное — общая фраза места («Не удалось включить камеру. Попробуйте ещё раз»).
  ОДНА ТОЧКА УЧЁТА — `noteFailure(place, code, error)`: журнал, недавние ошибки и счётчик. Текст,
  адреса и имена в счётчик не идут — только место и код из известного списка.
*/

/**
 * Где человек увидел ошибку: метка счётчика и общая фраза места (`failure.places.<место>`). Ядро
 * знает тот же список (`ClientErrors.PLACES`); чужое слово оно считает как `other`.
 */
export const PLACES = [
  'app',
  'connect',
  'join',
  'meeting',
  'call',
  'camera',
  'microphone',
  'screen',
  'speaker',
  'chat',
  'files',
  'board',
  'cinema',
  'music',
  'games',
  'favorites',
  'recent',
  'invite',
  'profile',
  'settings',
  'support',
  'telegram',
  'activity',
] as const;
export type Place = (typeof PLACES)[number];

/**
 * Вид ошибки без кода ядра или службы — второе слово счётчика рядом с кодами реестра (те пишутся
 * заглавными, виды — строчными). Ядро знает тот же список (`ClientErrors.KINDS`).
 */
export const KINDS = [
  'offline',
  'timeout',
  'server',
  'refused',
  'denied',
  'no-device',
  'device-busy',
  'unsupported',
  'call',
  'aborted',
  'bug',
  'other',
  // Камера и фон (R189, И7): что сторож заметил и чем кончилось — без текста, только вид.
  'camera-ended',
  'camera-muted',
  'camera-silenced',
  'camera-missing',
  'camera-stalled',
  'camera-healed',
  'camera-heal-failed',
  'camera-denied',
  'background-stalled',
  'background-dropped',
  // Микрофон включился медленно (R191): что задержало — в журнале микрофона, человеку ничего.
  'mic-slow',
  // Кинозал (R216): картинка встала и её лечили, вылечили, не вылечили; звук отстал от картинки;
  // устройство не тянуло картинку — кодек легче или ступень ниже (`theater/decode.ts`).
  'cinema-stalled',
  'cinema-healed',
  'cinema-heal-failed',
  'cinema-audio',
  'cinema-decode',
] as const;
export type Kind = (typeof KINDS)[number];

/**
 * Ошибка, текст которой уже сказан для человека и на его языке (`t(…)` в момент события). Всё, что
 * Cord бросает сам ради того, чтобы человек это прочёл, — такая ошибка; обычный `Error` с тем же
 * текстом точка перевода сочла бы чужим и заменила общей фразой места.
 */
export class FriendlyError extends Error {
  constructor(
    message: string,
    readonly kind: Kind = 'other',
  ) {
    super(message);
    this.name = 'FriendlyError';
  }
}

/**
 * Обрыв сети у `fetch` — по-прежнему `TypeError` (его так и узнают), но уже со словами для человека
 * и отличимый от ошибки в коде, которая тоже `TypeError`.
 */
export class OfflineError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'OfflineError';
  }
}

/** Места, где ошибка браузера про устройство говорит о самом устройстве. */
const DEVICES = ['camera', 'microphone', 'screen', 'speaker'] as const;
type Device = (typeof DEVICES)[number];
const isDevice = (place: Place): place is Device => (DEVICES as readonly string[]).includes(place);

/** Слова `getUserMedia`, `getDisplayMedia` и `setSinkId` — по имени ошибки, во всех браузерах. */
const DEVICE_ERRORS: Record<string, 'denied' | 'no-device' | 'device-busy' | 'unsupported'> = {
  NotAllowedError: 'denied',
  PermissionDeniedError: 'denied',
  SecurityError: 'denied',
  NotFoundError: 'no-device',
  DevicesNotFoundError: 'no-device',
  OverconstrainedError: 'no-device',
  ConstraintNotSatisfiedError: 'no-device',
  NotReadableError: 'device-busy',
  TrackStartError: 'device-busy',
  NotSupportedError: 'unsupported',
  DeviceUnsupportedError: 'unsupported',
};

/** Ошибки LiveKit — по имени класса (`livekit-client` 2.22, `room/errors`): связь со звонком. */
const CALL_ERRORS = new Set([
  'ConnectionError',
  'NegotiationError',
  'PublishTrackError',
  'PublishDataError',
  'SignalRequestError',
  'SignalReconnectError',
  'UnexpectedConnectionState',
  'UnsupportedServer',
  'TrackInvalidError',
  'DataStreamError',
]);

/** Так `fetch` говорит об обрыве сети: Chrome, Firefox и Safari — каждый своими словами. */
const OFFLINE =
  /failed to fetch|networkerror|load failed|network request failed|network connection was lost/i;
/** Ошибки самого кода — не человека и не сети. */
const BUGS = new Set(['TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'URIError', 'EvalError']);
/** Буква кириллицы: исходный язык отказов служб без кода — русский. */
const CYRILLIC = /[\u0430-\u044f\u0451]/i;

/** Отказ сервера (`ApiError` из `api/client`), узнанный по форме — без цикла импортов. */
interface Refusal {
  status: number;
  code: string;
  message: string;
  problem?: Record<string, unknown>;
}
function refusal(error: unknown): Refusal | null {
  if (!(error instanceof Error)) return null;
  const candidate = error as Error & Partial<Refusal>;
  return typeof candidate.status === 'number' && typeof candidate.code === 'string'
    ? (candidate as Refusal)
    : null;
}

/** Код из реестра ошибок ядра и служб (`contracts/errors.json` → каталог `errors`, всегда по-русски). */
export function knownCode(code: string): boolean {
  return (
    /^[A-Z][A-Z0-9_]*$/.test(code) && !!i18next.getResource(SOURCE_LANGUAGE, 'translation', `errors.${code}`)
  );
}

export interface Classified {
  /** Метка счётчика: код реестра или вид ошибки. */
  code: string;
  /** Фраза для человека; `null` — сказать нечего, кроме общей фразы места. */
  text: string | null;
}

/**
 * Что это за ошибка и есть ли у неё своя фраза для человека. Сама ничего не пишет и не считает.
 */
export function classify(error: unknown, place: Place): Classified {
  if (error instanceof FriendlyError) return { code: error.kind, text: error.message || null };
  const refused = refusal(error);
  if (refused) {
    // Код из реестра: текст отказа уже на языке человека (`errorText` в `api/client`).
    if (knownCode(refused.code)) return { code: refused.code, text: refused.message || null };
    // Отказ службы без кода: по-русски она говорит человеку сама (`HTTPException` с русским
    // `detail`). Английское слово FastAPI («Not Found»), список ошибок проверки, страница прокси
    // вместо JSON — не текст для человека; на другом языке русскую фразу тоже не показываем.
    const detail = refused.problem?.detail;
    const said =
      i18next.language === SOURCE_LANGUAGE && typeof detail === 'string' && CYRILLIC.test(detail)
        ? detail
        : null;
    if (refused.status >= 500)
      return { code: 'server', text: said ?? (refused.status === 500 ? null : t(($) => $.failure.server)) };
    return { code: 'refused', text: said };
  }
  if (!(error instanceof Error) && !(error instanceof DOMException)) return { code: 'other', text: null };
  const name = error.name;
  if (name === 'TimeoutError') return { code: 'timeout', text: t(($) => $.failure.timeout) };
  if (error instanceof OfflineError || (error instanceof TypeError && OFFLINE.test(error.message)))
    return { code: 'offline', text: t(($) => $.failure.offline) };
  const device =
    DEVICE_ERRORS[name] ?? (name === 'AbortError' && isDevice(place) ? 'device-busy' : undefined);
  if (device) return { code: device, text: isDevice(place) ? deviceText(place, device) : null };
  if (name === 'AbortError') return { code: 'aborted', text: null };
  if (CALL_ERRORS.has(name)) return { code: 'call', text: null };
  if (BUGS.has(name)) return { code: 'bug', text: null };
  return { code: 'other', text: null };
}

function deviceText(place: Device, kind: 'denied' | 'no-device' | 'device-busy' | 'unsupported'): string {
  const key = kind === 'no-device' ? 'missing' : kind === 'device-busy' ? 'busy' : kind;
  return t(($) => $.failure.devices[place][key]);
}

/**
 * Ошибка — фразой для человека, и она же — в журнал, недавние ошибки и счётчик. `fallback` — своя
 * фраза места точнее общей («Не удалось сохранить доску в чат»); ею говорится всё, у чего своей
 * фразы нет.
 */
export function failureText(error: unknown, place: Place, fallback?: string): string {
  const { code, text } = classify(error, place);
  noteFailure(place, code, error);
  return text || fallback || t(($) => $.failure.places[place]);
}

/**
 * Та же фраза без учёта — для отрисовки: компонент рисует ошибку запроса на каждом рендере, а
 * считать её нужно один раз (это делает место, где её поймали).
 */
export function failureMessage(error: unknown, place: Place, fallback?: string): string {
  return classify(error, place).text || fallback || t(($) => $.failure.places[place]);
}

/**
 * Своя фраза ошибки, если она есть, — для окна или тоста со своим заголовком («Не удалось сохранить
 * доску в чат» + почему). `undefined` — сказать нечего, кроме заголовка. Учёт — как у `failureText`.
 */
export function failureDetail(error: unknown, place: Place): string | undefined {
  const { code, text } = classify(error, place);
  noteFailure(place, code, error);
  return text ?? undefined;
}

/* ---------- учёт ---------- */

export interface FailureCount {
  place: Place;
  code: string;
  count: number;
}

/** Не больше стольких разных пар «место — код» ждут отправки: остальное — в журнал, не в счёт. */
const MAX_PENDING = 60;
/** Не чаще раза в столько: счётчик — не поток, а сводка. */
export const FLUSH_MS = 30_000;
const pending = new Map<string, FailureCount>();
let sink: ((batch: FailureCount[], keepalive: boolean) => Promise<boolean>) | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

/**
 * Учесть ошибку, которую человек увидел (или которая сломала что-то молча): журнал браузера с
 * местом, кодом и самой ошибкой; строка в недавних ошибках (отказ сервера там уже есть со своим
 * адресом — `api/client`); шаг счётчика ядра.
 */
export function noteFailure(place: Place, code: string, error?: unknown): void {
  console.warn(`[cord] ${place} failed: ${code}`, error ?? '');
  // Отказ сервера, обрыв и срок `request` уже записал в кольцо сам — с методом и адресом ручки.
  const noted =
    refusal(error) ||
    error instanceof OfflineError ||
    (error instanceof DOMException && error.name === 'TimeoutError');
  if (!noted) {
    const detail =
      (error instanceof Error || error instanceof DOMException) && error.name !== 'FriendlyError'
        ? ` ${error.name}: ${error.message}`
        : '';
    noteError(`${place} ${code}${detail}`);
  }
  count(place, code);
}

function count(place: Place, code: string) {
  const label = (KINDS as readonly string[]).includes(code) || knownCode(code) ? code : 'other';
  const key = `${place} ${label}`;
  const entry = pending.get(key);
  if (entry) entry.count += 1;
  else if (pending.size < MAX_PENDING) pending.set(key, { place, code: label, count: 1 });
  schedule();
}

function schedule() {
  if (!sink || timer !== undefined || !pending.size) return;
  timer = setTimeout(() => {
    timer = undefined;
    void flush(false);
  }, FLUSH_MS);
}

/** Отправить накопленное. Не дошло по сети — счёт вернётся и уйдёт со следующей сводкой. */
export async function flush(keepalive: boolean): Promise<void> {
  if (!sink || !pending.size) return;
  const batch = [...pending.values()];
  pending.clear();
  clearTimeout(timer);
  timer = undefined;
  const delivered = await sink(batch, keepalive).catch(() => false);
  if (delivered) return;
  for (const entry of batch) {
    const key = `${entry.place} ${entry.code}`;
    const kept = pending.get(key);
    if (kept) kept.count += entry.count;
    else if (pending.size < MAX_PENDING) pending.set(key, { ...entry });
  }
  schedule();
}

/** Что ждёт отправки — для тестов и «Диагностики». */
export function pendingFailures(): readonly FailureCount[] {
  return [...pending.values()].map((entry) => ({ ...entry }));
}

/**
 * Начать отправлять счёт ядру: раз в {@link FLUSH_MS}, пока есть что, и сразу, когда страницу
 * прячут или закрывают (`keepalive` — запрос переживёт закрытие). Один раз, из входа приложения.
 */
export function startFailureReports(
  send: (batch: FailureCount[], keepalive: boolean) => Promise<boolean>,
  target: Window = window,
): void {
  sink = send;
  const leave = () => void flush(true);
  target.addEventListener('pagehide', leave);
  target.document.addEventListener('visibilitychange', () => {
    if (target.document.visibilityState === 'hidden') leave();
  });
  schedule();
}

/** Для тестов: забыть накопленное и отправителя. */
export function resetFailures(): void {
  pending.clear();
  clearTimeout(timer);
  timer = undefined;
  sink = null;
}

/** Шум, а не ошибка Cord: браузер сообщает о нём как об ошибке страницы. */
const NOISE = /ResizeObserver loop|^Script error\.?$/;

/**
 * Необработанные ошибки страницы: в журнал, недавние ошибки и счётчик как `app bug`. Отмена
 * (`AbortError`) — не ошибка. Один раз, из входа приложения.
 */
export function watchFailures(target: Window = window): void {
  target.addEventListener('error', (event) => {
    if (NOISE.test(event.message || '')) return;
    noteFailure(
      'app',
      'bug',
      event.error instanceof Error ? event.error : new Error(event.message || 'error'),
    );
  });
  target.addEventListener('unhandledrejection', (event) => {
    const reason: unknown = event.reason;
    if (reason instanceof DOMException && reason.name === 'AbortError') return;
    noteFailure('app', classify(reason, 'app').code, reason);
  });
}
