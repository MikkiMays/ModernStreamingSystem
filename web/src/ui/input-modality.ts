/**
 * Модальность ввода (S1, R26): `html[data-input='pointer' | 'keyboard']`.
 *
 * ПОЧЕМУ НЕ ХВАТАЕТ `:focus-visible`. Chromium считает клавиатурным вводом **любую** клавишу без
 * Ctrl/Alt/Meta — одиночный Shift, Esc, букву. Человек открыл окно мышью, нажал Shift (начал
 * сочетание, набрал заглавную) — и кольцо вспыхивает на карточке профиля, крестике, пункте меню
 * или на всём окне, которому Base UI дал `tabindex=-1` («выделяются окна»). Фокус, поставленный
 * скриптом после щелчка, этим и выдаёт себя.
 *
 * Поэтому режим решает не браузер, а намерение: в режим клавиатуры переводят только клавиши
 * перемещения — Tab, стрелки, Home/End, PageUp/PageDown, F6 (Shift с ними разрешён: Shift+Tab —
 * та же навигация); сочетания с Ctrl/Alt/Meta (микрофон, оверлей, Alt+Tab) — нет; любое нажатие
 * указателем возвращает режим указателя. CSS гасит токен `--focus-outline`, пока режим не
 * `keyboard` (`styles/tokens.css`), — и вместе с ним все кольца, нарисованные этим токеном.
 *
 * Кто ходит Tab-ом и стрелками, первым же нажатием включает кольца на каждом элементе управления
 * (WCAG 2.4.7). Одно место на всё приложение — входы `main.tsx` и `telegram/main.tsx`.
 */
export type InputModality = 'pointer' | 'keyboard';

const NAVIGATION = new Set([
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'F6',
]);

/** Клавиша перемещения фокуса, а не сочетание и не ввод. */
export function isNavigationKey(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'metaKey'>) {
  return NAVIGATION.has(event.key) && !event.ctrlKey && !event.altKey && !event.metaKey;
}

export function installInputModality(doc: Document = document): () => void {
  const root = doc.documentElement;
  // Атрибут пишется, только когда режим сменился: запись того же значения всё равно заставляет
  // браузер пересчитывать стили всего документа, а нажатий за минуту — сотни.
  const set = (next: InputModality) => {
    if (root.dataset.input !== next) root.dataset.input = next;
  };
  const press = () => set('pointer');
  const key = (event: KeyboardEvent) => {
    if (isNavigationKey(event)) set('keyboard');
  };
  set('pointer');
  // Фаза перехвата: обработчик, остановивший всплытие (меню, плеер, стол), не прячет нажатие.
  doc.addEventListener('pointerdown', press, true);
  doc.addEventListener('keydown', key, true);
  return () => {
    doc.removeEventListener('pointerdown', press, true);
    doc.removeEventListener('keydown', key, true);
  };
}
