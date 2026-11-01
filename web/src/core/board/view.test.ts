import { describe, expect, it } from 'vitest';
import { centerOn, fitMap, fromMap, toCanvas, toMap, union, visibleBounds, type View } from './view';

/** Геометрия вида доски (R168, R169): курсоры соседей и мини-карта. */
const VIEW: View = { scrollX: -100, scrollY: 50, zoom: 2, width: 800, height: 600 };

describe('вид доски', () => {
  it('точка сцены ложится на холст с прокруткой и масштабом', () => {
    expect(toCanvas(100, -50, VIEW)).toEqual({ x: 0, y: 0 });
    expect(toCanvas(150, 0, VIEW)).toEqual({ x: 100, y: 100 });
  });

  it('видимая часть сцены — от левого верхнего угла на размер холста в масштабе', () => {
    expect(visibleBounds(VIEW)).toEqual([100, -50, 500, 250]);
  });

  it('centerOn ставит точку посреди холста', () => {
    const next = { ...VIEW, ...centerOn(1000, 2000, VIEW) };
    const [x1, y1, x2, y2] = visibleBounds(next);
    expect((x1 + x2) / 2).toBeCloseTo(1000);
    expect((y1 + y2) / 2).toBeCloseTo(2000);
    expect(toCanvas(1000, 2000, next)).toEqual({ x: 400, y: 300 });
  });

  it('объединение пропускает пустое', () => {
    expect(union([])).toBeNull();
    expect(union([null, [0, 0, 10, 10], undefined, [-5, 2, 3, 20]])).toEqual([-5, 0, 10, 20]);
    expect(union([[0, 0, Number.NaN, 1]])).toBeNull();
  });

  it('мир ложится в мини-карту целиком, по центру и без искажений; обратный перевод точен', () => {
    const fit = fitMap([0, 0, 1000, 500], 200, 100, 0);
    expect(fit.scale).toBeCloseTo(0.2);
    expect(toMap(0, 0, fit)).toEqual({ x: 0, y: 0 });
    expect(toMap(1000, 500, fit)).toEqual({ x: 200, y: 100 });
    // Высокий мир — по высоте, по ширине — посередине.
    const tall = fitMap([0, 0, 100, 1000], 200, 100, 0);
    expect(tall.scale).toBeCloseTo(0.1);
    expect(toMap(50, 500, tall)).toEqual({ x: 100, y: 50 });
    const back = fromMap(37, 81, tall);
    const there = toMap(back.x, back.y, tall);
    expect(there.x).toBeCloseTo(37);
    expect(there.y).toBeCloseTo(81);
  });

  it('поле мини-карты — с каждой стороны', () => {
    const fit = fitMap([0, 0, 100, 100], 100, 100, 0.1);
    expect(toMap(0, 0, fit)).toEqual({ x: 10, y: 10 });
    expect(toMap(100, 100, fit)).toEqual({ x: 90, y: 90 });
  });
});
