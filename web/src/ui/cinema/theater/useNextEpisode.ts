import { useEffect, useState } from 'react';
import type { Watch } from '../../../api/types';
import type { CinemaApi, CinemaItem } from '../../../core/cinema';

/** За сколько до конца серии плеер начинает предлагать следующую, миллисекунды. */
export const NEXT_LEAD_MS = 30_000;

/** Пора ли предлагать следующую серию: досмотрели или до конца меньше {@link NEXT_LEAD_MS}. */
export function nextDue(context: { live: boolean; over: boolean; positionMs: number; durationMs: number }) {
  if (context.live) return false;
  if (context.over) return true;
  return context.durationMs > 0 && context.durationMs - context.positionMs <= NEXT_LEAD_MS;
}

/**
 * Следующая серия того, что смотрит комната (T17), — со страницы серии у службы (`details.next`).
 *
 * Спрашивается один раз на серию и только когда пора (`due`): страница серии у «По ссылке» — запись
 * в сторе службы, но у площадок каталога это запрос к площадке, и дёргать его на каждом ролике незачем.
 * Площадка не знает следующей серии или ответила отказом — `null`, и кнопки просто нет.
 */
export function useNextEpisode({ api, watch, due }: { api: CinemaApi; watch: Watch; due: boolean }) {
  const [found, setFound] = useState<{ key: string; next: CinemaItem | null } | null>(null);
  const key = `${watch.provider}:${watch.kind}:${watch.contentId}`;
  const asked = found?.key === key;
  useEffect(() => {
    if (!due || asked || watch.kind !== 'video') return;
    const controller = new AbortController();
    api
      .details(watch.provider, watch.contentId, 'video', controller.signal)
      .then((details) => setFound({ key, next: details.next ?? null }))
      .catch(() => {
        if (!controller.signal.aborted) setFound({ key, next: null });
      });
    return () => controller.abort();
  }, [api, due, asked, key, watch.provider, watch.contentId, watch.kind]);
  return asked ? (found?.next ?? null) : null;
}
