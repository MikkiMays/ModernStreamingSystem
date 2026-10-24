import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  listedProviders,
  UNREACHABLE,
  type CinemaApi,
  type CinemaProviderStatus,
  type ProviderId,
} from '../../core/cinema';

/**
 * Площадки этой установки: какие показывать ({@link listedProviders}) и что служба сказала о каждой.
 *
 * Вопрос один на всех, кто рисует площадки: плитки «Кинозала» в панели и вкладки переключателя
 * YouTube/Twitch спрашивают одним ключом, и каталог, открытый из панели, берёт ответ из памяти, а не
 * спрашивает снова. Минута памяти — сколько живёт и ответ службы о доступности площадки.
 *
 * Пока ответа нет, площадки считаются доступными — так плитки вели себя и раньше, когда этой проверки
 * не было вовсе: недоступность видна только тогда, когда служба её подтвердила.
 *
 * Площадку, до которой этот сервер не достаёт (`code: CINEMA_UNREACHABLE`, R112), служба называет
 * отдельно (`unreachable`): каталог отмечает её вкладку и вместо витрины говорит, что с ней, — а
 * «Повторить» спрашивает службу заново (`refetch`).
 */
export function useProviders(api: CinemaApi) {
  const status = useQuery({
    queryKey: ['cinema', 'providers'],
    queryFn: ({ signal }) => api.providers(signal),
    staleTime: 60000,
  });
  const answer = status.data;
  const { refetch } = status;
  return useMemo(() => {
    const entries = new Map<string, CinemaProviderStatus>(
      (Array.isArray(answer?.providers) ? answer.providers : []).map((entry) => [entry.id, entry] as const),
    );
    return {
      listed: listedProviders(answer),
      /** Что служба сказала о площадке; `undefined` — ответа нет или площадки в нём нет. */
      entry: (id: ProviderId) => entries.get(id),
      /** Не достаёт ли этот сервер до площадки — по слову службы, а не по догадке. */
      unreachable: (id: ProviderId) => entries.get(id)?.code === UNREACHABLE,
      /** Спросить службу снова: вернулась ли площадка. */
      refetch: () => void refetch(),
    };
  }, [answer, refetch]);
}
