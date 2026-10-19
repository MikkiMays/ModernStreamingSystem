/**
 * Ползунок, который нажали пальцем или мышью, не выделяется кольцом (T31).
 *
 * ПОЧЕМУ НЕ ХВАТАЕТ `:focus-visible`. Chromium не рисует кольцо по самому нажатию — но рисует,
 * как только после него случилась любая клавиша: человек передвинул громкость мышью, потом
 * нажал сочетание микрофона, стрелку или вернулся в окно через Alt+Tab, — и вокруг ползунка,
 * которого он уже не касается, вспыхивает рамка. Отсюда жалоба «при нажатии на ползунок он
 * выделяется». Здесь ползунок, который взяли указателем, помечается `data-pointer-focus` и
 * остаётся без кольца, пока фокус не уйдёт с него внутри страницы. Дошли до него Tab-ом —
 * пометки нет, и кольцо на месте: клавиатуре оно нужно.
 *
 * Одно место на всё приложение, а не на каждый ползунок: громкость собеседника, музыка,
 * кинозал, ставки за столом и настройки — разные компоненты, и каждый когда-нибудь забыл бы.
 */
export const POINTER_FOCUS = 'pointerFocus';

function isRange(target: EventTarget | null): target is HTMLInputElement {
  return target instanceof HTMLInputElement && target.type === 'range';
}

export function installPointerFocus(
  root: Document = document,
  /** Окно ещё в фокусе: уход фокуса при Alt+Tab — не уход с ползунка. */
  windowFocused: () => boolean = () => root.hasFocus(),
): () => void {
  const press = (event: Event) => {
    if (isRange(event.target)) event.target.dataset[POINTER_FOCUS] = '';
  };
  const leave = (event: Event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !(POINTER_FOCUS in target.dataset)) return;
    if (!windowFocused()) return;
    delete target.dataset[POINTER_FOCUS];
  };
  root.addEventListener('pointerdown', press, true);
  root.addEventListener('focusout', leave, true);
  return () => {
    root.removeEventListener('pointerdown', press, true);
    root.removeEventListener('focusout', leave, true);
  };
}
