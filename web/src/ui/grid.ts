/**
 * Куда какая плитка встаёт в сетке участников.
 *
 * ПОЧЕМУ ЭТО СЧИТАЕТСЯ, А НЕ ЗАПИСАНО В CSS. Раньше число колонок было прибито к числу людей
 * (`data-count`): двое — две колонки, пятеро — три, и так до десяти. Из этого следовало два
 * неудобства сразу. Третий человек вставал под первым, слева, а справа под вторым зияла дыра —
 * хотя место было ровно посередине. И ширина сцены в расчёт не входила вовсе: те же три колонки
 * получались и на мониторе, и в узком окне с открытой панелью, где плитки схлопывались в марки.
 *
 * Здесь число колонок выбирается по тому, при каком раскладе плитка выходит крупнее, — с учётом
 * настоящего размера сцены и пропорций кадра. Дальше люди раскладываются по рядам как можно
 * ровнее (семеро — это 4 + 3, а не 4 + 2 + 1), и **неполный ряд центрируется**.
 *
 * Центрирование стоит на половинных колонках: сетка объявляется вдвое дробнее, каждая плитка
 * занимает две доли, и ряд из трёх в четырёхколоночной сетке начинается со второй доли —
 * поровну слева и справа. Целыми колонками это невыразимо: «половина колонки» в grid не
 * существует, и последний ряд всегда прижимался бы к краю.
 */
export interface GridPlan {
  /** Сколько плиток в самом широком ряду: столько полных колонок и нужно сетке. */
  columns: number;
  rows: number;
  /** Для каждой плитки: номер ряда и начальная **половинная** колонка, обе с единицы. */
  cells: { row: number; column: number }[];
}

export interface GridBox {
  width: number;
  height: number;
}

/** Сколько плиток в каждом ряду: разница между рядами не больше одной плитки. */
function share(count: number, rows: number): number[] {
  const base = Math.floor(count / rows);
  const extra = count % rows;
  return Array.from({ length: rows }, (_, row) => base + (row < extra ? 1 : 0));
}

/**
 * Во сколько колонок ставить. Мерилом взят размер плитки: при каждом числе колонок считается,
 * какой она выйдет, если вписать в ячейку кадр с данными пропорциями, — и побеждает то, при
 * котором плитка крупнее. Равенство разрешается в пользу меньшего числа рядов: при одинаковом
 * размере глазу ближе то, что шире.
 */
function columnsFor(count: number, box: GridBox, gap: number, aspect: number): number {
  // Сцена ещё не измерена — первый кадр рисуется по числу людей, дальше ResizeObserver
  // пересчитает. Квадратный корень даёт ту же сетку, что и подбор на широком экране.
  if (!(box.width > 0) || !(box.height > 0)) return Math.min(count, Math.ceil(Math.sqrt(count)));
  let best = 1;
  let bestSize = -1;
  for (let columns = 1; columns <= count; columns++) {
    const rows = Math.ceil(count / columns);
    const cellWidth = (box.width - gap * (columns - 1)) / columns;
    const cellHeight = (box.height - gap * (rows - 1)) / rows;
    if (cellWidth <= 0 || cellHeight <= 0) continue;
    const size = Math.min(cellWidth, cellHeight * aspect);
    if (size > bestSize + 0.5) {
      best = columns;
      bestSize = size;
    }
  }
  return best;
}

export function gridPlan(count: number, box: GridBox, gap = 12, aspect = 16 / 10): GridPlan {
  if (count <= 1) return { columns: 1, rows: 1, cells: [{ row: 1, column: 1 }] };
  const rows = Math.ceil(count / columnsFor(count, box, gap, aspect));
  const perRow = share(count, rows);
  // Ряды могли выйти уже задуманного: семерых в пять колонок ровно не разложить, и получается
  // 4 + 3. Ширину сетки задаёт самый широкий ряд, иначе справа осталась бы пустая колонка.
  const columns = Math.max(...perRow);
  const cells: GridPlan['cells'] = [];
  perRow.forEach((size, row) => {
    for (let index = 0; index < size; index++)
      cells.push({ row: row + 1, column: columns - size + 1 + index * 2 });
  });
  return { columns, rows, cells };
}
