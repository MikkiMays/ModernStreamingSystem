import { useSyncExternalStore } from 'react';

/** Граница телефона в раскладке Cord (DESIGN.md → «Сетка и плотность»; `ui/breakpoints.test.ts`). */
export const PHONE_QUERY = '(max-width: 767px)';

/**
 * Совпадает ли медиазапрос — с подпиской на смену (поворот, окно уже/шире). Без `matchMedia`
 * (тесты, старая оболочка) — `false`: раскладка компьютера.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
      const list = window.matchMedia(query);
      list.addEventListener('change', notify);
      return () => list.removeEventListener('change', notify);
    },
    () =>
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia(query).matches
        : false,
    () => false,
  );
}
