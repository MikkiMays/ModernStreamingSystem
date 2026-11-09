import { describe, expect, it } from 'vitest';
import { aheadOf, Playhead, type Watched } from './playhead';

function video(patch: Partial<Watched> & { ranges?: [number, number][] } = {}): Watched {
  const ranges = patch.ranges ?? [[0, 60]];
  return {
    currentTime: 10,
    paused: false,
    ended: false,
    seeking: false,
    muted: false,
    volume: 1,
    buffered: { length: ranges.length, start: (i) => ranges[i]![0], end: (i) => ranges[i]![1] },
    ...patch,
  };
}

/** Позиция идёт со скоростью `rate` (0 — стоит) от `from` до `to` мс, взгляд — раз в четверть секунды. */
function play(head: Playhead, element: Watched, from: number, to: number, rate = 1) {
  for (let at = from; at <= to; at += 250) {
    head.sample(at, element);
    element.currentTime += 0.25 * rate;
  }
}

describe('сторож позиции: идёт ли картинка на самом деле (R216)', () => {
  it('позиция идёт — не стоит, сколько бы раз браузер ни прислал `waiting`', () => {
    const head = new Playhead();
    const element = video();
    play(head, element, 0, 3000);
    expect(head.stalledMs(3000)).toBe(0);
    expect(head.playedMs(3000)).toBeGreaterThanOrEqual(2750);
  });

  it('позиция встала, хотя пауза не нажата, — считает с последнего движения; пауза — не застревание', () => {
    const head = new Playhead();
    const element = video();
    play(head, element, 0, 1000);
    play(head, element, 1250, 4000, 0);
    // Последний сдвиг виден на взгляде в 1250 мс (позиция сдвинулась после взгляда в 1000).
    expect(head.stalledMs(4000)).toBe(2750);
    expect(head.playedMs(4000)).toBe(0);
    element.paused = true;
    head.sample(4250, element);
    expect(head.stalledMs(4250)).toBe(0);
  });

  it('ожидание после перемотки за край загруженного меряется, внутри загруженного — нет', () => {
    const head = new Playhead();
    const element = video({ ranges: [[0, 20]] });
    play(head, element, 0, 500);
    // Внутри загруженного: пошла сразу, в оценку не идёт.
    element.currentTime = 15;
    head.seeking(500, element);
    play(head, element, 750, 1500);
    expect(head.resumeMs).toBeNull();
    expect(head.resumes).toBe(1);
    // За краем: четыре секунды ожидания.
    element.currentTime = 40;
    head.seeking(2000, element);
    play(head, element, 2250, 5750, 0);
    play(head, element, 6000, 7000);
    expect(head.lastResumeMs).toBe(4250);
    expect(head.resumeMs).toBe(4250);
    expect(head.resumes).toBe(2);
  });

  it('оценка ожидания — медиана: одно невезучее ожидание её не уводит', () => {
    const head = new Playhead();
    const element = video({ ranges: [] });
    let at = 0;
    for (const wait of [4000, 4000, 12_000]) {
      element.currentTime += 30;
      head.seeking(at, element);
      play(head, element, at + 250, at + wait - 250, 0);
      play(head, element, at + wait, at + wait + 500);
      at += wait + 1000;
    }
    // Движение видно на следующем взгляде — плюс четверть секунды к каждому ожиданию.
    expect(head.lastResumeMs).toBe(12_250);
    expect(head.resumeMs).toBe(4250);
  });

  it('звук: байты декодера стоят три секунды идущего фильма — звук застрял; без звука — не судим', () => {
    const head = new Playhead();
    const element = video({ webkitAudioDecodedByteCount: 0 });
    for (let at = 0; at <= 2000; at += 250) {
      head.sample(at, element);
      element.currentTime += 0.25;
      element.webkitAudioDecodedByteCount! += 4000;
    }
    expect(head.audioStalled).toBe(false);
    play(head, element, 2250, 6000);
    expect(head.audioStalled).toBe(true);
    // Перемотка — новый замер.
    head.seeking(6250, element);
    expect(head.audioStalled).toBe(false);
    // Звук выключен: декодеру молчать можно.
    element.muted = true;
    play(head, element, 6500, 12_000);
    expect(head.audioStalled).toBe(false);
  });

  it('звука нет вовсе (байты не росли ни разу) — не застрявший звук', () => {
    const head = new Playhead();
    const element = video({ webkitAudioDecodedByteCount: 0 });
    play(head, element, 0, 8000);
    expect(head.audioStalled).toBe(false);
  });

  it('загружено впереди: от позиции до конца её отрезка; вне загруженного — ноль', () => {
    const element = video({
      currentTime: 12,
      ranges: [
        [0, 5],
        [10, 30],
      ],
    });
    expect(aheadOf(element)).toBe(18);
    expect(aheadOf(element, 7)).toBe(0);
    expect(aheadOf(element, 30)).toBe(0);
  });
});
