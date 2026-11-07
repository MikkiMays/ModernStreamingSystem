import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatEnd,
  maintenance,
  maintenanceAhead,
  noteCapabilities,
  noteMeetingEnded,
  noteRefused,
  pollDelayMs,
  readStoredMaintenance,
  wakeMaintenanceWatch,
  watchMaintenance,
} from './maintenance';

const KEY = 'cord:maintenance:v1';
const HOUR = 3_600_000;
const now = () => Date.now();
const active = (over: object = {}) => ({
  phase: 'active' as const,
  startsAt: now() - 1000,
  endsAt: now() + HOUR,
  expiresAt: now() + 2 * HOUR,
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-10T01:00:00Z'));
  localStorage.clear();
  noteCapabilities({});
});
afterEach(() => {
  noteCapabilities({});
  vi.useRealTimers();
});

describe('что ядро сказало об окне', () => {
  it('идущее окно открывает страницу работ и запоминается на устройстве', () => {
    const notice = active();
    noteCapabilities({ maintenanceWindow: notice });
    expect(maintenance.get()).toEqual({
      endsAt: notice.endsAt,
      expiresAt: notice.expiresAt,
      endedMeeting: false,
    });
    expect(JSON.parse(localStorage.getItem(KEY)!)).toMatchObject({ expiresAt: notice.expiresAt });
  });

  it('окна нет или ядро о нём не знает — страницы нет, память стёрта', () => {
    noteCapabilities({ maintenanceWindow: active() });
    noteCapabilities({});
    expect(maintenance.get()).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
    noteCapabilities({ maintenanceWindow: active() });
    noteCapabilities({ maintenanceWindow: null } as unknown as Parameters<typeof noteCapabilities>[0]);
    expect(maintenance.get()).toBeNull();
  });

  // «Пока что никак нигде не отображать»: окно заранее и отсрочка — данные, а не страница.
  it.each(['scheduled', 'grace'] as const)('окно в фазе %s страницу не открывает', (phase) => {
    const notice = active({ phase, startsAt: now() + HOUR });
    noteCapabilities({ maintenanceWindow: notice });
    expect(maintenance.get()).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(maintenanceAhead.get()).toEqual(notice);
  });

  it('то же окно ещё раз не будит подписчиков: опрос не должен дёргать страницу', () => {
    const notice = active();
    noteCapabilities({ maintenanceWindow: notice });
    const listener = vi.fn();
    const stop = maintenance.subscribe(listener);
    noteCapabilities({ maintenanceWindow: notice });
    expect(listener).not.toHaveBeenCalled();
    stop();
  });

  it('отказ двери открывает страницу сразу, срок приедет с возможностями', () => {
    noteRefused();
    expect(maintenance.get()).toMatchObject({ endsAt: null, endedMeeting: false });
    const notice = active();
    noteCapabilities({ maintenanceWindow: notice });
    expect(maintenance.get()).toMatchObject({ endsAt: notice.endsAt, expiresAt: notice.expiresAt });
  });

  it('встречу завершили работы: страница знает об этом и после ответа возможностей', () => {
    noteMeetingEnded();
    expect(maintenance.get()?.endedMeeting).toBe(true);
    noteCapabilities({ maintenanceWindow: active() });
    expect(maintenance.get()?.endedMeeting).toBe(true);
    // Конец работ забывает и это: следующее окно начнётся с чистого листа.
    noteCapabilities({});
    noteCapabilities({ maintenanceWindow: active() });
    expect(maintenance.get()?.endedMeeting).toBe(false);
  });
});

describe('память устройства', () => {
  it('идущее окно переживает перезагрузку страницы без сети', () => {
    noteCapabilities({ maintenanceWindow: active() });
    expect(readStoredMaintenance()).toEqual(maintenance.get());
  });

  it('просроченное окно памяти не верит', () => {
    localStorage.setItem(KEY, JSON.stringify({ endsAt: null, expiresAt: now() - 1, endedMeeting: false }));
    expect(readStoredMaintenance()).toBeNull();
  });

  it.each(['не json', '{}', '{"expiresAt":"завтра"}', 'null'])('мусор %s — как будто окна нет', (text) => {
    localStorage.setItem(KEY, text);
    expect(readStoredMaintenance()).toBeNull();
  });

  it('хранилище закрыто (частное окно, встроенный браузер) — ничего не падает', () => {
    const blocked = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(readStoredMaintenance()).toBeNull();
    blocked.mockRestore();
    const refused = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(() => noteCapabilities({ maintenanceWindow: active() })).not.toThrow();
    expect(maintenance.get()).not.toBeNull();
    refused.mockRestore();
  });
});

describe('опрос', () => {
  it('паузы растут и упираются в минуту, с разбросом ±20 %: все клиенты не приходят разом', () => {
    const middle = () => 0.5;
    expect([0, 1, 2, 3, 4, 5, 50].map((attempt) => pollDelayMs(attempt, middle))).toEqual([
      5000, 10000, 20000, 30000, 60000, 60000, 60000,
    ]);
    expect(pollDelayMs(0, () => 0)).toBe(4000);
    expect(pollDelayMs(0, () => 1)).toBe(6000);
  });

  it('спрашивает сразу и больше не спрашивает, пока окна нет', async () => {
    const ask = vi.fn(() => Promise.resolve());
    const stop = watchMaintenance(ask);
    await vi.advanceTimersByTimeAsync(0);
    expect(ask).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(ask).toHaveBeenCalledTimes(1);
    stop();
  });

  it('окно идёт — спрашивает с паузами, окно кончилось — страница уходит сама', async () => {
    noteCapabilities({ maintenanceWindow: active() });
    const ask = vi.fn(() => Promise.resolve());
    const stop = watchMaintenance(ask);
    await vi.advanceTimersByTimeAsync(0);
    expect(ask).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6000);
    expect(ask).toHaveBeenCalledTimes(2);

    ask.mockImplementation(() => {
      noteCapabilities({});
      return Promise.resolve();
    });
    await vi.advanceTimersByTimeAsync(12000);
    expect(maintenance.get()).toBeNull();
    const asked = ask.mock.calls.length;
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(ask).toHaveBeenCalledTimes(asked);
    stop();
  });

  it('ядро не отвечает (его как раз перезапускают) — страница остаётся и спрашивает дальше', async () => {
    noteCapabilities({ maintenanceWindow: active() });
    const ask = vi.fn(() => Promise.reject(new Error('502')));
    const stop = watchMaintenance(ask);
    await vi.advanceTimersByTimeAsync(40000);
    expect(maintenance.get()).not.toBeNull();
    expect(ask.mock.calls.length).toBeGreaterThan(2);
    stop();
  });

  it('без связи после срока окна страница перестаёт себе верить', async () => {
    noteCapabilities({ maintenanceWindow: active({ expiresAt: now() + 20000 }) });
    const stop = watchMaintenance(() => Promise.reject(new Error('offline')));
    await vi.advanceTimersByTimeAsync(90000);
    expect(maintenance.get()).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
    stop();
  });

  it('ошибка самого вызова не ломает опрос', async () => {
    noteCapabilities({ maintenanceWindow: active() });
    const ask = vi.fn(() => {
      throw new Error('нет такого метода');
    });
    const stop = watchMaintenance(ask);
    await vi.advanceTimersByTimeAsync(7000);
    expect(ask.mock.calls.length).toBeGreaterThanOrEqual(2);
    stop();
  });

  it('сеть вернулась — спрашивает сразу, не дожидаясь паузы', async () => {
    noteCapabilities({ maintenanceWindow: active() });
    const ask = vi.fn(() => Promise.resolve());
    const stop = watchMaintenance(ask);
    await vi.advanceTimersByTimeAsync(0);
    expect(ask).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(ask).toHaveBeenCalledTimes(2);
    stop();
  });

  it('вкладка снова на виду — спрашивает, но не чаще раза в полминуты', async () => {
    const ask = vi.fn(() => Promise.resolve());
    const stop = watchMaintenance(ask);
    await vi.advanceTimersByTimeAsync(0);
    expect(ask).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(ask).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(31000);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(ask).toHaveBeenCalledTimes(2);
    stop();
  });

  it('окно заранее известно — спрашивает ровно к его началу', async () => {
    const startsAt = now() + HOUR;
    noteCapabilities({ maintenanceWindow: active({ phase: 'scheduled', startsAt }) });
    const ask = vi.fn(() => Promise.resolve());
    const stop = watchMaintenance(ask);
    await vi.advanceTimersByTimeAsync(0);
    expect(ask).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(HOUR - 1000);
    expect(ask).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ask).toHaveBeenCalledTimes(2);
    stop();
  });

  it('окно на три месяца вперёд таймеру не мешает: пауза не больше суток', async () => {
    const startsAt = now() + 90 * 24 * HOUR;
    noteCapabilities({ maintenanceWindow: active({ phase: 'scheduled', startsAt }) });
    const ask = vi.fn(() => Promise.resolve());
    const stop = watchMaintenance(ask);
    await vi.advanceTimersByTimeAsync(0);
    expect(ask).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(ask).toHaveBeenCalledTimes(2);
    stop();
  });

  it('разбудить можно снаружи: конец встречи и предупреждение ядра спрашивают сразу', async () => {
    const ask = vi.fn(() => Promise.resolve());
    const stop = watchMaintenance(ask);
    await vi.advanceTimersByTimeAsync(0);
    wakeMaintenanceWatch();
    await vi.advanceTimersByTimeAsync(0);
    expect(ask).toHaveBeenCalledTimes(2);
    stop();
    wakeMaintenanceWatch();
    await vi.advanceTimersByTimeAsync(0);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('отказ двери посреди тишины запускает опрос', async () => {
    const ask = vi.fn(() => Promise.resolve());
    const stop = watchMaintenance(ask);
    await vi.advanceTimersByTimeAsync(0);
    noteRefused();
    await vi.advanceTimersByTimeAsync(0);
    expect(ask).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(7000);
    expect(ask).toHaveBeenCalledTimes(3);
    stop();
  });

  it('снятый наблюдатель молчит', async () => {
    noteCapabilities({ maintenanceWindow: active() });
    const ask = vi.fn(() => Promise.resolve());
    const stop = watchMaintenance(ask);
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(HOUR);
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(ask).toHaveBeenCalledTimes(1);
  });
});

describe('срок для людей', () => {
  it('в тот же день — только время, в другой — и дата', () => {
    const today = new Date(2026, 10, 10, 9, 30).getTime();
    const later = new Date(2026, 10, 10, 11, 5).getTime();
    const tomorrow = new Date(2026, 10, 11, 1, 5).getTime();
    expect(formatEnd(later, today, 'ru')).toBe('11:05');
    const text = formatEnd(tomorrow, today, 'ru');
    expect(text).toContain('01:05');
    expect(text).toContain('11');
    expect(text).toContain('ноября');
  });
});
