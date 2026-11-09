import { describe, expect, it } from 'vitest';
import { t } from '../../../i18n';
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
    expect(qualities(t, youtube).map((q) => q.label)).toEqual([
      '1080p',
      '720p',
      '480p',
      '360p',
      '240p',
      '144p',
    ]);
  });

  it('не выбирает худший битрейт у неизвестного кодека', () => {
    const chosen = qualities(t, youtube).find((q) => q.label === '1080p');
    expect(chosen?.level).toBe(6);
  });

  it('кодеков в меню нет: одна строка на высоту, за ней — ступень кодека просмотра', () => {
    // Движок пометил чужой кодек `fit: false` (`engines/hls.ts`): просмотр идёт на H.264.
    const levels: Level[] = [
      { ...level(1080, 3_000_000), videoCodec: 'vp09.00.40.08', fit: false },
      { ...level(1080, 4_500_000), videoCodec: 'avc1.640028' },
      { ...level(1080, 4_000_000), videoCodec: 'avc1.640028' },
      { ...level(720, 1_500_000), videoCodec: 'vp09.00.31.08', fit: false },
      { ...level(720, 2_500_000), videoCodec: 'avc1.4d401f' },
    ];
    expect(qualities(t, levels)).toEqual([
      { level: 1, label: '1080p' },
      { level: 4, label: '720p' },
    ]);
  });

  it('высоту, которую устройство не декодирует плавно, не предлагаем', () => {
    const levels: Level[] = [
      { ...level(2160, 18_000_000), videoCodec: 'vp09.00.51.08', fit: false },
      { ...level(1080, 4_000_000), videoCodec: 'vp09.00.40.08', fit: true },
      { ...level(720, 2_000_000), videoCodec: 'vp09.00.31.08' },
    ];
    expect(qualities(t, levels).map((q) => q.label)).toEqual(['1080p', '720p']);
  });

  it('помечено всё — меню всё равно есть, а не пустое', () => {
    expect(qualities(t, [{ ...level(480, 900_000), fit: false }])).toEqual([{ level: 0, label: '480p' }]);
  });

  it('у неизвестного кодека одной высоты — лучший битрейт, по-прежнему одна строка', () => {
    expect(
      qualities(t, [
        { ...level(1440, 3_000_000), videoCodec: 'av01.0.12M.08' },
        { ...level(1440, 2_000_000), videoCodec: 'av01.0.12M.08' },
        { ...level(1440, 6_000_000), videoCodec: 'avc1.640032' },
      ]),
    ).toEqual([{ level: 2, label: '1440p' }]);
  });

  it('шестьдесят кадров — это отдельное качество, а не то же самое', () => {
    const list = qualities(t, [level(1080, 3_000_000, 30), level(1080, 5_000_000, 60)]);
    expect(list.map((q) => q.label)).toEqual(['1080p60', '1080p']);
  });

  it('поток без высоты называется битрейтом, а не пустотой', () => {
    expect(levelLabel(t, { bitrate: 800_000 })).toBe('800 кбит/с');
    expect(levelLabel(t, {})).toBe('Как есть');
    expect(levelLabel(t, undefined)).toBe('');
  });

  it('один уровень — один выбор', () => {
    expect(qualities(t, [level(720, 1_000_000)])).toEqual([{ level: 0, label: '720p' }]);
  });
});
