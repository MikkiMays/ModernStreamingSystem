import { fixture, type CinemaOverrides } from './cinema';

/**
 * ivi на записанных ответах в форме службы: три вкладки постерами 2:3, сериал с сезоном, поиск,
 * страница ролика и поток.
 *
 * Формы ответов — те же, что строит `cord_services/cinema/providers/ivi.py` (`wire.card`,
 * `wire.series_head`, `wire.details`) по настоящим полям площадки (`services/tests/fixtures/ivi/`,
 * сняты 25.09.2026); значения здесь — «Иван Васильевич меняет профессию» и «Стеклянный дом», те же
 * карточки, что видел исследователь. Отвечают по тем же правилам, что записи Rutube: страница и
 * поток незнакомого ролика — записанные, но с лицом нажатой карточки.
 */
export interface Card {
  id: string;
  kind: string;
  title: string;
  author: string;
  live: boolean;
  badge?: string;
  category?: string;
}
export interface Feed {
  items: Card[];
  channels?: Card[];
  series?: Card[];
  next: string | null;
}

const END = { items: [], next: null };

/** Все карточки записанных ответов — по id: страница и поток показывают то, что нажато. */
function face(id: string): Card | undefined {
  for (const name of ['ivi-category-movies', 'ivi-category-shows', 'ivi-search', 'ivi-series']) {
    const page = fixture<Feed>(name);
    const found = page.items.find((entry) => entry.id === id);
    if (found) return found;
  }
  return undefined;
}

const ivi = (params: URLSearchParams) => params.get('provider') === 'ivi';

/** ivi отвечает записями; остальные площадки — как всегда, записями `support/cinema.ts`. */
export const IVI: CinemaOverrides = {
  categories: ({ params }) => (ivi(params) ? fixture('ivi-tabs') : undefined),
  category: ({ params }) => {
    if (!ivi(params)) return undefined;
    if (params.get('cursor'))
      return { category: fixture<Feed & { category: unknown }>('ivi-category-movies').category, ...END };
    return fixture(params.get('id') === '15' ? 'ivi-category-shows' : 'ivi-category-movies');
  },
  search: ({ params }) => {
    if (!ivi(params)) return undefined;
    if (!params.get('query') || params.get('cursor'))
      return { items: [], channels: [], categories: [], next: null };
    return fixture('ivi-search');
  },
  series: ({ params }) => {
    if (!ivi(params)) return undefined;
    const page = fixture<{ season: string }>('ivi-series');
    const season = params.get('season');
    // Второй сезон не снимали: служба ответила бы его сериями, здесь — пустой сезон.
    return season && season !== page.season ? { ...page, season, items: [] } : page;
  },
  details: ({ params }) => {
    if (!ivi(params)) return undefined;
    const id = params.get('id') ?? '';
    const recorded = fixture<Record<string, unknown>>('ivi-details');
    const card = face(id);
    return { ...recorded, id, ...(card ? { title: card.title, author: card.author } : {}) };
  },
  resolve: ({ body }) => {
    if (body?.provider !== 'ivi') return undefined;
    const contentId = String(body.contentId ?? '');
    const recorded = fixture<Record<string, unknown>>('ivi-resolve');
    const card = face(contentId);
    return {
      ...recorded,
      contentId,
      title: card?.title ?? recorded.title,
      duration: 12,
      expiresAt: Date.now() + 5 * 3600 * 1000,
    };
  },
};
