/**
 * Раскладка «вложенные прямоугольники» для карты флота (R240): площадь — вес, форма — ближе к квадрату
 * (алгоритм squarified treemap, Bruls — Huizing — van Wijk). Своя, без зависимостей: модуль в три десятка
 * строк не стоит пакета в сборке.
 *
 * Порядок на выходе — по убыванию веса: самое тяжёлое всегда слева вверху, и глаз находит его сразу.
 */
export interface Weighted<T> {
  weight: number;
  data: T;
}

export interface Placed<T> {
  x: number;
  y: number;
  w: number;
  h: number;
  data: T;
}

/** Худшее отношение сторон в ряду площадей `row`, уложенном вдоль стороны `side`. */
function worst(row: number[], side: number): number {
  const sum = row.reduce((a, b) => a + b, 0);
  const max = Math.max(...row);
  const min = Math.min(...row);
  const s2 = sum * sum;
  const side2 = side * side;
  return Math.max((side2 * max) / s2, s2 / (side2 * min));
}

/**
 * Разложить `items` в прямоугольник `width × height`. Нулевые и отрицательные веса не рисуются.
 *
 * `floor` — наименьшая доля площади на элемент (0…1): мелкое не исчезает с карты, хотя и рисуется крупнее
 * своей честной доли. Доли остальных ужимаются пропорционально.
 */
export function squarify<T>(items: Weighted<T>[], width: number, height: number, floor = 0): Placed<T>[] {
  const live = items.filter((item) => item.weight > 0).sort((a, b) => b.weight - a.weight);
  if (!live.length || width <= 0 || height <= 0) return [];
  const total = live.reduce((sum, item) => sum + item.weight, 0);
  const least = Math.min(floor, 1 / live.length);
  // Поднять мелкие до наименьшей доли и заново привести сумму к единице.
  const lifted = live.map((item) => Math.max(item.weight / total, least));
  const liftedTotal = lifted.reduce((a, b) => a + b, 0);
  const areas = lifted.map((share) => (share / liftedTotal) * width * height);

  const placed: Placed<T>[] = [];
  let x = 0;
  let y = 0;
  let w = width;
  let h = height;
  let start = 0;
  while (start < live.length) {
    const side = Math.min(w, h);
    let end = start + 1;
    // Добавлять в ряд, пока форма плиток не начнёт ухудшаться.
    while (
      end < live.length &&
      worst(areas.slice(start, end + 1), side) <= worst(areas.slice(start, end), side)
    )
      end++;
    const row = areas.slice(start, end);
    const rowArea = row.reduce((a, b) => a + b, 0);
    const thickness = rowArea / side;
    let offset = 0;
    for (let i = 0; i < row.length; i++) {
      const length = row[i]! / thickness;
      placed.push(
        w >= h
          ? { x, y: y + offset, w: thickness, h: length, data: live[start + i]!.data }
          : { x: x + offset, y, w: length, h: thickness, data: live[start + i]!.data },
      );
      offset += length;
    }
    if (w >= h) {
      x += thickness;
      w -= thickness;
    } else {
      y += thickness;
      h -= thickness;
    }
    start = end;
  }
  return placed;
}
