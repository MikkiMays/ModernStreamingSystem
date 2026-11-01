/**
 * Строки Excalidraw, которых нет в его переводах (R175, хвост R168–R176). Во всех языках Cord, кроме
 * английского, у закреплённого 0.18.1 пусты или отсутствуют подпись окна ссылки, «Ссылка не задана»,
 * «Обернуть в рамку» и название инструмента «Рамка» — и Excalidraw показывает их по-английски. Своих
 * переводов он принимать не умеет, поэтому сторож подменяет в его интерфейсе ровно эти английские
 * строки — в тексте, `placeholder`, `title` и `aria-label`, — и только пока они английские: появится
 * перевод у самого Excalidraw — подменять станет нечего.
 */

/** Где живёт интерфейс Excalidraw: редактор и его окна в портале у `body`. */
const CHROME = '.excalidraw, .excalidraw-modal-container, .Modal';
/** Ссылки участников на элементах — их содержимое, а не интерфейс: не трогать. */
const CONTENT = '.excalidraw-hyperlinkContainer-link, .excalidraw-wysiwyg';
const ATTRIBUTES = ['placeholder', 'title', 'aria-label'] as const;

/** Английская строка Excalidraw → строка на языке человека. */
export type Gaps = ReadonlyMap<string, string>;

/** Строка с подменёнными английскими кусками — или `null`, если менять нечего. Подсказка инструмента
 *  бывает с клавишей («Frame tool — F»), поэтому ищется вхождение, а не равенство. */
function translated(value: string, gaps: Gaps): string | null {
  let next = value;
  for (const [english, own] of gaps) if (next.includes(english)) next = next.replace(english, own);
  return next === value ? null : next;
}

function fixText(node: Text, gaps: Gaps) {
  const fixed = translated(node.data, gaps);
  const parent = node.parentElement;
  if (fixed !== null && parent?.closest(CHROME) && !parent.closest(CONTENT)) node.data = fixed;
}

function fixAttributes(element: Element, gaps: Gaps) {
  if (!element.closest(CHROME) || element.closest(CONTENT)) return;
  for (const name of ATTRIBUTES) {
    const value = element.getAttribute(name);
    const fixed = value && translated(value, gaps);
    if (fixed) element.setAttribute(name, fixed);
  }
}

/** Подменить английские строки во всём `root`. */
export function fillGaps(root: Node, gaps: Gaps) {
  if (!gaps.size) return;
  if (root instanceof Text) return fixText(root, gaps);
  if (!(root instanceof Element)) return;
  fixAttributes(root, gaps);
  for (const element of Array.from(root.querySelectorAll('[placeholder], [title], [aria-label]')))
    fixAttributes(element, gaps);
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) fixText(node as Text, gaps);
}

/**
 * Сторожить документ, пока доска на сцене: только то, что добавлено или сменило текст и подписи.
 * Своя подмена тоже вызывает запись, но вторая проверка уже ничего не находит.
 */
export function guardGaps(document: Document, gaps: Gaps): () => void {
  if (!gaps.size) return () => {};
  fillGaps(document.body, gaps);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'characterData') fillGaps(record.target, gaps);
      else if (record.type === 'attributes') fixAttributes(record.target as Element, gaps);
      else for (const node of Array.from(record.addedNodes)) fillGaps(node, gaps);
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: [...ATTRIBUTES],
  });
  return () => observer.disconnect();
}
