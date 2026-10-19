import { useCallback, useSyncExternalStore } from 'react';

/**
 * Ширина тянущейся панели, которую устройство помнит (T46, П11).
 *
 * Ключ — имя панели (`home-sidebar`, `meeting-panel`); значение лежит в `localStorage` под
 * `cord:panel:<ключ>` и подхватывается всеми вкладками через `storage`. Значение всегда зажато
 * в `[min, max]`: при смене пределов в коде старое число не вылезет за них. Хранилище может
 * быть недоступно (приватное окно, запрет сайта) — тогда ширина живёт только в памяти.
 */
export interface PanelWidthOptions {
  min: number;
  max: number;
  default: number;
}

const PREFIX = 'cord:panel:';
const listeners = new Map<string, Set<() => void>>();
const memory = new Map<string, number>();

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function read(key: string): number | null {
  if (memory.has(key)) return memory.get(key)!;
  try {
    const raw = localStorage.getItem(PREFIX + key);
    const value = raw === null ? NaN : Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function write(key: string, value: number | null) {
  if (value === null) memory.delete(key);
  else memory.set(key, value);
  try {
    if (value === null) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, String(value));
  } catch {
    // Нет хранилища — ширина живёт в памяти до перезагрузки.
  }
  for (const listener of listeners.get(key) ?? []) listener();
}

function subscribe(key: string, listener: () => void) {
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === PREFIX + key) {
      memory.delete(key);
      listener();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    set.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function usePanelWidth(key: string, options: PanelWidthOptions) {
  const { min, max, default: fallback } = options;
  const stored = useSyncExternalStore(
    useCallback((listener: () => void) => subscribe(key, listener), [key]),
    () => read(key),
    () => null,
  );
  const width = clamp(stored ?? fallback, min, max);
  const setWidth = useCallback(
    (next: number | ((current: number) => number)) => {
      const current = clamp(read(key) ?? fallback, min, max);
      write(key, Math.round(clamp(typeof next === 'function' ? next(current) : next, min, max)));
    },
    [key, min, max, fallback],
  );
  const reset = useCallback(() => write(key, null), [key]);
  return { width, setWidth, reset, min, max, default: fallback } as const;
}

/** Для тестов: забыть всё, что помнится в этой вкладке. */
export function forgetPanelWidths() {
  memory.clear();
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith(PREFIX)) localStorage.removeItem(key);
  } catch {
    // нет хранилища — нечего забывать
  }
}
