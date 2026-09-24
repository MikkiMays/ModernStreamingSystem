import type { CSSProperties, KeyboardEvent } from 'react';

/** Вкладка ряда: чем её выбрать (`id`) и как она называется. */
export interface TabSpec {
  id: string;
  name: string;
}

/**
 * Ряд вкладок с одной остановкой Tab на весь ряд: разделы площадки, сезоны сериала.
 *
 * ПОЧЕМУ ОДНА ОСТАНОВКА. У разделов Rutube вкладок сорок три, и когда каждая была своей
 * остановкой, клавиатура добиралась от поля поиска до первой полки за сорок с лишним нажатий
 * Tab. Здесь остановка — только на выбранной вкладке, а по ряду ходят стрелками, Home и End —
 * как по любому ряду вкладок (WAI-ARIA, «roving tabindex»).
 *
 * ВЫБОР — НАЖАТИЕМ, НЕ СТРЕЛКОЙ. Каждая вкладка здесь — запрос к площадке: пробегая стрелками
 * по разделам, человек не должен спрашивать каждый из них. Выбирают Enter или пробел, то есть
 * обычное нажатие кнопки (ручная активация).
 *
 * Вид — классы вызывающего (`className`, `tabClassName`): ряд чипов у разделов, вкладки канала у
 * сезонов. Вкладки каналов YouTube и Twitch остаются прежней разметкой — их вид и DOM закреплены.
 */
export function Tabs({
  label,
  items,
  selected,
  onSelect,
  className,
  tabClassName,
  style,
}: {
  label: string;
  items: readonly TabSpec[];
  /** `id` выбранной вкладки; такой в ряду может и не быть (ещё не приехала). */
  selected: string;
  onSelect: (id: string) => void;
  className: string;
  tabClassName: string;
  style?: CSSProperties;
}) {
  // Выбранной в ряду нет — остановка на первой: иначе клавиатура ряд не нашла бы вовсе.
  const stop = items.some((item) => item.id === selected) ? selected : items[0]?.id;
  return (
    <nav className={className} role="tablist" aria-label={label} style={style} onKeyDown={move}>
      {items.map((item) => (
        <button
          key={item.id}
          role="tab"
          aria-selected={item.id === selected}
          tabIndex={item.id === stop ? 0 : -1}
          className={tabClassName}
          onClick={() => onSelect(item.id)}
        >
          {item.name}
        </button>
      ))}
    </nav>
  );
}

/** Куда ведёт клавиша от вкладки `at` в ряду из `count`; `-1` — клавиша не наша. */
function target(key: string, at: number, count: number): number {
  const last = count - 1;
  if (key === 'ArrowRight') return at === last ? 0 : at + 1;
  if (key === 'ArrowLeft') return at === 0 ? last : at - 1;
  if (key === 'Home') return 0;
  if (key === 'End') return last;
  return -1;
}

/**
 * Стрелки, Home и End ведут фокус по ряду. Фокус сам докручивает ряд, если вкладка за краем, —
 * ряд разделов листается вбок.
 */
function move(event: KeyboardEvent<HTMLElement>) {
  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'));
  const at = tabs.indexOf(event.target as HTMLElement);
  if (at < 0) return;
  const next = target(event.key, at, tabs.length);
  if (next < 0) return;
  event.preventDefault();
  tabs[next]?.focus();
}
