import { useSyncExternalStore } from 'react';
import type { Admission } from '../api/types';
import { request } from '../api/client';
import { profileSecret } from './identity';

/**
 * Недавние встречи главной (R148, владелец 31.10.2026: «НЕДАВНИЕ ВСТРЕЧИ супер ВАЖНО»).
 *
 * Список живёт на устройстве, в `localStorage`: у каждого сервера своё хранилище, значит и список
 * у каждого сервера свой — ровно «на каждый серв свои только комнаты» (R146). Имён участников здесь
 * нет; пропуск (тот, с которым человек был во встрече) возвращает тем же участником, с правами
 * создателя, если он их имел. Профиль записан рядом, как у избранного: новый профиль — чужой список.
 *
 * Пределы — слово владельца (R165, 01.11.2026): не больше {@link RECENT_MAX} встреч и не дольше суток
 * ({@link RECENT_MS}) с последнего захода — встреча уходит целиком, вместе с пропуском. Интерфейс о
 * пределах молчит: шестая встреча просто вытесняет самую старую.
 *
 * Это не `core/recent.ts`: тот держит полные допуски в `sessionStorage` только ради перезагрузки
 * вкладки и в интерфейсе не виден.
 */
export interface RecentEntry {
  roomId: string;
  code: string;
  title: string;
  /** Создал ли встречу этот человек: создатель возвращается с правами ведущего. */
  creator: boolean;
  /** Последний раз во встрече — вход, правка в ней или выход; от него считается {@link RECENT_MS}. */
  lastAt: number;
  /** Пропуск и участник: живут столько же, сколько сама строка. */
  credential?: string;
  participantId?: string;
  /** Встреча завершена (по снимку). */
  closedAt?: number;
}

const KEY = 'cord:recent:v1';
/** Сколько встреч помнит список (R165): шестая вытесняет самую старую. */
export const RECENT_MAX = 5;
/**
 * Сколько встреча живёт в списке с последнего захода (R165) — сутки. Столько же жил и пропуск рядом с
 * ней (доверие к секрету профиля, что лежит рядом), так что строка без пропуска больше не нужна:
 * уходят вместе.
 */
export const RECENT_MS = 24 * 60 * 60 * 1000;
const CHANGED = 'cord:recent';

/**
 * Последний разбор: `useSyncExternalStore` ждёт тот же объект, пока ничего не поменялось. Годен,
 * пока не изменилась запись и не истекла самая старая строка.
 */
let cache: { raw: string | null; until: number; entries: RecentEntry[] } | null = null;

function valid(entry: unknown): entry is RecentEntry {
  const value = entry as RecentEntry;
  return (
    !!value &&
    typeof value.roomId === 'string' &&
    typeof value.code === 'string' &&
    typeof value.title === 'string' &&
    typeof value.lastAt === 'number'
  );
}

/** Когда строка уходит из списка. */
const expiresAt = (entry: RecentEntry) => entry.lastAt + RECENT_MS;

/** Свежие строки, новые сверху, не больше {@link RECENT_MAX}: одно правило и для чтения, и для записи. */
function prune(entries: RecentEntry[], now: number): RecentEntry[] {
  return entries
    .filter((entry) => expiresAt(entry) > now)
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, RECENT_MAX);
}

/** Список, новые сверху; старше суток и сверх пяти — стёрты при чтении. */
export function listRecent(now = Date.now()): RecentEntry[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return [];
  }
  if (cache && cache.raw === raw && now < cache.until) return cache.entries;
  let entries: RecentEntry[] = [];
  let stored = 0;
  try {
    const saved = JSON.parse(raw ?? 'null') as { profile?: string; items?: unknown } | null;
    if (saved?.profile === profileSecret() && Array.isArray(saved.items)) {
      const items = saved.items.filter(valid);
      stored = items.length;
      entries = prune(items, now);
    }
  } catch {
    entries = [];
  }
  // Ушедшее стирается и на диске, а не только в том, что отдаём: пропуск старше суток не должен лежать
  // в хранилище, даже если человек больше не заходит ни в одну встречу (ревью 01.11.2026).
  if (entries.length < stored) raw = persist(entries) ?? raw;
  cache = { raw, until: Math.min(Infinity, ...entries.map(expiresAt)), entries };
  return entries;
}

/** Записать список; вернуть записанное или null, если хранилище закрыто. */
function persist(entries: RecentEntry[]): string | null {
  const text = JSON.stringify({ profile: profileSecret(), items: entries });
  try {
    localStorage.setItem(KEY, text);
    return text;
  } catch {
    return null; // Хранилище закрыто — список просто не запомнится.
  }
}

function write(entries: RecentEntry[], now = Date.now()) {
  persist(prune(entries, now));
  window.dispatchEvent(new Event(CHANGED));
}

/** Записать вход или правку во встрече: сверху списка, название и состояние — из снимка. */
export function recordVisit(admission: Admission, now = Date.now()) {
  const snapshot = admission.snapshot;
  if (!snapshot?.code) return;
  const self = snapshot.participants.find((person) => person.id === admission.participantId);
  const previous = listRecent(now).find((entry) => entry.roomId === admission.roomId);
  const entry: RecentEntry = {
    roomId: admission.roomId,
    code: snapshot.code,
    title: snapshot.title,
    creator: !!self?.owner || !!previous?.creator,
    lastAt: now,
    credential: admission.credential,
    participantId: admission.participantId,
    ...(snapshot.closedAt ? { closedAt: snapshot.closedAt } : {}),
  };
  write([entry, ...listRecent(now).filter((item) => item.roomId !== admission.roomId)], now);
}

/**
 * Встреча закончилась, а список узнал об этом не из снимка, а при попытке вернуться (ответ ядра 404 или
 * 410): строка становится «завершённой» и следующим нажатием создаёт встречу снова.
 */
export function markEnded(roomId: string, now = Date.now()) {
  const entries = listRecent(now);
  if (!entries.some((entry) => entry.roomId === roomId && !entry.closedAt)) return;
  write(
    entries.map((entry) => (entry.roomId === roomId ? { ...entry, closedAt: now } : entry)),
    now,
  );
}

export function forgetRecent(roomId: string) {
  write(listRecent().filter((entry) => entry.roomId !== roomId));
}

export function clearRecent() {
  write([]);
}

/**
 * Подписка интерфейса: запись здесь, запись в соседней вкладке (`storage`) — и истечение суток самой
 * старой строки, пока главная открыта: без таймера она дожила бы до первой правки списка.
 */
function subscribe(changed: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    const until = Math.min(Infinity, ...listRecent().map(expiresAt));
    // `setTimeout` дольше 2³¹ мс срабатывает сразу; до суток здесь всё равно не дальше.
    if (until < Infinity) timer = setTimeout(update, Math.min(until - Date.now(), 2 ** 31 - 1) + 1);
  };
  const update = () => {
    changed();
    arm();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === KEY) update();
  };
  window.addEventListener(CHANGED, update);
  window.addEventListener('storage', onStorage);
  arm();
  return () => {
    clearTimeout(timer);
    window.removeEventListener(CHANGED, update);
    window.removeEventListener('storage', onStorage);
  };
}

/** Список для интерфейса: меняется и из соседней вкладки (`storage`). */
export function useRecentMeetings(): RecentEntry[] {
  return useSyncExternalStore(subscribe, () => listRecent());
}

export type PresenceState = 'live' | 'open' | 'closed' | 'gone';
export interface Presence {
  roomId: string;
  state: PresenceState;
  people: number;
  title: string | null;
  code: string | null;
}

/** Что с встречами сейчас — одним запросом, только по живым пропускам (ядро: `rooms/presence`). */
export async function fetchPresence(entries: RecentEntry[]): Promise<Map<string, Presence>> {
  const rooms = entries
    .filter((entry) => entry.credential)
    .map((entry) => ({ roomId: entry.roomId, credential: entry.credential! }));
  if (!rooms.length) return new Map();
  const answers = await request<Presence[]>('/rooms/presence', {
    method: 'POST',
    body: JSON.stringify({ rooms }),
  });
  return new Map(answers.map((answer) => [answer.roomId, answer]));
}

/**
 * Название для «Создать снова»: предвход берёт его один раз вместо «Новой встречи». В
 * `sessionStorage` — только до первого показа предвхода в этой вкладке.
 */
const CREATE_TITLE = 'cord:create-title';
export function offerCreateTitle(title: string) {
  try {
    sessionStorage.setItem(CREATE_TITLE, title.slice(0, 80));
  } catch {
    /* Без названия — предвход предложит своё. */
  }
}
export function readCreateTitle(): string | null {
  try {
    return sessionStorage.getItem(CREATE_TITLE);
  } catch {
    return null;
  }
}
export function clearCreateTitle() {
  try {
    sessionStorage.removeItem(CREATE_TITLE);
  } catch {
    /* Нечего чистить. */
  }
}
