/**
 * Открыто ли окно поверх страницы — тогда горячие клавиши встречи (микрофон, пробел плеера, «G»
 * сцены, клавиши стола) молчат, чтобы не сработать за спиной окна.
 *
 * Тост набора — не окно, хотя Base UI размечает его `role="dialog"`. Без этого исключения тост
 * «Ссылка на встречу скопирована» (R142) на пять секунд глушил микрофон по клавише и пробел плеера.
 */
export const MODAL_SELECTOR = '[role="dialog"]:not(.ui-toast), [role="alertdialog"]:not(.ui-toast)';

export function modalOpen(root: ParentNode = document): boolean {
  return !!root.querySelector(MODAL_SELECTOR);
}
