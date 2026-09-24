import { describe, expect, it } from 'vitest';
import { linkCard, vkLink } from './vk';

describe('ссылка на VK в поиске', () => {
  it('узнаёт страницу ролика на всех доменах площадки', () => {
    for (const text of [
      'https://vk.com/video-22277933_456242578',
      'https://vk.ru/video-22277933_456242578',
      'https://vkvideo.ru/video-22277933_456242578',
      'https://m.vkvideo.ru/video-22277933_456242578?list=ln-abc',
      'vkvideo.ru/video-22277933_456242578',
      '  https://www.vk.com/video-22277933_456242578  ',
      'https://vkvideo.ru/playlist/-22277933_56093284/video-22277933_456242578',
      'https://vk.com/videos-22277933?z=video-22277933_456242578%2Fclub22277933',
      'https://vkvideo.ru/video_ext.php?oid=-22277933&id=456242578&hash=87b046504ccd8bfa',
    ])
      expect(vkLink(text), text).toEqual({ kind: 'video', id: '-22277933_456242578' });
    expect(vkLink('https://vk.com/video1_456239017')).toEqual({ kind: 'video', id: '1_456239017' });
    expect(vkLink('https://vk.com/clip-1_2')).toEqual({ kind: 'video', id: '-1_2' });
    // Страница эфира — тоже ролик: идёт ли он сейчас, скажет поток.
    expect(vkLink('https://vkvideo.ru/live-59526914_456267534')).toEqual({
      kind: 'video',
      id: '-59526914_456267534',
    });
  });

  it('узнаёт канал VK Видео Live — и только сам канал', () => {
    expect(vkLink('https://live.vkvideo.ru/near_you')).toEqual({ kind: 'channel', id: 'near_you' });
    expect(vkLink('live.vkvideo.ru/near_you/')).toEqual({ kind: 'channel', id: 'near_you' });
    expect(vkLink('https://vkplay.live/bayda')).toEqual({ kind: 'channel', id: 'bayda' });
    expect(vkLink('https://live.vkvideo.ru/lebwa/record/33a4e4ce')).toBeNull();
    expect(vkLink('https://live.vkvideo.ru/')).toBeNull();
  });

  it('не принимает за ссылку обычный поиск, чужие сайты и похожее', () => {
    for (const text of [
      'маша и медведь',
      'video-22277933_456242578',
      'https://vk.com/wall-22277933_1',
      'https://vk.com/mashaimedvedtv',
      'https://evilvk.com/video-1_2',
      'https://vk.com.evil.ru/video-1_2',
      'https://youtube.com/watch?v=aqz-KE-bpKQ',
      'javascript:alert(1)',
      'https://vk.com/video-١_٢',
      'https://vkvideo.ru/video_ext.php?oid=abc&id=1',
      '',
    ])
      expect(vkLink(text), text).toBeNull();
  });

  it('карточка по ссылке — только адрес, имя приедет со страницы ролика', () => {
    expect(linkCard({ kind: 'video', id: '-1_2' })).toMatchObject({
      provider: 'vk',
      kind: 'video',
      id: '-1_2',
      live: false,
      channelId: null,
      poster: null,
    });
    expect(linkCard({ kind: 'channel', id: 'near_you' })).toMatchObject({ kind: 'channel', live: true });
  });
});
