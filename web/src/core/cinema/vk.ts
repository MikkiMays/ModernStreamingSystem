import type { CinemaItem } from './types';

/**
 * Ссылка на VK, вставленная в поиск кинозала: ролик или эфир, который открывается и без каталога.
 *
 * ЗАЧЕМ ЭТО В БРАУЗЕРЕ. Каталог VK отвечает только с анонимным токеном площадки, и когда вход или
 * каталог лежат, сцене нечего показать. Ролик по ссылке от этого не зависит: поток разбирает
 * yt-dlp, которому токен не нужен, — поэтому ссылка узнаётся здесь, сразу при вставке, а не
 * вопросом к службе, которая в этот момент может как раз и молчать.
 *
 * Узнаются адреса роликов на всех доменах площадки (`vk.com`, `vk.ru`, `vkvideo.ru`, с `m.` и
 * `www.`): страница ролика (`/video-1_2`, `/clip-1_2`, `/live-1_2`, и внутри пути плейлиста), ролик
 * поверх страницы (`?z=video-1_2`) и встраиваемый плеер (`video_ext.php?oid=-1&id=2`), — и каналы
 * VK Видео Live (`live.vkvideo.ru/<канал>`, прежние `live.vkplay.ru` и `vkplay.live`).
 */
export interface VkLink {
  kind: 'video' | 'channel';
  id: string;
}

const SITE = /^(?:(?:www|m|new|vksport)\.)?(?:vk\.com|vk\.ru|vkvideo\.ru)$/;
const LIVE = /^(?:live\.vkvideo\.ru|live\.vkplay\.ru|vkplay\.live)$/;
// Запись эфира на странице `live-…` — тоже ролик: идёт ли эфир сейчас, скажет поток, а не адрес.
const VIDEO = /^(?:video|clip|live)(-?[0-9]{1,19}_[0-9]{1,19})$/;
const CHANNEL = /^[A-Za-z0-9_]{1,64}$/;

export function vkLink(text: string): VkLink | null {
  const typed = text.trim();
  if (!typed || /\s/.test(typed)) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  const path = url.pathname.split('/').filter(Boolean);
  if (LIVE.test(host)) {
    const [channel, ...rest] = path;
    return channel && !rest.length && CHANNEL.test(channel) ? { kind: 'channel', id: channel } : null;
  }
  if (!SITE.test(host)) return null;
  const layer = /^(?:video|clip)(-?[0-9]{1,19}_[0-9]{1,19})/.exec(url.searchParams.get('z') ?? '');
  if (layer) return { kind: 'video', id: layer[1]! };
  if (path[0] === 'video_ext.php') {
    const owner = url.searchParams.get('oid') ?? '';
    const number = url.searchParams.get('id') ?? '';
    return /^-?[0-9]{1,19}$/.test(owner) && /^[0-9]{1,19}$/.test(number)
      ? { kind: 'video', id: `${owner}_${number}` }
      : null;
  }
  for (const part of path) {
    const found = VIDEO.exec(part);
    if (found) return { kind: 'video', id: found[1]! };
  }
  return null;
}

/**
 * Карточка по ссылке: известен только адрес. Имя, автор и кадр приезжают со страницы ролика
 * (`details`), а если площадка молчит — остаётся это, и «Смотреть вместе» работает всё равно.
 */
export function linkCard(link: VkLink): CinemaItem {
  const channel = link.kind === 'channel';
  return {
    provider: 'vk',
    kind: link.kind,
    id: link.id,
    title: channel ? `Эфир VK Видео Live: ${link.id}` : 'Видео VK по ссылке',
    author: '',
    channelId: null,
    duration: null,
    live: channel,
    viewers: null,
    views: null,
    poster: null,
  };
}
