import { describe, expect, it } from 'vitest';
import { t } from '../i18n';
import { classifyQuery, offeredSources } from './music-playback';
import {
  isMusicPlatform,
  lastPlatform,
  offeredPlatforms,
  openPlatform,
  platformTiles,
  routeQuery,
  type MusicPlatform,
  type SearchPlatform,
} from './music-platforms';

/*
  Выбор площадки музыки (T59): что предложить, что открыть, что отметить и куда вести набранное.
*/

describe('какие площадки предложить', () => {
  it('по умолчанию — все, YouTube и SoundCloud тоже; Telegram — не площадка выбора', () => {
    // Сервер не ответил или не ограничил источники — `MUSIC_SOURCES` по умолчанию включает всё.
    expect(offeredPlatforms(offeredSources(undefined))).toEqual([
      'youtube',
      'soundcloud',
      'yandex',
      'upload',
    ]);
    expect(
      offeredPlatforms(offeredSources(['upload', 'telegram', 'yandex', 'youtube', 'soundcloud'])),
    ).toEqual(['youtube', 'soundcloud', 'yandex', 'upload']);
  });

  it('`MUSIC_SOURCES` по-прежнему ограничивает', () => {
    expect(offeredPlatforms(offeredSources(['upload', 'yandex']))).toEqual(['yandex', 'upload']);
    expect(offeredPlatforms(offeredSources(['telegram']))).toEqual([]);
    expect(offeredPlatforms(offeredSources([]))).toEqual([]);
  });

  it('плитки — в том же порядке, со своим именем у загрузки', () => {
    const tiles = platformTiles(t, ['youtube', 'soundcloud', 'yandex', 'upload']);
    expect(tiles.map((tile) => tile.name)).toEqual(['YouTube', 'SoundCloud', 'Яндекс Музыка', 'Свои файлы']);
    expect(tiles.every((tile) => tile.note && tile.color && !tile.disabled)).toBe(true);
  });
});

describe('какую площадку открыть и отметить', () => {
  it('выбранную — пока сервер её предлагает; иначе экран выбора', () => {
    expect(openPlatform(null, ['youtube'])).toBeNull();
    expect(openPlatform('soundcloud', ['youtube', 'soundcloud'])).toBe('soundcloud');
    expect(openPlatform('soundcloud', ['youtube'])).toBeNull();
  });

  it('«Последний выбор» — только знакомая и включённая площадка', () => {
    expect(lastPlatform('soundcloud', ['youtube', 'soundcloud'])).toBe('soundcloud');
    expect(lastPlatform('soundcloud', ['youtube'])).toBeNull();
    expect(lastPlatform('telegram', ['youtube'])).toBeNull();
    expect(lastPlatform('rutube', ['youtube'])).toBeNull();
    expect(lastPlatform(null, ['youtube'])).toBeNull();
    expect(isMusicPlatform('upload')).toBe(true);
    expect(isMusicPlatform('telegram')).toBe(false);
  });
});

describe('куда вести набранное в поле площадки', () => {
  const all = ['youtube', 'soundcloud', 'yandex', 'upload'] as const;
  const route = (text: string, platform: SearchPlatform, offered: readonly MusicPlatform[] = all) =>
    routeQuery(classifyQuery(text), platform, offered);

  it('слова — поиск на этой площадке', () => {
    expect(route('  ночной   город ', 'soundcloud')).toEqual({ kind: 'search', text: 'ночной город' });
    expect(route('   ', 'youtube')).toEqual({ kind: 'empty' });
  });

  it('ссылка своей площадки — сюда', () => {
    expect(route('https://youtu.be/dQw4w9WgXcQ', 'youtube')).toEqual({
      kind: 'link',
      url: 'https://youtu.be/dQw4w9WgXcQ',
    });
    expect(route('https://music.yandex.ru/album/1/track/2', 'yandex')).toEqual({
      kind: 'link',
      url: 'https://music.yandex.ru/album/1/track/2',
    });
  });

  it('ссылка другой включённой площадки — перейти туда, выключенной — отказ', () => {
    expect(route('https://soundcloud.com/a/b', 'youtube')).toEqual({
      kind: 'elsewhere',
      platform: 'soundcloud',
      url: 'https://soundcloud.com/a/b',
    });
    expect(route('https://music.youtube.com/watch?v=x', 'yandex')).toEqual({
      kind: 'elsewhere',
      platform: 'youtube',
      url: 'https://music.youtube.com/watch?v=x',
    });
    expect(route('https://soundcloud.com/a/b', 'youtube', ['youtube', 'upload'])).toEqual({
      kind: 'off',
      platform: 'soundcloud',
    });
  });

  it('чужая ссылка — чужая на любой площадке', () => {
    expect(route('https://example.com/song.mp3', 'youtube')).toEqual({ kind: 'foreign' });
  });
});
