import { desktopBootstrap, hasFeature, isDesktop, notifyDesktop, onDesktopEvent } from './desktop';
import {
  parsePreferences,
  readPreferences,
  savePreferences,
  setPreferencesSync,
  writeLocalPreferences,
  type Preferences,
} from './preferences';
import { loadServerCatalog, type CatalogServer } from './catalog';
import type { DeviceChoice } from '../media/session';
import { validHotkey } from './hotkeys';

/**
 * Общие настройки для всех серверов (R146, Р-39). Владелец: «при переключении серверов сохранять
 * текущие настройки десктопа или веба, а не на каждый свои, на каждый серв свои только комнаты,
 * настройки общие».
 *
 * Один список: что общее (устройство и человек), что секрет (токен Яндекс Музыки, R157), что своё
 * у сервера. Устройства — **по названию**: Chromium солит `deviceId` по origin, и id камеры одного
 * сервера на другом не совпадёт; чужой id точным ограничением не ставится никогда.
 *
 * **Клиент Windows** (флаг `prefs.shared`): общее хранит оболочка. Preload кладёт его в хранилище
 * страницы до первого скрипта; здесь — отправка правок (`preferences.changed {shared: {ключ: {value,
 * at}}}`, только изменившиеся общие ключи, пачкой через 150 мс — ползунок не будит оболочку на каждом
 * шаге), приём победившего от оболочки, сверка устройств по названию и перенос со старых версий:
 * общее у оболочки пусто — первая страница присылает всё своё с `seed: true`. Оболочка без флага —
 * всё как раньше: ей уходят только PING и сигналы (`preferences.ts`).
 *
 * **Браузер** (P2): соседний сервер — другой сайт, общего хранилища у них нет. «Сменить сервер» несёт
 * несекретные общие настройки во фрагменте адреса `#cord-prefs=<base64url json>`; страница сервера
 * сразу стирает фрагмент (`history.replaceState`) и принимает только ключи из белого списка — и
 * только если пришла с сервера каталога (адрес, с которого перешли, называет ссылка «Сменить сервер»
 * сама: у страниц Cord `Referrer-Policy: no-referrer`). Токен во фрагмент не кладётся никогда:
 * фрагмент оседает в истории браузера.
 */

/** Общие ключи `cord:preferences:v1` — у оболочки те же (`SHARED_PREFERENCES`, `desktop/src/shared/bridge.ts`). */
export const SHARED_KEYS = [
  'language',
  'name',
  'avatar',
  'audio',
  'outputVolume',
  'soundVolume',
  'notificationSounds',
  'gameSounds',
  'micHotkey',
  'micHotkeyMode',
  'overlayHotkey',
  'overlayLockHotkey',
  'deafened',
  'deafenHotkey',
  'layout',
  'watchVolume',
  'watchAudio',
  'watchSubtitles',
  // Качество — желаемое; при чтении его сводит к потолку этого сервера `nearestLevel` / `cameraLevel`.
  'screen',
  'camera',
  'pokerHints',
  'pokerFeed',
  'showPing',
  'cinemaLinks',
  'lastPlatform',
] as const satisfies readonly (keyof Preferences)[];
/**
 * Общие ключи из соседних веток, которых в `Preferences` этой сборки может ещё не быть: `background`
 * — фон в видео (R153, `media/background-effect.ts`: `{kind: 'none' | 'blur' | 'image', …}`; своё фото
 * лежит в IndexedDB своего origin, поэтому на другом сервере без него камера идёт без фона). Нет поля
 * в настройках — ключ просто не участвует.
 */
export const LATER_SHARED_KEYS = ['background'] as const;
/** Все общие ключи — и те, что придут с соседними ветками. */
const ALL_SHARED: readonly string[] = [...SHARED_KEYS, ...LATER_SHARED_KEYS];
export type SharedKey = (typeof SHARED_KEYS)[number];
/** Поле настроек по имени: общего ключа соседней ветки в этой сборке может не быть. */
function field(prefs: Preferences, key: string): unknown {
  return (prefs as unknown as Record<string, unknown>)[key];
}
/** Секрет: только оболочке клиента Windows, никогда — во фрагмент адреса. */
export const SECRET_KEYS = ['yandexMusicToken'] as const satisfies readonly (keyof Preferences)[];
/** Устройства: общие по названию, у сервера — свои `deviceId`. */
export const DEVICE_KEY = 'devices' as const satisfies keyof Preferences;
/** Поля настроек, которые остаются у сервера (или вовсе не настройки человека). */
export const LOCAL_KEYS = ['showIntegrationPanel'] as const satisfies readonly (keyof Preferences)[];
/**
 * Ключи хранилища, которые принадлежат серверу и не переезжают: избранное, автовход, недавние
 * встречи, сессия, пароль и адрес сервера, громкости участников, кеш возможностей, вход владельца,
 * идущая встреча.
 */
export const PER_SERVER_STORAGE = [
  'cord:favorites:v1',
  'cord:autojoin:v1',
  'cord:recent:v1',
  'cord:session:v1',
  'cord:servers:v1',
  'cord:volumes:v1',
  'cord:quality:v1',
  'cord:admin:v1',
  'cord:active-meeting',
  'cord:profile:v1',
] as const;
// Каждое поле настроек — в одном из списков: новое поле без решения «общее или своё» не соберётся.
type Classified =
  | SharedKey
  | (typeof LATER_SHARED_KEYS)[number]
  | (typeof SECRET_KEYS)[number]
  | typeof DEVICE_KEY
  | (typeof LOCAL_KEYS)[number];
const everyFieldClassified: Record<Exclude<keyof Preferences, Classified>, never> = {};
void everyFieldClassified;

export const SHARED_FEATURE = 'prefs.shared';
/** Выбранные устройства по названию (`MediaDeviceInfo.label`): нет вида — по умолчанию системы. */
export type DeviceLabels = Partial<Record<keyof DeviceChoice, string>>;
const KINDS: Record<keyof DeviceChoice, MediaDeviceKind> = {
  microphone: 'audioinput',
  camera: 'videoinput',
  speaker: 'audiooutput',
};

/** Пределы оболочки (`messages.ts`): сообщение ≤ 16 КиБ — пачка меньше, ссылки кинозала — урезаются. */
const MESSAGE_BUDGET = 12_000;
const LINKS_BUDGET = 6_000;
const TOKEN_LIMIT = 1000;
const LABEL_LIMIT = 200;
const FLUSH_MS = 150;

type Entry = { value: unknown; at: number };
type Values = Record<string, unknown>;

/** Сочетание — ровно пять полей модели (оболочка лишнего не принимает). */
function hotkey(value: unknown) {
  if (!validHotkey(value)) return null;
  const { code, ctrl, alt, shift, meta } = value;
  return { code, ctrl, alt, shift, meta };
}

/**
 * Значение общего ключа в том виде, в каком оно уходит с устройства; `undefined` — не делиться им
 * (токен не по пределу). Ссылки кинозала урезаются с конца, чтобы пачка влезла в сообщение.
 */
export function shareable(key: string, value: unknown): unknown {
  switch (key) {
    case 'micHotkey':
    case 'overlayHotkey':
    case 'overlayLockHotkey':
    case 'deafenHotkey':
      return value === null ? null : (hotkey(value) ?? undefined);
    case 'cinemaLinks': {
      const links = Array.isArray(value) ? value.filter((url): url is string => typeof url === 'string') : [];
      const kept: string[] = [];
      for (const url of links) {
        if (JSON.stringify([...kept, url]).length > LINKS_BUDGET) break;
        kept.push(url);
      }
      return kept;
    }
    case 'yandexMusicToken':
      return typeof value === 'string' && value.length <= TOKEN_LIMIT && /^[\x21-\x7e]*$/.test(value)
        ? value
        : undefined;
    default:
      return value;
  }
}

function same(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Общие значения этих настроек (без секрета и устройств) — как они уходят с устройства. */
export function sharedValues(prefs: Preferences): Values {
  const values: Values = {};
  for (const key of ALL_SHARED) {
    const value = shareable(key, field(prefs, key));
    if (value !== undefined) values[key] = value;
  }
  return values;
}

/**
 * Какие общие ключи изменило это сохранение (`before` → `after`) и чего оболочка ещё не знает
 * (`known`). Только правка этого сохранения: своё устаревшее (preload не смог записать, ключа у
 * оболочки ещё нет) не перебивает общее. То, что знает оболочка, сводится тем же разбором, что и своё
 * (`parsePreferences`): качество выше потолка этого сервера не считается изменением — иначе каждый
 * сервер «зажимал» бы желаемое другого.
 */
export function changedShared(before: Preferences, after: Preferences, known: Values): Values {
  const base = parsePreferences(known, typeof known.name === 'string' ? known.name : null);
  const changed: Values = {};
  for (const key of [...ALL_SHARED, ...SECRET_KEYS]) {
    const value = shareable(key, field(after, key));
    if (value === undefined || same(value, shareable(key, field(before, key)))) continue;
    if (key in known && same(value, shareable(key, field(base, key)))) continue;
    changed[key] = value;
  }
  return changed;
}

/** Пачки ≤ `MESSAGE_BUDGET` знаков JSON — оболочка отказывает сообщению больше 16 КиБ целиком. */
export function chunkEntries(entries: Record<string, Entry>): Record<string, Entry>[] {
  const chunks: Record<string, Entry>[] = [];
  let chunk: Record<string, Entry> = {};
  for (const [key, entry] of Object.entries(entries)) {
    const next = { ...chunk, [key]: entry };
    if (Object.keys(chunk).length && JSON.stringify({ shared: next }).length > MESSAGE_BUDGET) {
      chunks.push(chunk);
      chunk = { [key]: entry };
    } else chunk = next;
  }
  if (Object.keys(chunk).length) chunks.push(chunk);
  return chunks;
}

// ---------- устройства по названию ----------

function cleanLabel(label: string) {
  return label.trim().slice(0, LABEL_LIMIT);
}

/**
 * Названия выбранных устройств. Устройства нет в списке или у него нет названия (нет разрешения) —
 * прежнее название этого вида (`previous`): отключённая камера не стирает выбор.
 */
export function labelsOf(
  choice: DeviceChoice,
  devices: readonly Pick<MediaDeviceInfo, 'deviceId' | 'kind' | 'label'>[],
  previous: DeviceLabels = {},
): DeviceLabels {
  const labels: DeviceLabels = {};
  for (const [name, kind] of Object.entries(KINDS) as [keyof DeviceChoice, MediaDeviceKind][]) {
    const id = choice[name];
    if (!id) continue;
    const found = devices.find((device) => device.kind === kind && device.deviceId === id);
    const label = found?.label ? cleanLabel(found.label) : previous[name];
    if (label) labels[name] = label;
  }
  return labels;
}

/**
 * Названия → `deviceId` этого origin. Ровно одно устройство с таким видом и названием — оно; ни
 * одного или два одинаковых — по умолчанию системы (вида нет в выборе). Вид без названий у всех
 * устройств (нет разрешения) — как было. Только свои id: чужой сюда попасть не может.
 */
export function resolveDevices(
  labels: DeviceLabels,
  devices: readonly Pick<MediaDeviceInfo, 'deviceId' | 'kind' | 'label'>[],
  current: DeviceChoice,
): DeviceChoice {
  const next: DeviceChoice = {};
  for (const [name, kind] of Object.entries(KINDS) as [keyof DeviceChoice, MediaDeviceKind][]) {
    const ofKind = devices.filter((device) => device.kind === kind);
    if (!ofKind.some((device) => device.label)) {
      if (current[name]) next[name] = current[name];
      continue;
    }
    const label = labels[name];
    if (!label) continue;
    const matches = ofKind.filter((device) => cleanLabel(device.label) === label);
    if (matches.length === 1) next[name] = matches[0]!.deviceId;
  }
  return next;
}

function readLabels(value: unknown): DeviceLabels | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const labels: DeviceLabels = {};
  for (const name of Object.keys(KINDS) as (keyof DeviceChoice)[]) {
    const label = (value as Record<string, unknown>)[name];
    if (typeof label === 'string' && label) labels[name] = cleanLabel(label);
  }
  return labels;
}

async function listDevices() {
  try {
    return (await navigator.mediaDevices?.enumerateDevices()) ?? [];
  } catch {
    return [];
  }
}

// ---------- клиент Windows: общее у оболочки ----------

/** Что знает оболочка: значения (и названия устройств) — с bootstrap и с того, что мы ей отправили. */
let known: Values = {};
let pending: Record<string, Entry> = {};
let pendingSeed = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;
let stops: (() => void)[] = [];

function flush() {
  if (timer) clearTimeout(timer);
  timer = null;
  const entries = pending;
  const seed = pendingSeed;
  pending = {};
  pendingSeed = false;
  for (const shared of chunkEntries(entries))
    notifyDesktop('preferences.changed', { shared, ...(seed ? { seed: true } : {}) });
}

function queue(values: Values, at: number, seed = false) {
  if (!Object.keys(values).length) return;
  for (const [key, value] of Object.entries(values)) {
    pending[key] = { value, at };
    known[key] = value;
  }
  if (seed) {
    pendingSeed = true;
    flush();
    return;
  }
  if (timer) clearTimeout(timer);
  timer = setTimeout(flush, FLUSH_MS);
}

/** Сохранили настройки — оболочке уходит изменившееся общее; выбрали устройство — его название. */
function noteSaved(before: Preferences, after: Preferences, patch: Partial<Preferences>) {
  const at = Date.now();
  queue(changedShared(before, after, known), at);
  if (patch.devices) void noteDevices(after.devices, at);
}

async function noteDevices(choice: DeviceChoice, at: number) {
  const previous = readLabels(known[DEVICE_KEY]) ?? {};
  const labels = labelsOf(choice, await listDevices(), previous);
  if (!same(labels, previous) || !(DEVICE_KEY in known)) queue({ [DEVICE_KEY]: labels }, at);
}

/** Выбранные по названию устройства → свои id этого сервера (при запуске и при смене устройств). */
async function resolveKnownDevices() {
  const labels = readLabels(known[DEVICE_KEY]);
  if (!labels) return;
  const current = readPreferences().devices;
  const next = resolveDevices(labels, await listDevices(), current);
  if (!same(next, current)) writeLocalPreferences({ devices: next });
}

/** Оболочка прислала победившее (у неё новее): положить у себя, не отправляя обратно. */
function applyFromShell(data: Record<string, unknown>) {
  const shared = data.shared;
  if (!shared || typeof shared !== 'object' || Array.isArray(shared)) return;
  const patch: Values = {};
  let devices = false;
  for (const [key, value] of Object.entries(shared as Values)) {
    if (key === DEVICE_KEY) {
      if (readLabels(value)) {
        known[key] = value;
        devices = true;
      }
      continue;
    }
    if (!ALL_SHARED.includes(key) && !(SECRET_KEYS as readonly string[]).includes(key)) continue;
    known[key] = value;
    patch[key] = value;
  }
  if (Object.keys(patch).length) writeLocalPreferences(patch);
  if (devices) void resolveKnownDevices();
}

/**
 * Перенос со старых версий: у оболочки общего ещё нет — отдать ей всё своё. Пустой токен — не
 * переносить: «у этого сервера токена нет» не должно стереть токен другого.
 */
async function seed() {
  const prefs = readPreferences();
  const values: Values = sharedValues(prefs);
  const token = shareable('yandexMusicToken', prefs.yandexMusicToken);
  if (typeof token === 'string' && token) values.yandexMusicToken = token;
  const labels = labelsOf(prefs.devices, await listDevices());
  values[DEVICE_KEY] = labels;
  queue(values, Date.now(), true);
}

/**
 * Включить общие настройки, если оболочка их умеет (`prefs.shared`). Ждать стоит до первой
 * отрисовки: устройства по названию к ней уже сверены.
 */
export async function startSharedPreferences(): Promise<void> {
  if (started || !hasFeature(SHARED_FEATURE)) return;
  started = true;
  const boot = desktopBootstrap();
  const shared =
    boot?.shared && typeof boot.shared === 'object' && !Array.isArray(boot.shared) ? boot.shared : {};
  known = { ...shared };
  if (typeof boot?.yandexMusicToken === 'string') known.yandexMusicToken = boot.yandexMusicToken;
  setPreferencesSync(noteSaved);
  const changed = () => void resolveKnownDevices();
  navigator.mediaDevices?.addEventListener?.('devicechange', changed);
  window.addEventListener('pagehide', flush);
  stops = [
    onDesktopEvent('preferences.changed', applyFromShell),
    () => navigator.mediaDevices?.removeEventListener?.('devicechange', changed),
    () => window.removeEventListener('pagehide', flush),
  ];
  if (Object.keys(shared).length === 0) await seed();
  else await resolveKnownDevices();
}

/** Для тестов: забыть всё, что знали об оболочке. */
export function resetSharedPreferences() {
  if (timer) clearTimeout(timer);
  timer = null;
  pending = {};
  pendingSeed = false;
  known = {};
  started = false;
  stops.forEach((stop) => stop());
  stops = [];
  setPreferencesSync(null);
}

// ---------- браузер: фрагмент адреса при «Сменить сервер» ----------

export const FRAGMENT = 'cord-prefs';
/** Тема живёт отдельно от записи настроек (`cord:theme`), но тоже общая. */
const THEMES = ['light', 'dark', 'system'];
/** Предел фрагмента: длиннее — без аватара и ссылок кинозала (адрес всё равно уйдёт). */
const FRAGMENT_BUDGET = 8_000;

function base64url(text: string) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unbase64url(value: string) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

/** Несекретные общие настройки и тема — во фрагмент; токена и устройств в нём нет никогда. */
export function prefsFragment(
  prefs: Preferences = readPreferences(),
  theme = localStorage.getItem('cord:theme'),
): string {
  const values: Values = sharedValues(prefs);
  if (theme && THEMES.includes(theme)) values.theme = theme;
  let encoded = base64url(JSON.stringify(values));
  for (const heavy of ['avatar', 'cinemaLinks'])
    if (encoded.length > FRAGMENT_BUDGET) {
      delete values[heavy];
      encoded = base64url(JSON.stringify(values));
    }
  return `#${FRAGMENT}=${encoded}`;
}

/** Адрес сервера с фрагментом общих настроек — для «Сменить сервер» в браузере. */
export function withPrefsFragment(url: string): string {
  const target = new URL(url);
  target.hash = prefsFragment().slice(1);
  return target.toString();
}

/**
 * Перейти на сервер каталога с общими настройками. Ссылка сама называет, откуда переход
 * (`referrerPolicy: origin` — у страниц Cord `no-referrer`): так сервер-получатель отличит «Сменить
 * сервер» на соседнем сервере от чужой ссылки с подложенными настройками.
 */
export function goToServer(url: string) {
  if (isDesktop()) {
    location.assign(url);
    return;
  }
  const link = document.createElement('a');
  link.href = withPrefsFragment(url);
  link.referrerPolicy = 'origin';
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
}

/** Принятое из фрагмента: правка настроек и тема. */
export interface CarriedPreferences {
  patch: Partial<Preferences>;
  theme: string | null;
}

/**
 * Прочитать и **сразу** стереть фрагмент `#cord-prefs=…` (`history.replaceState`): даже испорченный
 * не остаётся в адресе. Из него берутся только общие ключи белого списка, сведённые тем же разбором,
 * что и свои; токен, устройства и всё прочее отбрасываются.
 */
export function takePrefsFragment(): CarriedPreferences | null {
  const hash = location.hash;
  const prefix = `#${FRAGMENT}=`;
  if (!hash.startsWith(prefix)) return null;
  try {
    history.replaceState(history.state, '', location.pathname + location.search);
  } catch {
    location.hash = '';
  }
  let raw: unknown;
  try {
    raw = JSON.parse(unbase64url(hash.slice(prefix.length)));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const data = raw as Values;
  const allowed: Values = {};
  for (const key of ALL_SHARED) if (key in data) allowed[key] = data[key];
  const parsed = parsePreferences(allowed, typeof allowed.name === 'string' ? allowed.name : null);
  const patch: Partial<Preferences> = {};
  for (const key of Object.keys(allowed)) {
    const value = field(parsed, key);
    if (value !== undefined) (patch as Values)[key] = value;
  }
  const theme = typeof data.theme === 'string' && THEMES.includes(data.theme) ? data.theme : null;
  if (!Object.keys(patch).length && !theme) return null;
  return { patch, theme };
}

/**
 * Применить принесённое, если переход был с сервера каталога этой установки (`document.referrer`
 * — origin, его назвала ссылка «Сменить сервер»). Иначе — забыть: чужая ссылка не меняет настройки.
 */
export async function acceptCarriedPreferences(
  carried: CarriedPreferences,
  referrer = document.referrer,
  catalog: () => Promise<CatalogServer[]> = loadServerCatalog,
): Promise<boolean> {
  let from: string;
  try {
    from = new URL(referrer).origin;
  } catch {
    return false;
  }
  if (from === location.origin) return false;
  const servers = await catalog().catch(() => [] as CatalogServer[]);
  if (!servers.some((server) => new URL(server.url).origin === from)) return false;
  if (Object.keys(carried.patch).length) savePreferences(carried.patch);
  if (carried.theme) {
    try {
      localStorage.setItem('cord:theme', carried.theme);
    } catch {
      /* тема останется своей */
    }
  }
  return true;
}
