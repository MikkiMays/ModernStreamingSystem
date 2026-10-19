import { describe, expect, it } from 'vitest';
import { adAt, adBreaks, attributes, skipRank, type AdFragment } from './ad-breaks';

/**
 * Список фрагментов в той форме, в какой его отдаёт hls.js: по шесть секунд, теги — у фрагмента, перед
 * которым они стоят (`fragment.tagList`, как его собирает `M3U8Parser` hls.js 1.6).
 */
function list(tags: Record<number, string[][]>, count = 20, pdt: number | null = null): AdFragment[] {
  return Array.from({ length: count }, (_, index) => ({
    start: index * 6,
    duration: 6,
    programDateTime: pdt === null ? null : pdt + index * 6000,
    tagList: [['INF', '6'], ...(tags[index] ?? [])],
  }));
}

describe('реклама, которую помечает поток', () => {
  it('CUE-OUT … CUE-IN: отрезок от тега до тега', () => {
    const fragments = list({ 3: [['EXT-X-CUE-OUT', '30']], 8: [['EXT-X-CUE-IN']] });
    expect(adBreaks(fragments)).toEqual([{ start: 18, end: 48 }]);
  });

  it('CUE-OUT без CUE-IN — по своей длительности; без длительности не угадываем', () => {
    expect(adBreaks(list({ 2: [['EXT-X-CUE-OUT', 'DURATION=24']] }))).toEqual([{ start: 12, end: 36 }]);
    expect(adBreaks(list({ 2: [['EXT-X-CUE-OUT']] }))).toEqual([]);
  });

  it('SCTE35 с CUE-OUT=YES и CUE-IN=YES — так же', () => {
    const fragments = list({
      1: [['EXT-X-SCTE35', 'CUE="/DAl",CUE-OUT=YES']],
      4: [['EXT-X-SCTE35', 'CUE="/DAm",CUE-IN=YES']],
    });
    expect(adBreaks(fragments)).toEqual([{ start: 6, end: 24 }]);
  });

  it('DATERANGE с классом рекламы — по датам и PROGRAM-DATE-TIME фрагмента', () => {
    const pdt = Date.parse('2026-10-19T10:00:00.000Z');
    const fragments = list(
      {
        2: [
          [
            'EXT-X-DATERANGE',
            'ID="ad-1",CLASS="twitch-stitched-ad",START-DATE="2026-10-19T10:00:15.000Z",DURATION=30.0',
          ],
        ],
      },
      20,
      pdt,
    );
    expect(adBreaks(fragments)).toEqual([{ start: 15, end: 45 }]);
  });

  it('DATERANGE с SCTE35-OUT без PROGRAM-DATE-TIME — от своего тега, длина из PLANNED-DURATION или END-DATE', () => {
    expect(
      adBreaks(
        list({
          5: [
            [
              'EXT-X-DATERANGE',
              'ID="s1",START-DATE="2026-10-19T10:00:00Z",PLANNED-DURATION=20,SCTE35-OUT=0xFC',
            ],
          ],
        }),
      ),
    ).toEqual([{ start: 30, end: 50 }]);
    expect(
      adBreaks(
        list({
          1: [
            [
              'EXT-X-DATERANGE',
              'ID="s2",CLASS="ads",START-DATE="2026-10-19T10:00:00Z",END-DATE="2026-10-19T10:00:12Z"',
            ],
          ],
        }),
      ),
    ).toEqual([{ start: 6, end: 18 }]);
  });

  it('не реклама: интерстишел (он не отрезок потока), глава, слишком короткое и слишком длинное', () => {
    expect(
      adBreaks(
        list({
          1: [
            [
              'EXT-X-DATERANGE',
              'ID="i",CLASS="com.apple.hls.interstitial",START-DATE="2026-10-19T10:00:00Z",DURATION=30,X-ASSET-URI="ad.m3u8"',
            ],
          ],
          2: [['EXT-X-DATERANGE', 'ID="c",CLASS="chapter",START-DATE="2026-10-19T10:00:00Z",DURATION=30']],
          3: [
            ['EXT-X-DATERANGE', 'ID="b",CLASS="adbreak-not",START-DATE="2026-10-19T10:00:00Z",DURATION=30'],
          ],
        }),
      ),
    ).toEqual([]);
    expect(adBreaks(list({ 3: [['EXT-X-CUE-OUT', '0.5']] }))).toEqual([]);
    expect(adBreaks(list({ 3: [['EXT-X-CUE-OUT', '900']] }))).toEqual([]);
  });

  it('наложенные пометки одной вставки — один отрезок', () => {
    const fragments = list({
      3: [
        ['EXT-X-CUE-OUT', '30'],
        ['EXT-X-DATERANGE', 'ID="x",CLASS="ad",START-DATE="2026-10-19T10:00:00Z",DURATION=30'],
      ],
      8: [['EXT-X-CUE-IN']],
    });
    expect(adBreaks(fragments)).toEqual([{ start: 18, end: 48 }]);
  });

  it('атрибуты тега: запятые в кавычках — часть значения', () => {
    expect(attributes('ID="a,b",DURATION=30,X-Y="z"')).toEqual({ ID: 'a,b', DURATION: '30', 'X-Y': 'z' });
  });

  it('секунда внутри рекламы — пока до её конца больше полусекунды', () => {
    const breaks = [{ start: 18, end: 48 }];
    expect(adAt(breaks, 17.9)).toBeNull();
    expect(adAt(breaks, 18)).toEqual({ start: 18, end: 48 });
    expect(adAt(breaks, 47.4)).toEqual({ start: 18, end: 48 });
    expect(adAt(breaks, 47.6)).toBeNull();
  });

  it('очередь пропуска: открывший первым, остальные по номеру, боты и ушедшие не в счёт', () => {
    const people = [
      { id: 'c', status: 'CONNECTED' },
      { id: 'a', status: 'CONNECTED' },
      { id: 'opener', status: 'CONNECTED' },
      { id: 'bot', status: 'CONNECTED', service: 'music' },
      { id: 'b', status: 'LEFT' },
    ];
    expect(skipRank('opener', 'opener', people)).toBe(0);
    expect(skipRank('a', 'opener', people)).toBe(1);
    expect(skipRank('c', 'opener', people)).toBe(2);
    // Открывший ушёл — очередь по номеру.
    expect(skipRank('a', 'gone', people)).toBe(0);
  });
});
