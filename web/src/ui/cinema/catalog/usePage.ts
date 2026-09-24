import { useEffect, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type {
  CinemaApi,
  CinemaCategoryPage,
  CinemaChannel,
  CinemaChannelPage,
  CinemaPage,
  CinemaPlaylistPage,
  ProviderId,
} from '../../../core/cinema';
import type { View } from './useStack';

/**
 * Любая страница каталога — это лента с продолжением, и отличаются они только шапкой.
 *
 * Поэтому запрос на них один: три отдельных превратились бы в три почти одинаковых хука с
 * одинаковой подгрузкой, одинаковой обработкой ошибки и тремя местами, где её можно забыть.
 */
type Opened = CinemaPage &
  Partial<Pick<CinemaChannelPage, 'channel'>> &
  Partial<Pick<CinemaPlaylistPage, 'playlist'>> &
  Partial<Pick<CinemaCategoryPage, 'category'>>;

/** Лента с продолжением, как её отдаёт `useInfiniteQuery`: ровно то, что рисует страница. */
export interface Feed {
  isError: boolean;
  error: unknown;
  isFetching: boolean;
  isFetchingNextPage: boolean;
  hasNextPage: boolean;
  fetchNextPage: () => Promise<unknown>;
}

/**
 * Данные открытой страницы каталога: канала, плейлиста, раздела или ролика.
 *
 * Зовётся сценой на каждом рендере, а не страницей при входе на неё: память о шапке канала
 * должна пережить уход в плейлист и возвращение назад — а страница при уходе исчезает.
 */
export function usePage(api: CinemaApi, provider: ProviderId, view: View) {
  // Что именно открыто, вынуто из разбора один раз: внутри обработчиков нажатий разбор
  // размеченного типа уже не виден, и каждая кнопка иначе просила бы его заново.
  const channelId = view.at === 'channel' ? view.id : '';
  const item = view.at === 'item' ? view.item : null;
  /** Адрес открытой страницы одной строкой: он же и ключ её запроса. */
  const address =
    view.at === 'channel'
      ? `channel:${view.id}:${view.tab}`
      : view.at === 'playlist'
        ? `playlist:${view.id}`
        : view.at === 'category'
          ? `category:${view.id}`
          : '';
  const opened = useInfiniteQuery({
    queryKey: ['cinema', 'page', provider, address],
    queryFn: ({ pageParam, signal }): Promise<Opened> => {
      if (view.at === 'channel') return api.channel(provider, view.id, view.tab, pageParam, signal);
      if (view.at === 'playlist') return api.playlist(provider, view.id, pageParam, signal);
      if (view.at === 'category') return api.category(provider, view.id, pageParam, signal);
      return Promise.resolve({ items: [], next: null });
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.next ?? undefined,
    enabled: !!address,
    // Лента канала начинается со свежего, и «свежее» не должно означать «свежее полчаса
    // назад»: возвращаясь на канал, человек видит сохранённое сразу, а следом — настоящее.
    staleTime: 0,
  });
  const details = useQuery({
    queryKey: ['cinema', 'item', provider, item ? `${item.kind}:${item.id}` : ''],
    queryFn: ({ signal }) =>
      item && (item.kind === 'video' || item.kind === 'channel')
        ? api.details(provider, item.id, item.kind, signal)
        : null,
    enabled: !!item,
    staleTime: 300000,
  });

  const pages = opened.data?.pages ?? [];
  const items = pages.flatMap((page) => page.items);
  const playlist = pages.find((page) => page.playlist)?.playlist ?? null;
  const category = pages.find((page) => page.category)?.category ?? null;
  /**
   * Шапка канала переживает вкладку, на которой её не отдали.
   *
   * Вкладки у канала бывают не все: у кого-то нет трансляций, у кого-то коротких роликов, и
   * площадка отвечает на такую вкладку отказом. Без этой памяти нажатие по пустой вкладке
   * стирало бы с экрана и лицо канала, и его имя — как будто ушли не на вкладку, а в никуда.
   */
  const [known, setKnown] = useState<{ id: string; channel: CinemaChannel } | null>(null);
  const fresh = pages.find((page) => page.channel)?.channel ?? null;
  useEffect(() => {
    if (fresh) setKnown({ id: channelId, channel: fresh });
  }, [fresh, channelId]);
  const person = fresh ?? (known?.id === channelId ? known.channel : null);

  return { opened, details, items, playlist, category, person };
}
