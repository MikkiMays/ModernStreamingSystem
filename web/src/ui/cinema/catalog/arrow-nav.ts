import type { KeyboardEvent } from 'react';

/**
 * Стрелки в каталоге (T20, «пролистывание»): по плиткам полки и сетки — стрелками, а не Tab по каждой
 * кнопке каждой плитки.
 *
 * В полке (один ряд, листается вбок) ← / → — соседняя плитка, и ряд докручивается до неё сам: фокус
 * прокручивает своего прокручиваемого предка. В сетке (серии, находки) ↑ / ↓ — плитка строкой выше или
 * ниже: колонок столько, сколько плиток стоит на высоте первой. Home / End — первая и последняя. Фокус
 * встаёт на главную кнопку плитки («Подробнее…», `.cinema-open`) — с неё Enter открывает страницу, а
 * Tab ведёт к «Смотреть вместе» той же плитки.
 */

/** Куда перейти: номер плитки или `null` — клавиша не наша или идти некуда. */
export function arrowTarget(context: {
  key: string;
  index: number;
  count: number;
  /** Плиток в строке; у полки — все (она одна строка). */
  columns: number;
}): number | null {
  const { key, index, count } = context;
  const columns = Math.max(1, context.columns);
  if (count <= 0 || index < 0) return null;
  let next: number;
  if (key === 'ArrowRight') next = index + 1;
  else if (key === 'ArrowLeft') next = index - 1;
  else if (key === 'ArrowDown' && columns < count) next = index + columns;
  else if (key === 'ArrowUp' && columns < count) next = index - columns;
  else if (key === 'Home') next = 0;
  else if (key === 'End') next = count - 1;
  else return null;
  if (next < 0 || next >= count || next === index) return null;
  return next;
}

/** Плиток в строке: столько, сколько их стоит на высоте первой. */
export function columnsOf(tiles: readonly HTMLElement[]): number {
  if (!tiles.length) return 1;
  const top = tiles[0]!.offsetTop;
  const same = tiles.findIndex((tile) => tile.offsetTop !== top);
  return same < 0 ? tiles.length : same;
}

/** Обработчик `onKeyDown` полки или сетки: плитки — её прямые дети `article.cinema-tile`. */
export function arrowNav(event: KeyboardEvent<HTMLElement>) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.defaultPrevented) return;
  const container = event.currentTarget;
  const target = event.target as HTMLElement;
  // Поле ввода внутри плитки (его нет, но мало ли) стрелки держит у себя.
  if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
  const tiles = Array.from(container.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement && child.classList.contains('cinema-tile'),
  );
  const index = tiles.findIndex((tile) => tile.contains(target));
  const next = arrowTarget({ key: event.key, index, count: tiles.length, columns: columnsOf(tiles) });
  if (next === null) return;
  // Список селекторов отдал бы первую кнопку по порядку в разметке («Смотреть вместе» стоит раньше),
  // поэтому сначала главная кнопка, и только без неё — любая доступная.
  const tile = tiles[next]!;
  const focus =
    tile.querySelector<HTMLElement>('.cinema-open') ??
    tile.querySelector<HTMLElement>('button:not(:disabled)');
  if (!focus) return;
  event.preventDefault();
  focus.focus();
  focus.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}
