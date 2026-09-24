import { fixture, reply, type CinemaOverrides } from './cinema';

/**
 * VK Видео на записанных ответах службы: разделы, лента раздела с продолжением, поиск с
 * сообществами, сообщество с вкладками «Видео» и «Плейлисты», плейлист, страницы ролика и эфира
 * VK Видео Live и поток.
 *
 * Ответы сняты настоящей службой с настоящего VK Видео 24.09.2026 (`fixtures/cinema/vk-*.json`,
 * собраны `.local/vk/build-fixtures.mjs`), картинки — одна серая заглушка, поток — свой HLS на
 * двенадцать секунд. Отвечают по тем же правилам, что записи Rutube: страница и поток незнакомого
 * ролика — записанные, но с лицом нажатой карточки; листание дальше записанного — пустая лента.
 *
 * `down` — каталог VK лежит (так служба отвечает, когда вход площадки не пустил): разделы, поиск и
 * страницы — 502 её словами, а поток по-прежнему отдаётся — ради ссылки, которая открывается и так.
 */
export interface Card {
  id: string;
  kind: string;
  title: string;
  author: string;
  live: boolean;
  channelId?: string | null;
}
export interface Feed {
  items: Card[];
  channels?: Card[];
  next: string | null;
}

/** Столько живёт подпись у настоящей службы; от «сейчас», иначе плеер пошёл бы её обновлять. */
const SIGNATURE_MS = 5 * 3600 * 1000;
export const DOWN = 'VK Видео не пустил каталог: анонимный вход не принят';

/** Все карточки записанных ответов — по id: страница и поток показывают то, что нажато. */
function face(id: string): Card | undefined {
  for (const name of [
    'vk-category',
    'vk-category-2',
    'vk-category-music',
    'vk-search',
    'vk-channel-videos',
    'vk-playlist',
  ]) {
    const page = fixture<Feed>(name);
    const found = [...page.items, ...(page.channels ?? [])].find((card) => card.id === id);
    if (found) return found;
  }
  return undefined;
}

const vk = (params: URLSearchParams) => params.get('provider') === 'vk';

export function vkAnswers({ down = false }: { down?: boolean } = {}): CinemaOverrides {
  const failing = () => reply(502, { detail: DOWN });
  return {
    categories: ({ params }) => (!vk(params) ? undefined : down ? failing() : fixture('vk-categories')),
    category: ({ params }) => {
      if (!vk(params)) return undefined;
      if (down) return failing();
      const sections = fixture<{ items: { id: string; title: string }[] }>('vk-categories').items;
      const music = sections.find((entry) => entry.title === 'Музыка');
      if (params.get('id') === music?.id) return fixture('vk-category-music');
      const cursor = params.get('cursor');
      if (cursor === '1') return fixture('vk-category-2');
      return cursor ? { ...fixture<object>('vk-category'), items: [], next: null } : fixture('vk-category');
    },
    search: ({ params }) => {
      if (!vk(params)) return undefined;
      if (down) return failing();
      if (params.get('cursor')) return { items: [], channels: [], categories: [], next: null };
      return fixture('vk-search');
    },
    channel: ({ params }) => {
      if (!vk(params)) return undefined;
      if (down) return failing();
      return fixture(params.get('tab') === 'playlists' ? 'vk-channel-playlists' : 'vk-channel-videos');
    },
    playlist: ({ params }) => {
      if (!vk(params)) return undefined;
      if (down) return failing();
      return params.get('cursor')
        ? { ...fixture<object>('vk-playlist'), items: [], next: null }
        : fixture('vk-playlist');
    },
    details: ({ params }) => {
      if (!vk(params)) return undefined;
      if (down) return failing();
      const id = params.get('id') ?? '';
      // Канал VK Видео Live — имя канала, а не `<владелец>_<номер>` ролика.
      if (!/^-?[0-9]+_[0-9]+$/.test(id)) return { ...fixture('vk-details-live'), id };
      const card = face(id);
      return {
        ...fixture('vk-details'),
        id,
        ...(card ? { title: card.title, author: card.author, live: card.live } : {}),
      };
    },
    resolve: ({ body }) => {
      if (body?.provider !== 'vk') return undefined;
      const contentId = String(body.contentId ?? '');
      const live = body.kind === 'channel';
      const recorded = fixture<Card>('vk-resolve');
      // Эфир канала VK Видео Live называется так же, как его страница: записанной и отвечаем.
      const card = /^-?[0-9]+_[0-9]+$/.test(contentId) ? face(contentId) : fixture<Card>('vk-details-live');
      return {
        ...recorded,
        contentId,
        title: card?.title ?? recorded.title,
        author: card?.author ?? recorded.author,
        live,
        duration: live ? null : 12,
        expiresAt: Date.now() + SIGNATURE_MS,
      };
    },
  };
}
