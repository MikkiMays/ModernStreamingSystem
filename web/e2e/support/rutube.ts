import { fixture, type CinemaOverrides } from './cinema';

/**
 * Rutube на записанных ответах службы: витрина, раздел, сериал с сезонами, поиск, канал,
 * страница ролика и поток.
 *
 * Ответы сняты настоящей службой с настоящего Rutube 24.09.2026 (`fixtures/cinema/rutube-*.json`,
 * собраны `.local/rutube/build-fixtures.mjs`), картинки — одна серая заглушка, поток — свой HLS на
 * двенадцать секунд. Отвечают по тем же правилам, что записи YouTube и Twitch в `cinema.ts`:
 * страница и поток незнакомого ролика — записанные, но с лицом нажатой карточки; листание
 * дальше записанного — пустая лента, как у службы на конце списка.
 */
export interface Card {
  id: string;
  kind: string;
  title: string;
  author: string;
  live: boolean;
  badge?: string;
}
export interface Feed {
  items: Card[];
  channels?: Card[];
  series?: Card[];
  next: string | null;
}

/** Столько живёт подпись у настоящей службы; от «сейчас», иначе плеер пошёл бы её обновлять. */
const SIGNATURE_MS = 5 * 3600 * 1000;
const END = { items: [], channels: [], categories: [], series: [], next: null };

/** Все карточки записанных ответов — по id: страница и поток показывают то, что нажато. */
function face(id: string): Card | undefined {
  for (const name of [
    'rutube-search-empty',
    'rutube-search',
    'rutube-category',
    'rutube-series',
    'rutube-series-season-2',
    'rutube-channel-videos',
  ]) {
    const page = fixture<Feed>(name);
    // У страницы сериала `series` — его шапка, а не полка: карточки берутся только из списков.
    const shelves = [page.series, page.channels].filter((shelf): shelf is Card[] => Array.isArray(shelf));
    const found = [...page.items, ...shelves.flat()].find((card) => card.id === id);
    if (found) return found;
  }
  return undefined;
}

const rutube = (params: URLSearchParams) => params.get('provider') === 'rutube';

/** Rutube отвечает записями; остальные площадки — как всегда, записями `support/cinema.ts`. */
export const RUTUBE: CinemaOverrides = {
  search: ({ params }) => {
    if (!rutube(params)) return undefined;
    if (params.get('cursor')) return END;
    return fixture(params.get('query') ? 'rutube-search' : 'rutube-search-empty');
  },
  categories: ({ params }) => (rutube(params) ? fixture('rutube-categories') : undefined),
  category: ({ params }) => {
    if (!rutube(params)) return undefined;
    const page = fixture<{ category: unknown }>('rutube-category');
    return params.get('cursor') ? { category: page.category, items: [], next: null } : page;
  },
  series: ({ params }) => {
    const season = params.get('season');
    if (season === '2') return fixture('rutube-series-season-2');
    const page = fixture<{ season: string }>('rutube-series');
    // Третий сезон не снимали: служба ответила бы его сериями, здесь — пустой сезон.
    return season && season !== page.season ? { ...page, season, items: [] } : page;
  },
  channel: ({ params }) =>
    rutube(params)
      ? fixture(params.get('tab') === 'about' ? 'rutube-channel-about' : 'rutube-channel-videos')
      : undefined,
  details: ({ params }) => {
    if (!rutube(params)) return undefined;
    const id = params.get('id') ?? '';
    const recorded = fixture(params.get('kind') === 'channel' ? 'rutube-details-live' : 'rutube-details');
    const card = face(id);
    return { ...recorded, id, ...(card ? { title: card.title, author: card.author, live: card.live } : {}) };
  },
  resolve: ({ body }) => {
    if (body?.provider !== 'rutube') return undefined;
    const contentId = String(body.contentId ?? '');
    const live = body.kind === 'channel';
    const recorded = fixture<Card>('rutube-resolve');
    const card = face(contentId);
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
