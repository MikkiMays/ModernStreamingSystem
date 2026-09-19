import { describe, expect, it } from 'vitest';
import type { Watch } from '../api/types';
import { correction, targetPosition } from './watch';

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

  it('молчит, пока расхождение в пределах допустимого', () => {
    expect(correction({ watch: video(), serverNow, localMs: 70600, playing: true })).toEqual({
      action: 'none',
    });
  });

  it('отставшего догоняет с запасом, забежавшего возвращает ровно', () => {
    expect(correction({ watch: video(), serverNow, localMs: 60000, playing: true })).toEqual({
      action: 'seek',
      positionMs: 70400,
    });
    expect(correction({ watch: video(), serverNow, localMs: 80000, playing: true })).toEqual({
      action: 'seek',
      positionMs: 70000,
    });
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
});
