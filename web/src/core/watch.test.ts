import { describe, expect, it } from 'vitest';
import type { Watch } from '../api/types';
import { correction, JUMP_LIMIT, NUDGE, targetPosition } from './watch';

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

  it('полсекунды разницы подтягивает скоростью, а не перемоткой', () => {
    // Перемотка тут стоила бы чёрного кадра и провала звука у всех, кого она коснулась.
    expect(correction({ watch: video(), serverNow, localMs: 69400, playing: true })).toEqual({
      action: 'rate',
      rate: 1 + NUDGE,
    });
    expect(correction({ watch: video(), serverNow, localMs: 70600, playing: true })).toEqual({
      action: 'rate',
      rate: 1 - NUDGE,
    });
  });

  it('разогнавшись однажды, не просит об этом каждую секунду', () => {
    expect(correction({ watch: video(), serverNow, localMs: 69400, playing: true, rate: 1 + NUDGE })).toEqual(
      { action: 'none' },
    );
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
