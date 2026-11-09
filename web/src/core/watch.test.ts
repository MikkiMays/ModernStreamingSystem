import { describe, expect, it } from 'vitest';
import type { Watch } from '../api/types';
import {
  CATCH_UP_LEAD,
  catchUp,
  catchUpLead,
  correction,
  JUMP_LIMIT,
  MAX_LEAD,
  NUDGE,
  NUDGE_PATIENCE,
  nudgeRate,
  targetPosition,
} from './watch';

const video = (patch: Partial<Watch> = {}): Watch => ({
  provider: 'youtube',
  kind: 'video',
  contentId: 'dQw4w9WgXcQ',
  title: null,
  openedBy: 'someone',
  paused: false,
  positionMs: 60000,
  anchorAt: 1_000_000,
  revision: 3,
  ...patch,
});

describe('где должен идти ролик', () => {
  it('идущий ролик считает время сам', () => {
    expect(targetPosition(video(), 1_000_000)).toBe(60000);
    expect(targetPosition(video(), 1_010_000)).toBe(70000);
  });

  it('на паузе позиция не уходит', () => {
    expect(targetPosition(video({ paused: true }), 1_050_000)).toBe(60000);
  });
});

describe('поправка своего плеера', () => {
  const serverNow = 1_010_000; // цель — 70 000 мс

  it('молчит, пока расхождение меньше десятой доли секунды', () => {
    expect(correction({ watch: video(), serverNow, localMs: 70050, playing: true })).toEqual({
      action: 'none',
    });
  });

  it('полсекунды разницы подтягивает скоростью, а не перемоткой — пропорционально расхождению', () => {
    // Перемотка тут стоила бы чёрного кадра и провала звука у всех, кого она коснулась.
    expect(correction({ watch: video(), serverNow, localMs: 69400, playing: true })).toEqual({
      action: 'rate',
      rate: 1.06,
    });
    expect(correction({ watch: video(), serverNow, localMs: 70600, playing: true })).toEqual({
      action: 'rate',
      rate: 0.94,
    });
    // Секунда и больше — потолок: сильнее уже слышно.
    expect(correction({ watch: video(), serverNow, localMs: 68800, playing: true })).toEqual({
      action: 'rate',
      rate: 1 + NUDGE,
    });
    expect(nudgeRate(-350)).toBe(1.035);
    expect(nudgeRate(5000)).toBe(1 - NUDGE);
  });

  it('разогнавшись однажды, не просит об этом каждую секунду', () => {
    expect(correction({ watch: video(), serverNow, localMs: 69400, playing: true, rate: 1.06 })).toEqual({
      action: 'none',
    });
    // Расхождение чуть сдвинулось — скорость не дёргается ради сотых.
    expect(correction({ watch: video(), serverNow, localMs: 69450, playing: true, rate: 1.06 })).toEqual({
      action: 'none',
    });
  });

  it('догнав, возвращает обычную скорость', () => {
    expect(correction({ watch: video(), serverNow, localMs: 70050, playing: true, rate: 1 + NUDGE })).toEqual(
      { action: 'rate', rate: 1 },
    );
    // А на полпути к цели скорость не дребезжит: между «догнали» и «пора» её не трогают.
    expect(correction({ watch: video(), serverNow, localMs: 69800, playing: true, rate: 1 + NUDGE })).toEqual(
      { action: 'none' },
    );
  });

  it('настоящий разрыв — это перемотка, отставшего с запасом', () => {
    expect(correction({ watch: video(), serverNow, localMs: 60000, playing: true })).toEqual({
      action: 'seek',
      positionMs: 70400,
    });
    expect(correction({ watch: video(), serverNow, localMs: 80000, playing: true })).toEqual({
      action: 'seek',
      positionMs: 70000,
    });
    expect(JUMP_LIMIT).toBeGreaterThan(1000);
  });

  it('включает и останавливает вслед за комнатой', () => {
    expect(correction({ watch: video(), serverNow, localMs: 70000, playing: false })).toEqual({
      action: 'play',
    });
    expect(correction({ watch: video({ paused: true }), serverNow, localMs: 60000, playing: true })).toEqual({
      action: 'pause',
      positionMs: 60000,
    });
  });

  it('включаясь вслед за комнатой, встаёт туда, где она сейчас, а не где стоял на паузе', () => {
    // Пуск доходит до зрителя через сеть и ближайшую проверку — к этому времени комната ушла вперёд
    // на секунду-другую. Включиться с места паузы значило бы потом минуту догонять скоростью.
    expect(correction({ watch: video(), serverNow, localMs: 68100, playing: false })).toEqual({
      action: 'play',
      positionMs: 70400,
    });
    // Убежавший вперёд встаёт ровно в цель, а разница в пределах «не трогать» — не повод прыгать.
    expect(correction({ watch: video(), serverNow, localMs: 71000, playing: false })).toEqual({
      action: 'play',
      positionMs: 70000,
    });
    expect(correction({ watch: video(), serverNow, localMs: 69800, playing: false })).toEqual({
      action: 'play',
    });
  });

  it('досмотренный ролик не начинается заново: `play()` после конца — это перемотка в начало', () => {
    const over = { watch: video(), serverNow, localMs: 65000, playing: false, ended: true };
    expect(correction(over)).toEqual({ action: 'none' });
    expect(correction({ ...over, rate: 1 + NUDGE })).toEqual({ action: 'rate', rate: 1 });
    // А если комната ещё до конца не дошла (или её отмотали назад) — включиться с её места.
    expect(correction({ ...over, localMs: 90000 })).toEqual({ action: 'play', positionMs: 70000 });
  });

  it('подтяжка, которая не тянет, уступает перемотке; в пределах «не трогать» — просто гаснет', () => {
    expect(
      correction({
        watch: video(),
        serverNow,
        localMs: 69000,
        playing: true,
        rate: 1 + NUDGE,
        stalled: true,
      }),
    ).toEqual({ action: 'seek', positionMs: 70400 });
    expect(
      correction({
        watch: video(),
        serverNow,
        localMs: 70700,
        playing: true,
        rate: 1 - NUDGE,
        stalled: true,
      }),
    ).toEqual({ action: 'seek', positionMs: 70000 });
    expect(
      correction({
        watch: video(),
        serverNow,
        localMs: 69800,
        playing: true,
        rate: 1 + NUDGE,
        stalled: true,
      }),
    ).toEqual({ action: 'rate', rate: 1 });
  });

  it('на паузе возвращает обычную скорость, чтобы включиться ровно', () => {
    expect(
      correction({
        watch: video({ paused: true }),
        serverNow,
        localMs: 60000,
        playing: false,
        rate: 1 + NUDGE,
      }),
    ).toEqual({ action: 'rate', rate: 1 });
  });

  it('живой эфир только включает и больше не трогает', () => {
    const live: Watch = { ...video(), provider: 'twitch', kind: 'channel', contentId: 'someone' };
    // Догонять в эфире нечего, но играть его должен каждый сам: комнате тут сказать нечего.
    expect(correction({ watch: live, serverNow, localMs: 0, playing: false })).toEqual({
      action: 'play',
    });
    expect(correction({ watch: live, serverNow, localMs: 999999, playing: true })).toEqual({
      action: 'none',
    });
  });

  it('незакончившаяся запись эфира — это тоже эфир', () => {
    // Twitch отдаёт её как ролик, но пока трансляция идёт, секунды, к которой мы перематываем,
    // в потоке ещё нет: перемотка превращается в бесконечную буферизацию.
    expect(correction({ watch: video(), live: true, serverNow, localMs: 0, playing: true })).toEqual({
      action: 'none',
    });
  });
});

describe('подтяжка под присмотром', () => {
  const T = 5_000_000;

  it('окно открывается с первой проверкой подтяжки и закрывается, когда она кончилась', () => {
    expect(catchUp(null, { now: T, driftMs: -1000, nudging: false })).toEqual({ next: null, stalled: false });
    const opened = catchUp(null, { now: T, driftMs: -1000, nudging: true });
    expect(opened).toEqual({ next: { since: T, driftMs: -1000 }, stalled: false });
    expect(catchUp(opened.next, { now: T + 2000, driftMs: -990, nudging: true })).toEqual(opened);
    expect(catchUp(opened.next, { now: T + 2000, driftMs: -990, nudging: false })).toEqual({
      next: null,
      stalled: false,
    });
  });

  it('тянет хотя бы вполовину обещанного — ждём дальше с нового места', () => {
    // Пять секунд на 5 % обещают 250 мс; отыграно 150 — медленно, но работает.
    const window = { since: T, driftMs: -1000 };
    expect(catchUp(window, { now: T + NUDGE_PATIENCE, driftMs: -850, nudging: true })).toEqual({
      next: { since: T + NUDGE_PATIENCE, driftMs: -850 },
      stalled: false,
    });
    // Проскочили цель — это не застревание: окно с нуля, уже в другую сторону.
    expect(catchUp(window, { now: T + 3000, driftMs: 200, nudging: true })).toEqual({
      next: { since: T + 3000, driftMs: 200 },
      stalled: false,
    });
  });

  it('за пять секунд отыграно меньше половины обещанного — подтяжка не тянет', () => {
    // Устройство, теряющее кадры на 1,05, шло в 1,003 реального времени: 15 мс за пять секунд.
    expect(
      catchUp({ since: T, driftMs: -1000 }, { now: T + NUDGE_PATIENCE, driftMs: -985, nudging: true }),
    ).toEqual({ next: null, stalled: true });
    // Разошлись ещё сильнее (буферизация на подтяжке) — тем более.
    expect(catchUp({ since: T, driftMs: 800 }, { now: T + 6000, driftMs: 900, nudging: true })).toEqual({
      next: null,
      stalled: true,
    });
  });
});

describe('догоняя комнату у медленного плеера (R216)', () => {
  const now = 1_000_000 + 10_000;

  it('упреждение: в загруженное — 400 мс, за край загруженного — сколько этот плеер ждёт данные', () => {
    expect(catchUpLead({ buffered: true, resumeMs: 4000 })).toBe(CATCH_UP_LEAD);
    expect(catchUpLead({ buffered: false, resumeMs: null })).toBe(CATCH_UP_LEAD);
    expect(catchUpLead({ buffered: false, resumeMs: 4000 })).toBe(4400);
    expect(catchUpLead({ buffered: false, resumeMs: 50 })).toBe(450);
    expect(catchUpLead({ buffered: false, resumeMs: 60_000 })).toBe(MAX_LEAD);
  });

  it('перемотка вдогонку целится туда, где комната будет, когда плеер дождётся данных', () => {
    const fix = correction({ watch: video(), serverNow: now, localMs: 60_000, playing: true, leadMs: 4400 });
    expect(fix).toEqual({ action: 'seek', positionMs: 70_000 + 4400 });
  });

  it('только что догоняли — второй перемотки нет: скорость там, где она честная, иначе ждём', () => {
    const behind = { watch: video(), serverNow: now, localMs: 60_000, playing: true, canSeek: false };
    expect(correction(behind)).toEqual({ action: 'rate', rate: 1 + NUDGE });
    expect(correction({ ...behind, rateSafe: false })).toEqual({ action: 'none' });
    expect(correction({ ...behind, rateSafe: false, rate: 1.1 })).toEqual({ action: 'rate', rate: 1 });
  });

  it('где скорость не честная (телевизор), расхождение до перемотки терпят, а дальше — перемотка', () => {
    const tv = { watch: video(), serverNow: now, playing: true, rateSafe: false };
    expect(correction({ ...tv, localMs: 70_000 - 2000 })).toEqual({ action: 'none' });
    expect(correction({ ...tv, localMs: 70_000 + 2000 })).toEqual({ action: 'none' });
    expect(correction({ ...tv, localMs: 70_000 - 2000, rate: 1.05 })).toEqual({ action: 'rate', rate: 1 });
    expect(correction({ ...tv, localMs: 70_000 - JUMP_LIMIT - 1 })).toEqual({
      action: 'seek',
      positionMs: 70_000 + CATCH_UP_LEAD,
    });
  });
});
