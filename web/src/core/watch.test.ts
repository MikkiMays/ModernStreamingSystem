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
