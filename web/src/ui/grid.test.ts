import { describe, expect, it } from 'vitest';
import { gridPlan } from './grid';

const wide = { width: 1280, height: 720 };
/** Широкая и низкая сцена — та, на которой выгоднее четыре колонки, а не три. */
const panoramic = { width: 1920, height: 540 };
const narrow = { width: 360, height: 640 };

/** Сколько плиток встало в каждом ряду. */
function rows(count: number, box = wide) {
  const plan = gridPlan(count, box);
  return Array.from(
    { length: plan.rows },
    (_, row) => plan.cells.filter((cell) => cell.row === row + 1).length,
  );
}

describe('раскладка сетки', () => {
  it('ставит одного на всю сцену', () => {
    expect(gridPlan(1, wide)).toEqual({ columns: 1, rows: 1, cells: [{ row: 1, column: 1 }] });
  });

  it('делит людей по рядам ровно, а не по остатку', () => {
    expect(rows(2)).toEqual([2]);
    expect(rows(3)).toEqual([2, 1]);
    expect(rows(4)).toEqual([2, 2]);
    expect(rows(5)).toEqual([3, 2]);
    expect(rows(6)).toEqual([3, 3]);
    expect(rows(7)).toEqual([3, 2, 2]);
    expect(rows(10)).toEqual([4, 3, 3]);
    // На широкой и низкой сцене те же семеро выгоднее встают в два ряда.
    expect(rows(7, panoramic)).toEqual([4, 3]);
  });

  it('центрирует неполный ряд, а не прижимает его к левому краю', () => {
    // Трое: двое сверху, третий — ровно между ними. Половинные колонки: ряд из одной плитки
    // в двухколоночной сетке начинается со второй доли из четырёх.
    const three = gridPlan(3, wide);
    expect(three.columns).toBe(2);
    expect(three.cells).toEqual([
      { row: 1, column: 1 },
      { row: 1, column: 3 },
      { row: 2, column: 2 },
    ]);
    // Четыре колонки, в последнем ряду трое: слева и справа остаётся поровну.
    const seven = gridPlan(7, panoramic);
    expect(seven.columns).toBe(4);
    expect(seven.cells.slice(4)).toEqual([
      { row: 2, column: 2 },
      { row: 2, column: 4 },
      { row: 2, column: 6 },
    ]);
  });

  it('полный ряд занимает всю ширину', () => {
    const six = gridPlan(6, wide);
    expect(six.cells.slice(0, 3)).toEqual([
      { row: 1, column: 1 },
      { row: 1, column: 3 },
      { row: 1, column: 5 },
    ]);
  });

  it('на узком экране складывает людей в колонку, а не в марки', () => {
    // В портрете колонка даёт плитку крупнее, чем сетка два на два: 241 px против 174 px.
    expect(rows(2, narrow)).toEqual([1, 1]);
    expect(rows(4, narrow)).toEqual([1, 1, 1, 1]);
  });

  it('не измеренная сцена всё равно даёт разумную сетку', () => {
    expect(gridPlan(4, { width: 0, height: 0 }).columns).toBe(2);
    expect(gridPlan(9, { width: 0, height: 0 }).columns).toBe(3);
  });
});
