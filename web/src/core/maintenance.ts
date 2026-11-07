import type { Capabilities } from '../api/types';
import { Store } from './store';

/**
 * Технические работы глазами клиента (R194, Р-95).
 *
 * Страницу открывают три вещи: возможности сервера при загрузке и в опросе, встреча, которую завершили
 * работы, и отказ двери `503 MAINTENANCE_WINDOW`. Дренаж выкатки (`503 MAINTENANCE`) — другое: идущие
 * встречи при нём живут, и страницы нет.
 *
 * Страница уходит сама, когда возможности сказали, что окна больше нет: опрос с паузами до минуты,
 * плюс сразу — вернулась сеть или вкладка снова на виду. Ядро не отвечает — обычное дело на работах
 * (его как раз перезапускают): страница остаётся и спрашивает дальше. Окно хранится на устройстве, чтобы
 * открытие без ответа ядра не показало «сервер не отвечает», но только до автоматического выхода окна
 * (`expiresAt`): дальше память устройства недостоверна, и работает обычная логика без связи.
 */
export type MaintenanceNotice = NonNullable<Capabilities['maintenanceWindow']>;

export interface ActiveMaintenance {
  /** Когда обещали закончить; `null` — не обещали. */
  endsAt: number | null;
  /** После этого момента клиент без связи перестаёт верить, что окно ещё идёт. */
  expiresAt: number;
  /** Человека вывели из встречи: страница называет причину. */
  endedMeeting: boolean;
}

const KEY = 'cord:maintenance:v1';
/** Отказ двери срока не называет, а возможности могут не ответить: столько верим отказу без них. */
const REFUSAL_TRUST_MS = 10 * 60_000;
const BACKOFF_MS = [5_000, 10_000, 20_000, 30_000, 60_000];
/** Чаще этого вкладка, снова оказавшаяся на виду, ядро не спрашивает. */
const VISIBLE_EVERY_MS = 30_000;
/** Таймер браузера дальше 24 дней не умеет; окно заранее перепроверяется раз в сутки. */
const LONGEST_WAIT_MS = 24 * 3_600_000;

export function readStoredMaintenance(): ActiveMaintenance | null {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<ActiveMaintenance> | null;
    if (typeof stored?.expiresAt !== 'number' || stored.expiresAt <= Date.now()) return null;
    return {
      endsAt: typeof stored.endsAt === 'number' ? stored.endsAt : null,
      expiresAt: stored.expiresAt,
      endedMeeting: stored.endedMeeting === true,
    };
  } catch {
    return null;
  }
}

/** Идёт окно — страница работ вместо приложения. */
export const maintenance = new Store<ActiveMaintenance | null>(readStoredMaintenance());
/** Окно впереди (заранее или отсрочка): данные готовы, в интерфейсе их пока нет. */
export const maintenanceAhead = new Store<MaintenanceNotice | null>(null);

function show(next: ActiveMaintenance | null) {
  const current = maintenance.get();
  if (
    current?.endsAt === next?.endsAt &&
    current?.expiresAt === next?.expiresAt &&
    current?.endedMeeting === next?.endedMeeting
  )
    return;
  maintenance.set(next);
  try {
    if (next) localStorage.setItem(KEY, JSON.stringify(next));
    else localStorage.removeItem(KEY);
  } catch {
    /* Память закрыта: страница работает, только перезагрузка без сети её не вспомнит. */
  }
}

/** Что сказали возможности сервера: единственное, что закрывает страницу. */
export function noteCapabilities({ maintenanceWindow: notice }: Pick<Capabilities, 'maintenanceWindow'>) {
  if (notice?.phase === 'active') {
    maintenanceAhead.set(null);
    show({
      endsAt: notice.endsAt ?? null,
      expiresAt: notice.expiresAt,
      endedMeeting: maintenance.get()?.endedMeeting ?? false,
    });
    return;
  }
  show(null);
  const ahead = maintenanceAhead.get();
  if (
    ahead?.startsAt !== notice?.startsAt ||
    ahead?.phase !== notice?.phase ||
    ahead?.endsAt !== notice?.endsAt
  )
    maintenanceAhead.set(notice ?? null);
}

/** Дверь ответила `503 MAINTENANCE_WINDOW`: страница сразу, срок приедет с возможностями. */
export function noteRefused() {
  show(maintenance.get() ?? { endsAt: null, expiresAt: Date.now() + REFUSAL_TRUST_MS, endedMeeting: false });
  wakeMaintenanceWatch();
}

/** Встречу завершили работы: то же, но человеку надо сказать, почему разговор оборвался. */
export function noteMeetingEnded() {
  const current = maintenance.get();
  show({
    endsAt: current?.endsAt ?? null,
    expiresAt: current?.expiresAt ?? Date.now() + REFUSAL_TRUST_MS,
    endedMeeting: true,
  });
  wakeMaintenanceWatch();
}

/** Пауза перед следующим вопросом: растёт до минуты, разброс ±20 % — клиенты не приходят разом. */
export function pollDelayMs(attempt: number, random: () => number = Math.random) {
  const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
  return Math.round(base * (0.8 + random() * 0.4));
}

let wake: (() => void) | null = null;

/** Спросить ядро сейчас: встреча кончилась не сама, или ядро предупредило об окне. */
export function wakeMaintenanceWatch() {
  wake?.();
}

/**
 * Следить за окном. `ask` — запрос возможностей: ответ сам попадает в `noteCapabilities`.
 *
 * Спрашивает сразу; пока окно идёт — с паузами; окно заранее известно — к его началу; без окна молчит
 * и спрашивает, только когда вкладка снова на виду или его будят снаружи.
 */
export function watchMaintenance(ask: () => Promise<unknown>) {
  let stopped = false;
  let asking = false;
  let polls = 0;
  let askedAt = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const plan = () => {
    clearTimeout(timer);
    if (stopped) return;
    if (maintenance.get()) {
      timer = setTimeout(check, pollDelayMs(Math.max(0, polls - 1)));
      return;
    }
    polls = 0;
    const ahead = maintenanceAhead.get();
    if (ahead)
      timer = setTimeout(
        check,
        Math.min(Math.max(ahead.startsAt - Date.now(), BACKOFF_MS[0]!), LONGEST_WAIT_MS),
      );
  };
  const lapse = () => {
    const current = maintenance.get();
    if (current && Date.now() >= current.expiresAt) show(null);
  };
  function check() {
    if (stopped || asking) return;
    asking = true;
    polls += 1;
    askedAt = Date.now();
    clearTimeout(timer);
    void Promise.resolve()
      .then(ask)
      .catch(lapse)
      .finally(() => {
        asking = false;
        plan();
      });
  }
  const changed = () => {
    if (!asking) plan();
  };
  const onVisible = () => {
    if (document.visibilityState === 'visible' && Date.now() - askedAt >= VISIBLE_EVERY_MS) check();
  };
  const unsubscribe = [maintenance.subscribe(changed), maintenanceAhead.subscribe(changed)];
  window.addEventListener('online', check);
  document.addEventListener('visibilitychange', onVisible);
  wake = check;
  check();
  return () => {
    stopped = true;
    clearTimeout(timer);
    unsubscribe.forEach((stop) => stop());
    window.removeEventListener('online', check);
    document.removeEventListener('visibilitychange', onVisible);
    if (wake === check) wake = null;
  };
}

/** Срок для людей — по часам этого устройства: в тот же день только время, в другой — и дата. */
export function formatEnd(endsAt: number, now: number, language: string) {
  const end = new Date(endsAt);
  const sameDay = end.toDateString() === new Date(now).toDateString();
  return new Intl.DateTimeFormat(language, {
    ...(sameDay ? {} : { day: 'numeric', month: 'long' }),
    hour: '2-digit',
    minute: '2-digit',
  }).format(end);
}
