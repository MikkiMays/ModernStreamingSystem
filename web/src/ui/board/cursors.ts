import type { Cursor } from '../../core/board/sync';
import { toCanvas, type View } from '../../core/board/view';

/** Кто это у доски: имя (для списка соседей Excalidraw) и цвет курсора. */
export interface BoardPerson {
  name: string;
  color: string;
}

const SVG = 'http://www.w3.org/2000/svg';
/** Стрелка курсора — остриём в (2, 2): без обводки и без плашки с именем (R168). */
const ARROW = 'M2 2 L2 17.5 L6.6 13.2 L13.2 12.6 Z';
const TIP = 2;
const SIZE = 18;

/**
 * Курсоры соседей поверх холста (R168): владелец хочет видеть «по сути только курсор» — стрелку цвета
 * участника, без белой обводки, плашки с именем и кольца нажатия, которые рисует сам Excalidraw. Его
 * курсоры выключены (`renderCursor: false`), а эти — слоем над холстом и под интерфейсом редактора
 * (`board.css`). Стрелка, ушедшая за край вида, прячется.
 *
 * Перерисовка — не чаще кадра: курсоры приходят 30 раз в секунду, вид меняется на каждое колесо мыши.
 */
export class CursorLayer {
  private readonly marks = new Map<string, SVGSVGElement>();
  private cursors: ReadonlyMap<string, Cursor> = new Map();
  private view: View | null = null;
  private frame = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly people: () => ReadonlyMap<string, BoardPerson>,
  ) {}

  /** Где соседи — в координатах сцены. */
  set(cursors: ReadonlyMap<string, Cursor>) {
    this.cursors = cursors;
    this.schedule();
  }

  /** Вид холста сменился: прокрутка, масштаб или размер. */
  move(view: View) {
    const old = this.view;
    if (
      old &&
      old.scrollX === view.scrollX &&
      old.scrollY === view.scrollY &&
      old.zoom === view.zoom &&
      old.width === view.width &&
      old.height === view.height
    )
      return;
    this.view = view;
    this.schedule();
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    for (const mark of this.marks.values()) mark.remove();
    this.marks.clear();
  }

  private schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.paint();
    });
  }

  /** Сразу, без ожидания кадра (тесты и смена вида при прокрутке). */
  paint() {
    const view = this.view;
    const people = this.people();
    const seen = new Set<string>();
    for (const [id, cursor] of this.cursors) {
      const person = people.get(id);
      // Сосед, который ещё не водил мышью над доской, присылает с видом точку (0, 0) — это не курсор.
      if (!person || !view || (cursor.x === 0 && cursor.y === 0)) continue;
      const at = toCanvas(cursor.x, cursor.y, view);
      const inside = at.x >= 0 && at.y >= 0 && at.x <= view.width && at.y <= view.height;
      if (!inside) continue;
      seen.add(id);
      const mark = this.marks.get(id) ?? this.create(id);
      const path = mark.firstElementChild as SVGPathElement;
      if (path.getAttribute('fill') !== person.color) {
        path.setAttribute('fill', person.color);
        path.setAttribute('stroke', person.color);
      }
      mark.style.transform = `translate(${at.x - TIP}px, ${at.y - TIP}px)`;
    }
    for (const [id, mark] of this.marks)
      if (!seen.has(id)) {
        mark.remove();
        this.marks.delete(id);
      }
  }

  private create(id: string): SVGSVGElement {
    const mark = document.createElementNS(SVG, 'svg');
    mark.setAttribute('class', 'board-cursor');
    mark.setAttribute('width', String(SIZE));
    mark.setAttribute('height', String(SIZE));
    mark.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE}`);
    mark.setAttribute('aria-hidden', 'true');
    mark.dataset.peer = id;
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', ARROW);
    // Обводка тем же цветом — не контур, а скруглённые углы стрелки.
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('stroke-linejoin', 'round');
    mark.append(path);
    this.root.append(mark);
    this.marks.set(id, mark);
    return mark;
  }
}
