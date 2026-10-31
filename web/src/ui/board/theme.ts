import { useSyncExternalStore } from 'react';

/**
 * Тема Cord, которую видит человек сейчас: `light` или `dark` (R159). Выбор живёт в `data-theme` корня —
 * `system` значит «как у системы», и тогда ответ даёт `prefers-color-scheme`.
 */
export type Shade = 'light' | 'dark';

function current(): Shade {
  const chosen = document.documentElement.dataset.theme;
  if (chosen === 'light' || chosen === 'dark') return chosen;
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

function subscribe(listener: () => void) {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const query = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  query?.addEventListener?.('change', listener);
  return () => {
    observer.disconnect();
    query?.removeEventListener?.('change', listener);
  };
}

export function useShade(): Shade {
  return useSyncExternalStore(subscribe, current, current);
}
