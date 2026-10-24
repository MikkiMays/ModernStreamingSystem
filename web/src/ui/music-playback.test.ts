import { describe, expect, it } from 'vitest';
import type { MusicState, MusicTrack } from '../core/services';
import {
  afterMove,
  afterPrevious,
  afterPromote,
  afterRemove,
  afterSkip,
  classifyQuery,
  dropIndex,
  foresee,
  foresightSpent,
  formatDuration,
  offeredSources,
  playbackPosition,
} from './music-playback';

const song = (id: string): MusicTrack => ({
  id,
  title: id,
  artist: '',
  duration: 100,
  addedBy: 'Кто-то',
  source: 'upload',
  cover: null,
});

const state = (patch: Partial<MusicState> = {}): MusicState => ({
  roomId: 'room',
  enabled: true,
  paused: false,
  position: 0,
  revision: 5,
  status: 'playing',
  error: null,
  participantId: 'bot',
  repeat: false,
  queue: [song('один'), song('два'), song('три')],
  ...patch,
});

describe('часы и очередь музыкальной панели', () => {
  it('показывает минуты и секунды и не пугается мусора', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65.7)).toBe('1:05');
    expect(formatDuration(-3)).toBe('0:00');
  });

  it('предлагает только те источники, которые есть у сервера, и в своём порядке', () => {
    expect(offeredSources(['soundcloud', 'yandex', 'upload', 'какой-то новый'])).toEqual([
      'upload',
      'yandex',
      'soundcloud',
    ]);
    expect(offeredSources(undefined)).toEqual(['upload', 'telegram', 'yandex', 'youtube', 'soundcloud']);
  });

  /** Главное свойство предсказания: оно живёт ровно до первого состояния новее своего. */
  it('показывает нажатие до ответа и уступает первому же свежему состоянию', () => {
    const served = state({ revision: 5, paused: false });
    const foresight = { base: 5, patch: { paused: true } };
    expect(foresee(served, foresight)?.paused).toBe(true);
    expect(foresightSpent(served, foresight)).toBe(false);

    const answered = state({ revision: 6, paused: true });
    expect(foresee(answered, foresight)?.paused).toBe(true);
    expect(foresightSpent(answered, foresight)).toBe(true);
  });

  it('без предсказания и без состояния ничего не выдумывает', () => {
    expect(foresee(undefined, { base: 1, patch: { paused: true } })).toBeUndefined();
    expect(foresee(state(), null)?.paused).toBe(false);
  });

  it('двигает иглу только пока играет и не дальше конца трека', () => {
    const anchor = { position: 10, at: 1000 };
    expect(playbackPosition(anchor, 3000, true, 100)).toBe(12);
    expect(playbackPosition(anchor, 3000, false, 100)).toBe(10);
    expect(playbackPosition(anchor, 999_000, true, 100)).toBe(100);
  });

  it('игла отстаёт от позиции издателя на запас буфера — как и звук (R03, R44)', () => {
    const anchor = { position: 10, at: 1000 };
    // Издатель сообщает время отправки, а слышим мы его на 600 мс позже.
    expect(playbackPosition(anchor, 3000, true, 100, 600)).toBeCloseTo(11.4);
    // Только что начатый трек — с нуля, а не с минус полсекунды.
    expect(playbackPosition({ position: 0, at: 1000 }, 1200, true, 100, 600)).toBe(0);
    // На паузе звука нет и вычитать нечего.
    expect(playbackPosition(anchor, 3000, false, 100, 600)).toBe(10);
  });

  it('«назад»: дольше трёх секунд — с начала, иначе ждём службу', () => {
    expect(afterPrevious(42)).toEqual({ position: 0 });
    expect(afterPrevious(2.5)).toBeUndefined();
  });

  it('при повторе «следующий» отправляет трек в конец, без повтора — убирает', () => {
    expect(afterSkip(state()).queue?.map((t) => t.id)).toEqual(['два', 'три']);
    expect(afterSkip(state({ repeat: true })).queue?.map((t) => t.id)).toEqual(['два', 'три', 'один']);
  });

  it('«следующим» ставит трек сразу за играющим, не трогая играющий', () => {
    expect(afterPromote(state(), song('три')).queue?.map((t) => t.id)).toEqual(['один', 'три', 'два']);
  });

  it('обнуляет позицию, только если убрали именно тот трек, что играет', () => {
    expect(afterRemove(state({ position: 42 }), 'два').position).toBe(42);
    expect(afterRemove(state({ position: 42 }), 'один').position).toBe(0);
  });

  it('переставляет трек на любое место после играющего, как служба', () => {
    const four = state({ queue: [song('один'), song('два'), song('три'), song('четыре')] });
    expect(afterMove(four, 'четыре', 1).queue?.map((t) => t.id)).toEqual(['один', 'четыре', 'два', 'три']);
    expect(afterMove(four, 'два', 99).queue?.map((t) => t.id)).toEqual(['один', 'три', 'четыре', 'два']);
    expect(afterMove(four, 'три', 0).queue?.map((t) => t.id)).toEqual(['один', 'три', 'два', 'четыре']);
    // Играющий не переставляется, пропавший — тоже: предсказывать нечего.
    expect(afterMove(four, 'один', 2)).toEqual({});
    expect(afterMove(four, 'пятый', 1)).toEqual({});
  });

  it('место при перетаскивании — сколько строк выше указателя, но не раньше первого после играющего', () => {
    const middles = [20, 60, 100];
    expect(dropIndex(middles, 0)).toBe(1);
    expect(dropIndex(middles, 59)).toBe(1);
    expect(dropIndex(middles, 61)).toBe(2);
    expect(dropIndex(middles, 400)).toBe(3);
  });
});

describe('одно поле: поиск или ссылка', () => {
  it('пустое и текст', () => {
    expect(classifyQuery('   ')).toEqual({ kind: 'empty' });
    expect(classifyQuery('  daft   punk ')).toEqual({ kind: 'text', text: 'daft punk' });
  });

  it('узнаёт ссылки площадок, которые музыка открывает', () => {
    expect(classifyQuery('https://youtu.be/dQw4w9WgXcQ')).toEqual({
      kind: 'link',
      source: 'youtube',
      url: 'https://youtu.be/dQw4w9WgXcQ',
    });
    expect(classifyQuery(' https://music.youtube.com/watch?v=dQw4w9WgXcQ ')).toMatchObject({
      kind: 'link',
      source: 'youtube',
    });
    expect(classifyQuery('https://m.soundcloud.com/artist/track')).toMatchObject({ source: 'soundcloud' });
    expect(classifyQuery('https://music.yandex.ru/album/1/track/2')).toMatchObject({ source: 'yandex' });
  });

  it('чужая ссылка — не запрос в поиск', () => {
    expect(classifyQuery('https://example.com/song.mp3')).toEqual({ kind: 'foreign' });
    expect(classifyQuery('http://youtube.com.evil.test/watch?v=x')).toEqual({ kind: 'foreign' });
  });
});
