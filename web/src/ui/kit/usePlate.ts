import { useLayoutEffect, type RefObject } from 'react';

/**
 * Плашка выбранного пункта переключателя (R123) — одна на дорожку, едет к выбранному. Положение и
 * ширина — CSS-переменные `--plate-x` / `--plate-w` дорожки, в CSS-пикселях её внутреннего края.
 *
 * Меряется по экрану от левого края первого пункта, а не `offsetLeft`/`offsetWidth`: те округлены до
 * целых CSS-пикселей, и на 125–150 % масштаба плашка съезжала с пункта на физический пиксель — зазор у
 * левого и правого края дорожки выходил разным (замер R108: 1–3 против 3). Смещение и ширина делятся
 * на масштаб предков: окно или поповер, открывающийся с `scale(.97)`, не сдвигает плашку. Пересчёт —
 * при смене выбора, размера дорожки и пунктов (шрифт догрузился, язык, окно).
 *
 * До первого замера дорожка без `data-plate`: плашка не видна и не едет из угла при появлении.
 */
export function usePlate(
  track: RefObject<HTMLElement | null>,
  items: string,
  selected: string,
  key: unknown,
): void {
  useLayoutEffect(() => {
    const element = track.current;
    if (!element) return;
    let frame = 0;
    const place = () => {
      const all = element.querySelectorAll<HTMLElement>(items);
      const item = element.querySelector<HTMLElement>(selected);
      const first = all[0];
      if (!item || !first) {
        element.removeAttribute('data-plate');
        return;
      }
      const own = item.getBoundingClientRect();
      const start = first.getBoundingClientRect();
      // Масштаб предков (окно открывается с `scale(.97)`): ширина на экране против вычисленной. Меньше
      // процента — это не масштаб, а округление вычисленной ширины до 1/64 px: тогда верим экрану, иначе
      // край плашки уходит от края пункта на физический пиксель.
      const computed = parseFloat(getComputedStyle(item).width);
      const ratio = computed > 0 && own.width > 0 ? own.width / computed : 1;
      const scale = Math.abs(ratio - 1) < 0.01 ? 1 : ratio;
      // На сетку раскладки Chromium (1/64 физического пикселя): иначе ошибка float в миллионных
      // перекидывает край, стоящий ровно на половине пикселя, на соседний пиксель.
      const grid = (window.devicePixelRatio || 1) * 64;
      const snap = (value: number) => Math.round(value * grid) / grid;
      element.style.setProperty('--plate-x', `${snap((own.left - start.left) / scale)}px`);
      element.style.setProperty('--plate-w', `${snap(own.width / scale)}px`);
      // Движение — со второго замера: первый ставит плашку на место без езды.
      if (!element.hasAttribute('data-plate')) {
        element.setAttribute('data-plate', 'placed');
        frame = requestAnimationFrame(() => element.setAttribute('data-plate', 'ready'));
      }
    };
    place();
    const observers: { disconnect(): void }[] = [];
    if (typeof ResizeObserver !== 'undefined') {
      const resize = new ResizeObserver(place);
      resize.observe(element);
      element.querySelectorAll(items).forEach((item) => resize.observe(item));
      observers.push(resize);
    }
    if (typeof MutationObserver !== 'undefined') {
      // Выбор у вкладок Base UI меняет атрибуты пунктов, а не нашу разметку.
      const mutation = new MutationObserver(place);
      mutation.observe(element, {
        subtree: true,
        attributes: true,
        attributeFilter: ['aria-selected', 'data-checked'],
      });
      observers.push(mutation);
    }
    return () => {
      cancelAnimationFrame(frame);
      observers.forEach((observer) => observer.disconnect());
    };
  }, [track, items, selected, key]);
}
