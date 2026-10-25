import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IN_FLIGHT_MS, PAUSE_NOTICE_MS, VideoPauses } from './video-pause';

/*
  Пауза видео от SFU (R117): надпись — только после паузы не короче PAUSE_NOTICE_MS, гаснет сразу —
  по `Active` или по новым кадрам из сети, пока нет связи — молчит.
*/

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

const shown = (pauses: VideoPauses) => Object.keys(pauses.shown.get());

describe('надпись паузы', () => {
  it('пауза → надпись через PAUSE_NOTICE_MS → Active гасит сразу', () => {
    const pauses = new VideoPauses();
    pauses.pause('cam');
    vi.advanceTimersByTime(PAUSE_NOTICE_MS - 1);
    expect(shown(pauses)).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(shown(pauses)).toEqual(['cam']);
    expect(pauses.total.get()).toBe(1);
    pauses.resume('cam');
    // Без задержки: живой кадр под надписью — та же неправда, что молча застывший.
    expect(shown(pauses)).toEqual([]);
    vi.advanceTimersByTime(10_000);
    expect(shown(pauses)).toEqual([]);
    expect(pauses.total.get()).toBe(1);
  });

  it('короткая пауза не показывается никогда и не считается', () => {
    const pauses = new VideoPauses();
    const changes = vi.fn();
    pauses.shown.subscribe(changes);
    pauses.pause('cam');
    vi.advanceTimersByTime(PAUSE_NOTICE_MS - 200);
    pauses.resume('cam');
    vi.advanceTimersByTime(10_000);
    expect(shown(pauses)).toEqual([]);
    expect(changes).not.toHaveBeenCalled();
    expect(pauses.total.get()).toBe(0);
  });

  it('буфер приёма глубже порога — ждёт, пока он доиграет', () => {
    const pauses = new VideoPauses();
    pauses.pause('screen', 1000);
    vi.advanceTimersByTime(PAUSE_NOTICE_MS + 100);
    expect(shown(pauses)).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(shown(pauses)).toEqual(['screen']);
  });

  it('повторный Paused не перезапускает отсчёт', () => {
    const pauses = new VideoPauses();
    pauses.pause('cam');
    vi.advanceTimersByTime(PAUSE_NOTICE_MS - 100);
    pauses.pause('cam');
    vi.advanceTimersByTime(100);
    expect(shown(pauses)).toEqual(['cam']);
  });

  it('дорожки — каждая своя: пауза одной не трогает другую, значение не пересобирается зря', () => {
    const pauses = new VideoPauses();
    pauses.pause('a');
    vi.advanceTimersByTime(PAUSE_NOTICE_MS);
    pauses.pause('b');
    const before = pauses.shown.get();
    pauses.resume('b');
    expect(pauses.shown.get()).toBe(before);
    vi.advanceTimersByTime(PAUSE_NOTICE_MS);
    expect(shown(pauses)).toEqual(['a']);
    pauses.resume('missing');
    expect(pauses.shown.get()).toBe(before);
  });

  it('отписка дорожки — конец её паузы', () => {
    const pauses = new VideoPauses();
    pauses.pause('a');
    pauses.pause('b');
    vi.advanceTimersByTime(PAUSE_NOTICE_MS);
    pauses.retain(new Set(['b']));
    expect(shown(pauses)).toEqual(['b']);
    expect(pauses.holds('a')).toBe(false);
  });
});

describe('новый кадр из сети без Active', () => {
  it('рост принятых кадров при видимой надписи гасит её; Active следом ничего не ломает', () => {
    const pauses = new VideoPauses();
    pauses.pause('cam');
    vi.advanceTimersByTime(PAUSE_NOTICE_MS);
    expect(pauses.holds('cam')).toBe(true);
    pauses.frames('cam', 500);
    pauses.frames('cam', 500);
    expect(shown(pauses)).toEqual(['cam']);
    pauses.frames('cam', 501);
    expect(shown(pauses)).toEqual([]);
    // Картинка идёт — сторож зависаний снова на посту.
    expect(pauses.holds('cam')).toBe(false);
    pauses.resume('cam');
    // Следующая пауза — снова с отсчётом.
    pauses.pause('cam');
    vi.advanceTimersByTime(PAUSE_NOTICE_MS);
    expect(shown(pauses)).toEqual(['cam']);
    expect(pauses.total.get()).toBe(2);
  });

  it('кадры, что были в пути при решении SFU, паузу не снимают', () => {
    const pauses = new VideoPauses();
    pauses.pause('cam');
    pauses.frames('cam', 100);
    vi.advanceTimersByTime(IN_FLIGHT_MS - 50);
    pauses.frames('cam', 103);
    vi.advanceTimersByTime(PAUSE_NOTICE_MS);
    pauses.frames('cam', 103);
    pauses.frames('cam', 103);
    expect(shown(pauses)).toEqual(['cam']);
  });

  it('кадры пошли ещё до надписи — надписи не будет', () => {
    const pauses = new VideoPauses();
    pauses.pause('cam');
    vi.advanceTimersByTime(IN_FLIGHT_MS);
    pauses.frames('cam', 100);
    pauses.frames('cam', 110);
    vi.advanceTimersByTime(PAUSE_NOTICE_MS);
    expect(shown(pauses)).toEqual([]);
    expect(pauses.total.get()).toBe(0);
  });

  it('счётчик обнулился (новая дорожка) — это новая точка отсчёта, а не «кадры пошли»', () => {
    const pauses = new VideoPauses();
    pauses.pause('cam');
    vi.advanceTimersByTime(PAUSE_NOTICE_MS);
    pauses.frames('cam', 500);
    pauses.frames('cam', 0);
    expect(shown(pauses)).toEqual(['cam']);
    pauses.frames('cam', 1);
    expect(shown(pauses)).toEqual([]);
  });
});

describe('своя связь с SFU', () => {
  it('потеряна — надписи гаснут и не появляются; вернулась с паузой — снова через порог, без двойного счёта', () => {
    const pauses = new VideoPauses();
    pauses.pause('cam');
    vi.advanceTimersByTime(PAUSE_NOTICE_MS);
    pauses.suspend();
    expect(shown(pauses)).toEqual([]);
    pauses.pause('screen');
    vi.advanceTimersByTime(5000);
    expect(shown(pauses)).toEqual([]);
    // Кадры, пока связи нет, ни о чём не говорят.
    pauses.frames('cam', 1);
    pauses.frames('cam', 2);
    pauses.restore(new Set(['cam', 'screen']));
    vi.advanceTimersByTime(PAUSE_NOTICE_MS - 1);
    expect(shown(pauses)).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(shown(pauses).sort()).toEqual(['cam', 'screen']);
    expect(pauses.total.get()).toBe(2);
  });

  it('вернулась, а SDK паузы уже не знает (Active пришёл или дорожки новые) — надписи нет', () => {
    const pauses = new VideoPauses();
    pauses.pause('cam');
    vi.advanceTimersByTime(PAUSE_NOTICE_MS);
    pauses.suspend();
    pauses.restore(new Set());
    vi.advanceTimersByTime(PAUSE_NOTICE_MS * 2);
    expect(shown(pauses)).toEqual([]);
    expect(pauses.holds('cam')).toBe(false);
  });

  it('конец встречи снимает всё и останавливает отсчёт', () => {
    const pauses = new VideoPauses();
    pauses.pause('a');
    vi.advanceTimersByTime(PAUSE_NOTICE_MS);
    pauses.pause('b');
    pauses.clear();
    vi.advanceTimersByTime(PAUSE_NOTICE_MS);
    expect(shown(pauses)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
