/**
 * Вид доски: что из сцены видно на холсте и где (R168, R169). Чистая геометрия без Excalidraw — её делят
 * слой курсоров соседей и мини-карта.
 *
 * Excalidraw переводит точку сцены в точку холста так: `(x + scrollX) · zoom` (плюс место холста на
 * странице — оно здесь не нужно: слои лежат прямо поверх холста).
 */

/** То из состояния Excalidraw, что задаёт вид: прокрутка, масштаб и размер холста в пикселях CSS. */
export interface View {
  scrollX: number;
  scrollY: number;
  zoom: number;
  width: number;
  height: number;
}

/** Прямоугольник в координатах сцены: `[x1, y1, x2, y2]`. */
export type Bounds = readonly [number, number, number, number];

/** Точка сцены → точка поверх холста. */
export function toCanvas(x: number, y: number, view: View): { x: number; y: number } {
  return { x: (x + view.scrollX) * view.zoom, y: (y + view.scrollY) * view.zoom };
}

/** Что из сцены видно на холсте. */
export function visibleBounds(view: View): Bounds {
  const x1 = -view.scrollX;
  const y1 = -view.scrollY;
  return [x1, y1, x1 + view.width / view.zoom, y1 + view.height / view.zoom];
}

/** Прокрутка, при которой точка сцены `(x, y)` окажется посреди холста; масштаб тот же. */
export function centerOn(x: number, y: number, view: View): { scrollX: number; scrollY: number } {
  return { scrollX: view.width / 2 / view.zoom - x, scrollY: view.height / 2 / view.zoom - y };
}

/** Объединение прямоугольников; пустой список — `null`. */
export function union(list: readonly (Bounds | null | undefined)[]): Bounds | null {
  let out: [number, number, number, number] | null = null;
  for (const b of list) {
    if (!b || !b.every(Number.isFinite)) continue;
    if (!out) out = [b[0], b[1], b[2], b[3]];
    else {
      out[0] = Math.min(out[0], b[0]);
      out[1] = Math.min(out[1], b[1]);
      out[2] = Math.max(out[2], b[2]);
      out[3] = Math.max(out[3], b[3]);
    }
  }
  return out;
}

/**
 * Как мир сцены ложится в мини-карту `width × height`: целиком, с полем `pad` (доля) и по центру, без
 * искажения пропорций.
 */
export interface MapFit {
  scale: number;
  /** Где на мини-карте точка сцены (0, 0). */
  originX: number;
  originY: number;
}

export function fitMap(world: Bounds, width: number, height: number, pad = 0.06): MapFit {
  const w = Math.max(world[2] - world[0], 1);
  const h = Math.max(world[3] - world[1], 1);
  const scale = Math.min((width * (1 - 2 * pad)) / w, (height * (1 - 2 * pad)) / h);
  const originX = (width - w * scale) / 2 - world[0] * scale;
  const originY = (height - h * scale) / 2 - world[1] * scale;
  return { scale, originX, originY };
}

/** Точка сцены → точка мини-карты. */
export function toMap(x: number, y: number, fit: MapFit): { x: number; y: number } {
  return { x: fit.originX + x * fit.scale, y: fit.originY + y * fit.scale };
}

/** Точка мини-карты → точка сцены. */
export function fromMap(x: number, y: number, fit: MapFit): { x: number; y: number } {
  return { x: (x - fit.originX) / fit.scale, y: (y - fit.originY) / fit.scale };
}
