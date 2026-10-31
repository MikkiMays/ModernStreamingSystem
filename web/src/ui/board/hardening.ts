/**
 * Excalidraw без ссылок наружу (R159). Cord — продукт: в том, что видит человек, нет ни одной ссылки на
 * GitHub, Discord, блог или чужую библиотеку (`backlog/CONTEXT.md` → «Жёсткие границы»). Своё главное меню
 * и выключенные встраивания закрывают почти всё; остальное — окно помощи (документация, блог, GitHub),
 * панель библиотеки (libraries.excalidraw.com, публикация через GitHub) и подсказки «текст в диаграмму»
 * (mermaid.js.org) — здесь.
 *
 * Как: CSS прячет входы (`board.css`), а этот сторож убирает внешние ссылки из интерфейса редактора, как
 * только они появляются в документе, — даже если кто-то открыл окно горячей клавишей. Ссылки, которые
 * участники сами поставили на элементы доски, — их содержимое, а не интерфейс: их сторож не трогает.
 */

/** Где живёт интерфейс Excalidraw: сам редактор и его окна (они в портале у `body`). */
const CHROME = '.excalidraw, .excalidraw-modal-container, .Modal';
/** Ссылки участников на элементах — содержимое доски. */
const CONTENT = '.excalidraw-hyperlinkContainer, .excalidraw-hyperlinkContainer-link';

/** Ссылка ведёт за пределы Cord. */
export function external(href: string | null, origin = location.origin): boolean {
  if (!href) return false;
  const value = href.trim();
  if (value.startsWith('#') || value.startsWith('blob:') || value.startsWith('data:')) return false;
  try {
    return new URL(value, origin).origin !== origin;
  } catch {
    return true;
  }
}

/** Внешняя ссылка интерфейса редактора — убрать; ссылки участников на элементах не трогаются. */
function scrubLink(link: HTMLAnchorElement, origin: string): boolean {
  if (!link.closest(CHROME) || link.closest(CONTENT)) return false;
  if (!external(link.getAttribute('href'), origin)) return false;
  link.remove();
  return true;
}

/** Убрать внешние ссылки интерфейса из `root`; возвращает, сколько убрано. */
export function scrub(root: ParentNode, origin = location.origin): number {
  let removed = 0;
  if (root instanceof HTMLAnchorElement && root.hasAttribute('href')) return scrubLink(root, origin) ? 1 : 0;
  for (const link of Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]')))
    if (scrubLink(link, origin)) removed++;
  // Подпись «Generate» над убранными пунктами «текст в диаграмму» — без пунктов она ни к чему.
  for (const label of Array.from(
    root.querySelectorAll<HTMLElement>('.App-toolbar__extra-tools-dropdown div[style]'),
  ))
    if (label.textContent?.trim() === 'Generate') label.remove();
  return removed;
}

/**
 * Сторожить документ, пока доска на сцене: только то, что добавлено или сменило ссылку, — встреча
 * перерисовывается десятки раз в секунду, и обходить ради этого весь документ незачем.
 */
export function guardLinks(document: Document): () => void {
  scrub(document.body);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes' && record.target instanceof HTMLAnchorElement) {
        scrub(record.target);
        continue;
      }
      for (const node of Array.from(record.addedNodes)) if (node instanceof Element) scrub(node);
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['href'],
  });
  return () => observer.disconnect();
}
