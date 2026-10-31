import { useSyncExternalStore } from 'react';
import type { Admission } from '../api/types';
import { request } from '../api/client';
import { profileSecret } from './identity';

/**
 * Недавние встречи главной (R148, владелец 31.10.2026: «НЕДАВНИЕ ВСТРЕЧИ супер ВАЖНО»).
 *
 * Список живёт на устройстве, в `localStorage`: у каждого сервера своё хранилище, значит и список
 * у каждого сервера свой — ровно «на каждый серв свои только комнаты» (R146). Имён участников здесь
 * нет; пропуск (тот, с которым человек был во встрече) хранится не дольше суток — с ним «Вернуться»
 * возвращает тем же участником, с правами создателя, если он их имел. Профиль записан рядом, как у
 * избранного: новый профиль — чужой список.
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
  /** Последний раз во встрече — вход, правка в ней или выход. */
  lastAt: number;
  /** Пропуск и участник — пока не истёк срок {@link CREDENTIAL_MS}. */
  credential?: string;
  participantId?: string;
  credentialUntil?: number;
  /** Встреча завершена (по снимку). */
  closedAt?: number;
}

const KEY = 'cord:recent:v1';
export const RECENT_MAX = 20;
/** Пропуск в списке живёт сутки — как доверие к секрету профиля, что лежит рядом. */
export const CREDENTIAL_MS = 24 * 60 * 60 * 1000;
const CHANGED = 'cord:recent';

/**
 * Последний разбор: `useSyncExternalStore` ждёт тот же объект, пока ничего не поменялось. Годен,
 * пока не изменилась запись и не истёк ближайший пропуск.
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

/** Список, новые сверху; истёкшие пропуска стёрты при чтении. */
export function listRecent(now = Date.now()): RecentEntry[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return [];
  }
  if (cache && cache.raw === raw && now < cache.until) return cache.entries;
  let entries: RecentEntry[] = [];
  try {
    const saved = JSON.parse(raw ?? 'null') as { profile?: string; items?: unknown } | null;
    if (saved?.profile === profileSecret() && Array.isArray(saved.items))
      entries = saved.items
        .filter(valid)
        .map((entry) =>
          entry.credentialUntil && entry.credentialUntil > now
            ? entry
            : { ...entry, credential: undefined, participantId: undefined, credentialUntil: undefined },
        )
        .sort((a, b) => b.lastAt - a.lastAt)
        .slice(0, RECENT_MAX);
  } catch {
    entries = [];
  }
  const until = Math.min(
    Infinity,
    ...entries.flatMap((entry) => (entry.credentialUntil ? [entry.credentialUntil] : [])),
  );
  cache = { raw, until, entries };
  return entries;
}

function write(entries: RecentEntry[]) {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({ profile: profileSecret(), items: entries.slice(0, RECENT_MAX) }),
    );
  } catch {
    /* Хранилище закрыто — список просто не запомнится. */
  }
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
    credentialUntil: now + CREDENTIAL_MS,
    ...(snapshot.closedAt ? { closedAt: snapshot.closedAt } : {}),
  };
  write([entry, ...listRecent(now).filter((item) => item.roomId !== admission.roomId)]);
}

export function forgetRecent(roomId: string) {
  write(listRecent().filter((entry) => entry.roomId !== roomId));
}

export function clearRecent() {
  write([]);
}

function subscribe(changed: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === KEY) changed();
  };
  window.addEventListener(CHANGED, changed);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CHANGED, changed);
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
    .slice(0, RECENT_MAX)
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
