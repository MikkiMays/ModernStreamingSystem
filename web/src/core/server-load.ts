import { useEffect, useState } from 'react';
import type { LoadState } from '../ui/kit/LoadBars';

/** Ступень этого сервера (R143): `GET /api/v1/load`. */
export interface ServerLoad {
  level: number;
  state: LoadState;
  updatedAt: number;
}
/** Ступени серверов каталога: ядро спрашивает соседей само — CSP не пускает браузер к ним. */
export interface CatalogLoad {
  url: string;
  level: number;
  state: LoadState;
  at: number;
}

async function json<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { headers: { Accept: 'application/json' }, signal });
  if (!response.ok) throw new Error(String(response.status));
  return (await response.json()) as T;
}

/**
 * Опрос, пока страница видна и `enabled`: сразу, затем раз в `every` мс. Ошибка — `null`, без
 * сообщения: палочки — подсказка, а не то, о чём кричат. Старое ядро без маршрута (404) — то же.
 */
function usePolled<T>(path: string, enabled: boolean, every: number, map: (raw: unknown) => T): T | null {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let request: AbortController | null = null;
    let disposed = false;
    const ask = async () => {
      if (document.visibilityState === 'hidden' || request) return;
      request = new AbortController();
      const timeout = setTimeout(() => request?.abort(), 4000);
      try {
        const raw = await json<unknown>(path, request.signal);
        if (!disposed) setValue(map(raw));
      } catch {
        if (!disposed) setValue(null);
      } finally {
        clearTimeout(timeout);
        request = null;
      }
    };
    void ask();
    const timer = setInterval(() => void ask(), every);
    const visible = () => void ask();
    document.addEventListener('visibilitychange', visible);
    return () => {
      disposed = true;
      clearInterval(timer);
      request?.abort();
      document.removeEventListener('visibilitychange', visible);
    };
    // `map` — чистое преобразование, пересоздавать опрос ради него незачем.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, enabled, every]);
  return value;
}

/** Ступень этого сервера; раз в 15 с — она и так меняется не чаще замера раз в 5 с. */
export function useServerLoad(enabled = true): ServerLoad | null {
  return usePolled('/api/v1/load', enabled, 15_000, (raw) => raw as ServerLoad);
}

/** Ступени по `origin` сервера, пока открыто меню серверов. */
export function useCatalogLoad(enabled: boolean): Map<string, CatalogLoad> | null {
  return usePolled(
    '/api/v1/catalog/load',
    enabled,
    30_000,
    (raw) => new Map((raw as CatalogLoad[]).map((entry) => [new URL(entry.url).origin, entry])),
  );
}
