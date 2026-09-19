import { describe, expect, it } from 'vitest';
import { levelLabel, qualities, type Level } from './watch-levels';

const level = (height: number, bitrate: number, fps = 25): Level => ({
  height,
  bitrate,
  attrs: { 'FRAME-RATE': String(fps) },
});

/** То, что YouTube правда отдаёт на обычный фильм: шестнадцать уровней на шесть высот. */
const youtube: Level[] = [
  level(240, 372748),
  level(240, 457229),
  level(360, 853277),
  level(480, 1402889),
  level(720, 2354527),
  level(144, 329054),
  level(1080, 4752803),
  level(144, 407179, 13),
  level(144, 442941),
  level(240, 486578),
  level(240, 571059),
  level(360, 729800),
  level(480, 1069907),
  level(720, 1875202),
  level(1080, 2957148),
  level(1080, 4716663),
];

describe('меню качества', () => {
  it('одна запись на высоту, а не по одной на кодек', () => {
    // Жалоба была ровно про это: «постоянно дублирующиеся записи».
    expect(qualities(youtube).map((q) => q.label)).toEqual(['1080p', '720p', '480p', '360p', '240p', '144p']);
  });

  it('внутри высоты остаётся самый дешёвый поток', () => {
    const chosen = qualities(youtube).find((q) => q.label === '1080p');
    // 2 957 148 — это VP9 в том же 1080p: та же картинка, на треть меньше нашего канала.
    expect(chosen?.level).toBe(14);
  });

  it('шестьдесят кадров — это отдельное качество, а не то же самое', () => {
    const list = qualities([level(1080, 3_000_000, 30), level(1080, 5_000_000, 60)]);
    expect(list.map((q) => q.label)).toEqual(['1080p60', '1080p']);
  });

  it('поток без высоты называется битрейтом, а не пустотой', () => {
    expect(levelLabel({ bitrate: 800_000 })).toBe('800 кбит/с');
    expect(levelLabel({})).toBe('Как есть');
    expect(levelLabel(undefined)).toBe('');
  });

  it('один уровень — один выбор', () => {
    expect(qualities([level(720, 1_000_000)])).toEqual([{ level: 0, label: '720p' }]);
  });
});
