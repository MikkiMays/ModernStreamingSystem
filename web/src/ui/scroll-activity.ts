/**
 * Пометка «область сейчас едет» (R17, S2): `data-scrolling` на прокручиваемом элементе на `linger` мс
 * после последней прокрутки.
 *
 * Длинные колонки (дерево и содержимое настроек, избранное, панель встречи) прячут бегунок, пока
 * курсор не над ними, — как в Discord. Под колесом курсор и так над областью, а прокрутка с
 * клавиатуры (PageDown, стрелки, Tab к далёкому полю) идёт без курсора — и бегунок появляется на
 * время движения по этой пометке. Один слушатель на документ: `scroll` у элемента не всплывает, но
 * фазу перехвата проходит.
 */
export function installScrollActivity(doc: Document = document, linger = 800): () => void {
  const timers = new Map<Element, ReturnType<typeof setTimeout>>();
  const settle = (element: Element) => {
    element.removeAttribute('data-scrolling');
    timers.delete(element);
  };
  const scroll = (event: Event) => {
    const element = event.target instanceof Element ? event.target : doc.documentElement;
    // Атрибут ставится один раз на жест: прокрутка шлёт событие каждый кадр.
    if (!timers.has(element)) element.setAttribute('data-scrolling', '');
    clearTimeout(timers.get(element));
    timers.set(
      element,
      setTimeout(() => settle(element), linger),
    );
  };
  doc.addEventListener('scroll', scroll, { capture: true, passive: true });
  return () => {
    doc.removeEventListener('scroll', scroll, { capture: true });
    for (const [element, timer] of timers) {
      clearTimeout(timer);
      settle(element);
    }
  };
}
