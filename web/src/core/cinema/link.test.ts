import { describe, expect, it } from 'vitest';
import { atOf, knownProvider, linkCard, linkKey, linkOf, linkParts, rememberLink, RECENT } from './link';

describe('ссылка в кинозале со стороны браузера', () => {
  it('в поиске площадки ссылка — только со схемой или с www: остальное — слова для поиска', () => {
    expect(linkOf('https://youtu.be/dQw4w9WgXcQ')).toBe('https://youtu.be/dQw4w9WgXcQ');
    expect(linkOf('  HTTP://vk.com/video-1_2  ')).toBe('HTTP://vk.com/video-1_2');
    expect(linkOf('www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    for (const text of [
      '',
      'маша и медведь',
      'node.js/express',
      'youtu.be/dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ и ещё',
      'javascript:alert(1)',
      'ftp://example.com/video.mp4',
      'https://',
      `https://example.com/${'a'.repeat(2000)}`,
    ])
      expect(linkOf(text), text).toBeNull();
  });

  it('в поле «По ссылке» годится и адрес без схемы — там набирают только ссылки', () => {
    expect(linkOf('youtu.be/dQw4w9WgXcQ', true)).toBe('https://youtu.be/dQw4w9WgXcQ');
    expect(linkOf('rutube.ru', true)).toBe('https://rutube.ru');
    for (const text of ['маша и медведь', 'просто', 'localhost/video', '1.5/10', 'javascript:alert(1)'])
      expect(linkOf(text, true), text).toBeNull();
  });

  it('страница по ответу службы и площадки, которых этот клиент не знает', () => {
    expect(atOf({ provider: 'rutube', kind: 'series', id: '356362', page: 'series' })).toEqual({
      page: 'series',
      kind: 'series',
      id: '356362',
    });
    expect(knownProvider('rutube')).toBe(true);
    expect(knownProvider('link')).toBe(true);
    expect(knownProvider('ivi')).toBe(false);
  });

  it('карточка по ссылке — только номер; имя до приезда страницы говорит, что это и откуда', () => {
    expect(linkCard('vk', { kind: 'video', id: '-1_2' })).toEqual({
      provider: 'vk',
      kind: 'video',
      id: '-1_2',
      title: 'Видео VK по ссылке',
      author: '',
      channelId: null,
      duration: null,
      live: false,
      viewers: null,
      views: null,
      poster: null,
    });
    expect(linkCard('vk', { kind: 'channel', id: 'near_you' })).toMatchObject({
      title: 'Эфир VK Видео Live: near_you',
      live: true,
    });
    expect(linkCard('youtube', { kind: 'video', id: 'dQw4w9WgXcQ' }).title).toBe('Видео YouTube по ссылке');
    expect(linkCard('twitch', { kind: 'channel', id: 'pesh' }).title).toBe('Эфир Twitch: pesh');
    expect(linkCard('twitch', { kind: 'video', id: '2000000001' }).title).toBe('Запись Twitch по ссылке');
    expect(linkCard('rutube', { kind: 'channel', id: '5ab908fccfac5bb43ef2b1e4182256b0' }).title).toBe(
      'Эфир Rutube по ссылке',
    );
  });

  it('недавние: новая первой, та же — один раз, не больше десяти', () => {
    const many = Array.from({ length: RECENT }, (_, index) => `https://example.com/${index}`);
    const recent = rememberLink(many, 'https://youtu.be/new');
    expect(recent).toHaveLength(RECENT);
    expect(recent[0]).toBe('https://youtu.be/new');
    expect(recent.at(-1)).toBe(`https://example.com/${RECENT - 2}`);
    // Та же ссылка другим написанием — хост заглавными, порт по умолчанию, косая черта в конце.
    const again = rememberLink(recent, 'https://EXAMPLE.com:443/3/');
    expect(again[0]).toBe('https://EXAMPLE.com:443/3/');
    expect(again.filter((url) => linkKey(url) === linkKey('https://example.com/3'))).toHaveLength(1);
    expect(again).toHaveLength(RECENT);
    // Разные параметры и якоря — разные ссылки.
    expect(linkKey('https://example.com/watch?v=1')).not.toBe(linkKey('https://example.com/watch?v=2'));
    expect(linkKey('https://example.com/#/a')).not.toBe(linkKey('https://example.com/#/b'));
  });

  it('ссылка для глаз: хост отдельно, остальное отдельно', () => {
    expect(linkParts('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toEqual({
      host: 'youtube.com',
      rest: '/watch?v=dQw4w9WgXcQ',
    });
    expect(linkParts('https://rutube.ru/')).toEqual({ host: 'rutube.ru', rest: '' });
  });
});
