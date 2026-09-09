import { useQuery } from '@tanstack/react-query';
import { favoriteApi, favoriteProfile } from '../core/favorites';

export function useFavorites() {
  return useQuery({
    queryKey: ['favorites', favoriteProfile()],
    queryFn: favoriteApi.list,
    refetchOnWindowFocus: true,
  });
}
