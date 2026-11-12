import { clientKind } from './client-kind';
import { isDesktop } from './desktop';
import { profileSecret } from './identity';
import { collectFingerprint, type Fingerprint } from './insight-fingerprint';
import { solveProof } from './proof';
import type { Challenge } from './proof-solve';
import { appVersion } from './version';
import { currentPlatform } from '../media/platform';

/**
 * События аналитики продукта (R239): клиентская половина службы `insight`.
 * Проект — `docs/architecture/analytics-v2.md`, контракт — `contracts/insight.md` §1.
 *
 * ЧТО ШЛЁТ. Пачки событий на `POST /api/v1/t`: начало сессии (откуда пришёл, признаки устройства),
 * «человек действовал», экраны, разрешения камеры и микрофона, время входа, возможности, просмотр
 * интеграций, ошибки, приглашения, уход. Факты встречи (вошёл, был на связи, вышел) пишет ядро —
 * клиент добавляет только то, чего сервер не видит.
 *
 * ЧЕЛОВЕК, А НЕ ЗАГРУЗКА СТРАНИЦЫ. Прежняя аналитика считала посетителем любую загрузку — и считала
 * роботов. Теперь «человеком» сессию делает событие `engaged`: настоящее действие (нажатие, касание,
 * клавиша), страница видна не меньше трёх секунд и решена лёгкая задача «не робот». До него сессия
 * для сервера — «неясно».
 *
 * НЕ МЕШАЕТ. Ничего не ждёт и ничего не бросает: отправка — `keepalive`, при уходе со страницы —
 * `sendBeacon`; отказ сети — одна повторная попытка, дальше события выбрасываются. Очередь ограничена.
 *
 * ЧЕГО НЕТ. Адреса страницы, названия и номера встречи в открытом виде у событий экранов, имени, текста
 * чата. Номер встречи есть только у `integration_view` — служба заменяет его псевдонимом.
 */
export type InsightEvent =
  | 'session_start'
  | 'engaged'
  | 'screen'
  | 'prejoin'
  | 'permission'
  | 'join_timing'
  | 'feature'
  | 'integration_view'
  | 'error'
  | 'invite'
  | 'leave';

export type Landing = 'home' | 'invite' | 'room' | 'app' | 'tg' | 'download' | 'support' | 'other';
export type ScreenName = 'home' | 'prejoin' | 'meeting' | 'settings' | 'download' | 'support' | 'activity' | 'other';
type Props = Record<string, unknown>;
interface Queued {
  n: InsightEvent;
  at: number;
  p: Props;
}

const ENDPOINT = '/api/v1/t';
const SESSION_KEY = 'cord:insight:session:v1';
const SESSION_IDLE = 30 * 60_000;
const FLUSH_AFTER = 5_000;
const BATCH = 50;
const QUEUE_LIMIT = 200;
const ENGAGE_VISIBLE = 3_000;

interface Session {
  id: string;
  /** Когда сессия началась и когда последний раз была жива — мс эпохи. */
  since: number;
  seen: number;
  /** Событие `engaged` уже ушло. */
  engaged?: boolean;
}

/** Настоящее ли действие: скрипт страницы подделать `isTrusted` не может. Вынесено ради тестов. */
export const insightHooks = { trusted: (event: Event) => event.isTrusted };

let memorySession: Session | undefined;
let queue: Queued[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let sending = false;
let started = false;
let lastScreen: string | undefined;
let stopEngagement: (() => void) | undefined;

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

function readSession(): Session | undefined {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return memorySession;
    const saved = JSON.parse(raw) as Partial<Session>;
    if (typeof saved.id === 'string' && typeof saved.seen === 'number' && typeof saved.since === 'number')
      return saved as Session;
  } catch {
    /* Хранилище недоступно или испорчено — сессия живёт в памяти страницы. */
  }
  return memorySession;
}

function writeSession(session: Session): void {
  memorySession = session;
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    /* Только память. */
  }
}

/** Текущая сессия; `fresh` — она только что началась (первая загрузка вкладки или 30 минут тишины). */
function session(now = Date.now()): { session: Session; fresh: boolean } {
  const saved = readSession();
  if (saved && now - saved.seen < SESSION_IDLE) {
    saved.seen = now;
    writeSession(saved);
    return { session: saved, fresh: false };
  }
  const created: Session = { id: randomId(), since: now, seen: now };
  writeSession(created);
  return { session: created, fresh: true };
}

/** Положить событие в очередь. Пустые и `undefined` поля не уходят. */
export function track(name: InsightEvent, props: Props = {}): void {
  if (typeof window === 'undefined') return;
  const clean: Props = {};
  for (const [key, value] of Object.entries(props)) if (value !== undefined && value !== null && value !== '') clean[key] = value;
  queue.push({ n: name, at: Date.now(), p: clean });
  if (queue.length > QUEUE_LIMIT) queue = queue.slice(-QUEUE_LIMIT);
  if (queue.length >= BATCH) void flush();
  else timer ??= setTimeout(() => void flush(), FLUSH_AFTER);
}

function body(events: Queued[]): string {
  return JSON.stringify({
    v: 1,
    sid: session().session.id,
    profile: profileSecret(),
    client: { kind: clientKind(), version: appVersion },
    events,
  });
}

/** Отправить очередь. `leaving` — страница уходит: один `sendBeacon` без ответа. */
export async function flush(leaving = false): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = undefined;
  if (!queue.length || (sending && !leaving)) return;
  const events = queue.slice(0, BATCH);
  queue = queue.slice(events.length);
  const payload = body(events);
  if (leaving) {
    try {
      if (navigator.sendBeacon?.(ENDPOINT, new Blob([payload], { type: 'application/json' }))) return;
    } catch {
      /* Нет sendBeacon — обычный запрос с keepalive ниже. */
    }
  }
  sending = true;
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      keepalive: true,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Cord-Profile': profileSecret(), 'X-Cord-Client': clientKind() },
      body: payload,
    });
    // Сервер занят — вернуть события в начало очереди; отказ по существу (4xx) повторять незачем.
    if (response.status >= 500 || response.status === 429) requeue(events);
  } catch {
    requeue(events);
  } finally {
    sending = false;
    if (queue.length && !timer) timer = setTimeout(() => void flush(), FLUSH_AFTER);
  }
}

const retried = new WeakSet<Queued>();
function requeue(events: Queued[]): void {
  const again = events.filter((event) => !retried.has(event));
  for (const event of again) retried.add(event);
  queue = [...again, ...queue].slice(0, QUEUE_LIMIT);
}

/** Откуда человек вошёл в продукт — по адресу первой страницы сессии. */
export function landingOf(pathname: string, desktop: boolean, app: boolean, telegram: boolean): Landing {
  if (telegram || pathname === '/tg' || pathname.startsWith('/tg/')) return 'tg';
  if (pathname.startsWith('/join/')) return 'invite';
  if (pathname.startsWith('/room/')) return 'room';
  if (pathname === '/download') return 'download';
  if (pathname === '/support') return 'support';
  if (desktop || app) return 'app';
  return pathname === '/' ? 'home' : 'other';
}

/** Домен источника перехода; свой домен и пустой источник — не источник. */
export function referrerHost(referrer: string, own: string): string | undefined {
  if (!referrer) return undefined;
  try {
    const host = new URL(referrer).hostname.toLowerCase();
    return host && host !== own.toLowerCase() ? host.slice(0, 64) : undefined;
  } catch {
    return undefined;
  }
}

function utm(search: string): Props | undefined {
  const params = new URLSearchParams(search);
  const out: Props = {};
  for (const key of ['source', 'medium', 'campaign'] as const) {
    const value = params.get(`utm_${key}`);
    if (value) out[key] = value.slice(0, 64);
  }
  return Object.keys(out).length ? out : undefined;
}

function sessionStart(print: Fingerprint): Props {
  const platform = currentPlatform();
  let zone: string | undefined;
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    /* Без пояса. */
  }
  return {
    landing: landingOf(location.pathname, isDesktop(), platform.app, platform.telegram),
    ref: referrerHost(document.referrer, location.hostname),
    utm: utm(location.search),
    lang: navigator.language?.slice(0, 16),
    tz: zone,
    screen: { w: screen.width, h: screen.height, dpr: window.devicePixelRatio, depth: screen.colorDepth },
    standalone: platform.standalone || undefined,
    wd: navigator.webdriver === true || undefined,
    fp: Object.keys(print).length ? print : undefined,
  };
}

/**
 * «Человек действовал»: первое настоящее действие и три секунды видимой страницы — затем лёгкая задача
 * «не робот» и событие `engaged`. Один раз на сессию.
 */
function watchEngagement(): void {
  let acted = false;
  let visibleFor = 0;
  let visibleSince = document.visibilityState === 'visible' ? performance.now() : null;
  let done = false;
  const visible = () => visibleFor + (visibleSince === null ? 0 : performance.now() - visibleSince);
  const tryEngage = () => {
    if (done || !acted) return;
    const left = ENGAGE_VISIBLE - visible();
    if (left > 0) {
      setTimeout(tryEngage, left + 20);
      return;
    }
    done = true;
    cleanup();
    void engage();
  };
  const onAction = (event: Event) => {
    if (!insightHooks.trusted(event)) return;
    acted = true;
    tryEngage();
  };
  const onVisibility = () => {
    if (document.visibilityState === 'visible') visibleSince ??= performance.now();
    else if (visibleSince !== null) {
      visibleFor += performance.now() - visibleSince;
      visibleSince = null;
    }
  };
  const actions = ['pointerdown', 'keydown', 'touchstart'] as const;
  const cleanup = () => {
    for (const type of actions) removeEventListener(type, onAction, true);
    document.removeEventListener('visibilitychange', onVisibility);
  };
  for (const type of actions) addEventListener(type, onAction, { capture: true, passive: true });
  document.addEventListener('visibilitychange', onVisibility);
  stopEngagement = () => {
    done = true;
    cleanup();
  };
}

async function engage(): Promise<void> {
  const current = session().session;
  if (current.engaged) return;
  let proof: string | null = null;
  try {
    const response = await fetch(`${ENDPOINT}/proof`, { credentials: 'same-origin' });
    if (response.ok && response.status !== 204) proof = await solveProof((await response.json()) as Challenge);
  } catch {
    /* Без задачи событие всё равно уходит: решит сервер, считать ли его. */
  }
  current.engaged = true;
  writeSession(current);
  track('engaged', { proof: proof ?? undefined, ms: Date.now() - current.since });
  void flush();
}

/**
 * Запустить аналитику страницы: начало сессии (если она новая), слежение за «человек действовал» и
 * отправка остатка при уходе. Зовётся один раз из входа приложения.
 */
export function startInsight(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  const { session: current, fresh } = session();
  if (fresh)
    void collectFingerprint()
      .catch((): Fingerprint => ({}))
      .then((print) => {
        track('session_start', sessionStart(print));
        void flush();
      });
  if (!current.engaged) watchEngagement();
  addEventListener('pagehide', () => void flush(true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flush(true);
  });
}

/** Экран, который видит человек; повтор того же экрана подряд не шлётся. */
export function noteScreen(name: ScreenName, tab?: string): void {
  const key = `${name}:${tab ?? ''}`;
  if (key === lastScreen) return;
  lastScreen = key;
  track('screen', { name, tab });
}

export function notePrejoin(from?: 'create' | 'invite' | 'code' | 'recent' | 'favorite'): void {
  track('prejoin', { from });
}

export function notePermission(
  device: 'mic' | 'cam' | 'screen',
  result: 'granted' | 'denied' | 'dismissed' | 'error',
  error?: string,
): void {
  track('permission', { device, result, error: error?.slice(0, 64) });
}

export function noteJoinTiming(timing: { ms: number; signalMs?: number; mediaMs?: number; node?: string }): void {
  track('join_timing', {
    ms: Math.round(timing.ms),
    signal_ms: timing.signalMs === undefined ? undefined : Math.round(timing.signalMs),
    media_ms: timing.mediaMs === undefined ? undefined : Math.round(timing.mediaMs),
    node: timing.node,
  });
}

let joinStarted: number | undefined;
let joinAdmitted: number | undefined;
/** Нажато «Войти»: отсюда считается время входа. */
export function markJoinStart(): void {
  joinStarted = performance.now();
  joinAdmitted = undefined;
}
/** Дверь ядра ответила — кончилась «сигнальная» часть входа. */
export function markJoinAdmitted(): void {
  if (joinStarted !== undefined) joinAdmitted = performance.now() - joinStarted;
}
/** Медиа соединилось с узлом — вход закончен; событие уходит один раз на вход. */
export function markJoinConnected(node?: string): void {
  if (joinStarted === undefined) return;
  const ms = performance.now() - joinStarted;
  noteJoinTiming({ ms, signalMs: joinAdmitted, mediaMs: joinAdmitted === undefined ? undefined : ms - joinAdmitted, node });
  joinStarted = joinAdmitted = undefined;
}

const featureCounts = new Map<string, number>();
let featureTimer: ReturnType<typeof setTimeout> | undefined;
/** Возможность использована. Частые (реакции, горячие клавиши) копятся и уходят счётчиком раз в 10 с. */
export function noteFeature(name: string): void {
  featureCounts.set(name, (featureCounts.get(name) ?? 0) + 1);
  featureTimer ??= setTimeout(() => {
    featureTimer = undefined;
    for (const [feature, count] of featureCounts) track('feature', { name: feature, count });
    featureCounts.clear();
  }, 10_000);
}

export function noteIntegrationView(view: {
  room: string;
  kind: 'cinema' | 'music' | 'game' | 'board';
  variant?: string;
  seconds: number;
  stalls?: number;
  stallMs?: number;
}): void {
  if (view.seconds <= 0) return;
  track('integration_view', {
    room: view.room,
    kind: view.kind,
    variant: view.variant,
    seconds: Math.round(view.seconds),
    stalls: view.stalls || undefined,
    stall_ms: view.stallMs ? Math.round(view.stallMs) : undefined,
  });
}

export function noteError(error: {
  code: string;
  scope: 'join' | 'media' | 'device' | 'cinema' | 'music' | 'game' | 'board' | 'chat' | 'update' | 'app';
  fatal?: boolean;
  detail?: string;
}): void {
  track('error', {
    code: error.code.slice(0, 64),
    scope: error.scope,
    screen: lastScreen?.split(':')[0],
    fatal: error.fatal || undefined,
    detail: error.detail?.slice(0, 200),
  });
}

export function noteInvite(how: 'copy' | 'share' | 'qr'): void {
  track('invite', { how });
}

export function noteLeave(reason: 'user' | 'closed' | 'network' | 'removed' | 'ended', seconds: number): void {
  track('leave', { reason, seconds: Math.round(seconds) });
  void flush();
}

/** Только для тестов: забыть очередь, сессию страницы и то, что аналитика уже запущена. */
export function resetInsightForTest(): void {
  if (timer) clearTimeout(timer);
  if (featureTimer) clearTimeout(featureTimer);
  timer = featureTimer = undefined;
  stopEngagement?.();
  stopEngagement = undefined;
  queue = [];
  sending = false;
  started = false;
  joinStarted = joinAdmitted = undefined;
  lastScreen = undefined;
  memorySession = undefined;
  featureCounts.clear();
}
