import { useId, useMemo, useState, type ReactNode } from 'react';
import './charts.css';

/**
 * Графики аналитики пульта (R239, `docs/architecture/admin-console-v2.md` §6).
 *
 * Правила — по скиллу `dataviz`: форма по задаче данных (ряд во времени — линия, разрез — полосы по убыванию,
 * шаги — воронка, удержание — сетка одной шкалой), одна ось, тонкие метки, цвет ряда — из проверенной палитры
 * (`--data-1…5`, порядок фиксирован), сравнение с прошлым периодом — серый пунктир, текст — цветом текста, а не
 * ряда. У каждого графика есть подсказка под указателем и вид таблицей.
 */

const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });

export const fmt = {
  count: (value: number | null | undefined) => (value === null || value === undefined ? '—' : number.format(value)),
  share: (value: number | null | undefined) =>
    value === null || value === undefined ? '—' : `${number.format(value * 100)} %`,
  hours: (value: number | null | undefined) =>
    value === null || value === undefined ? '—' : `${number.format(value)} ч`,
  minutes: (value: number | null | undefined) =>
    value === null || value === undefined ? '—' : `${number.format(value)} мин`,
  seconds: (ms: number | null | undefined) =>
    ms === null || ms === undefined ? '—' : `${number.format(ms / 1000)} с`,
  bytes: (value: number | null | undefined) => {
    if (value === null || value === undefined) return '—';
    if (value >= 1e12) return `${number.format(value / 1e12)} ТБ`;
    if (value >= 1e9) return `${number.format(value / 1e9)} ГБ`;
    if (value >= 1e6) return `${number.format(value / 1e6)} МБ`;
    return `${number.format(value / 1e3)} КБ`;
  },
  day: (day: string) =>
    new Date(`${day}T00:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace('.', ''),
};

export type Format = (value: number | null | undefined) => string;

/** Плитка величины: число, изменение к прошлому периоду и подсказка-определение. */
export function Kpi({
  label,
  value,
  change,
  hint,
  note,
  /** Рост — это плохо (ошибки, время входа): стрелка вверх красится как ухудшение. */
  inverse = false,
  lead = false,
}: {
  label: string;
  value: string;
  change?: number | null;
  hint?: string;
  note?: ReactNode;
  inverse?: boolean;
  /** Главная величина экрана — крупнее остальных. */
  lead?: boolean;
}) {
  const direction = change === null || change === undefined || Math.abs(change) < 0.005 ? 'flat' : change > 0 ? 'up' : 'down';
  const good = direction === 'flat' ? undefined : (direction === 'up') !== inverse;
  return (
    <div className="an-kpi" data-lead={lead || undefined} title={hint}>
      <span className="an-kpi__label">{label}</span>
      <strong>{value}</strong>
      {change !== undefined && (
        <span className="an-kpi__change" data-good={good}>
          {change === null ? 'нет прошлого периода' : `${direction === 'up' ? '▲' : direction === 'down' ? '▼' : '•'} ${fmt.share(Math.abs(change))}`}
        </span>
      )}
      {note && <span className="an-kpi__note">{note}</span>}
    </div>
  );
}

export interface Series {
  key: string;
  label: string;
  /** Значение на каждый день оси; `null` — данных нет. */
  values: (number | null)[];
}

const W = 720;
const H = 220;
const PAD = { left: 44, right: 12, top: 12, bottom: 26 };

function ticks(max: number): number[] {
  if (max <= 0) return [0];
  const raw = max / 3;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? raw;
  const out = [];
  for (let value = 0; value <= max + step * 0.001; value += step) out.push(value);
  return out;
}

/**
 * Ряды по дням: до четырёх линий одной оси и, по желанию, прошлый период первого ряда серым пунктиром.
 * Под указателем — линия дня и подсказка со всеми значениями.
 */
export function TimeSeries({
  days,
  series,
  previous,
  format = fmt.count,
  title,
}: {
  days: string[];
  series: Series[];
  /** Тот же первый ряд за прошлый период (выравнивается по началу). */
  previous?: (number | null)[];
  format?: Format;
  title: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const id = useId();
  const { max, x, y } = useMemo(() => {
    const all = [...series.flatMap((s) => s.values), ...(previous ?? [])].filter((v): v is number => v !== null);
    const top = Math.max(...all, 0);
    const scale = ticks(top).at(-1) || 1;
    const inner = { w: W - PAD.left - PAD.right, h: H - PAD.top - PAD.bottom };
    return {
      max: scale,
      x: (i: number) => PAD.left + (days.length > 1 ? (i / (days.length - 1)) * inner.w : inner.w / 2),
      y: (value: number) => PAD.top + inner.h - (value / scale) * inner.h,
    };
  }, [days.length, series, previous]);
  const path = (values: (number | null)[]) => {
    let d = '';
    let pen = false;
    values.forEach((value, i) => {
      if (value === null || i >= days.length) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(value).toFixed(1)} `;
      pen = true;
    });
    return d;
  };
  const labelEvery = Math.max(1, Math.ceil(days.length / 6));
  return (
    <figure className="an-chart">
      <figcaption>
        <span>{title}</span>
        {(series.length > 1 || previous) && (
          <span className="an-legend">
            {series.map((s, i) => (
              <span key={s.key}>
                <i data-slot={i + 1} />
                {s.label}
              </span>
            ))}
            {previous && (
              <span>
                <i data-slot="previous" />
                прошлый период
              </span>
            )}
          </span>
        )}
        <button type="button" onClick={() => setAsTable((v) => !v)} aria-pressed={asTable}>
          {asTable ? 'График' : 'Таблица'}
        </button>
      </figcaption>
      {asTable ? (
        <div className="an-table-wrap">
          <table className="an-table">
            <thead>
              <tr>
                <th scope="col">День</th>
                {series.map((s) => (
                  <th scope="col" key={s.key}>
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {days.map((day, i) => (
                <tr key={day}>
                  <th scope="row">{fmt.day(day)}</th>
                  {series.map((s) => (
                    <td key={s.key}>{format(s.values[i])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="an-plot">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-labelledby={id}
            onPointerMove={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              const at = ((event.clientX - box.left) / box.width) * W;
              const i = Math.round(((at - PAD.left) / (W - PAD.left - PAD.right)) * (days.length - 1));
              setHover(Math.max(0, Math.min(days.length - 1, i)));
            }}
            onPointerLeave={() => setHover(null)}
          >
            <title id={id}>{title}</title>
            {ticks(max).map((tick) => (
              <g key={tick}>
                <line className="an-grid" x1={PAD.left} x2={W - PAD.right} y1={y(tick)} y2={y(tick)} />
                <text className="an-axis" x={PAD.left - 6} y={y(tick) + 4} textAnchor="end">
                  {format(tick)}
                </text>
              </g>
            ))}
            {days.map((day, i) =>
              i % labelEvery === 0 || i === days.length - 1 ? (
                <text
                  key={day}
                  className="an-axis"
                  x={x(i)}
                  y={H - 6}
                  textAnchor={i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle'}
                >
                  {fmt.day(day)}
                </text>
              ) : null,
            )}
            {previous && <path className="an-line" data-slot="previous" d={path(previous)} />}
            {series.map((s, i) => (
              <path key={s.key} className="an-line" data-slot={i + 1} d={path(s.values)} />
            ))}
            {hover !== null && (
              <g>
                <line className="an-cross" x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={H - PAD.bottom} />
                {series.map((s, i) =>
                  s.values[hover] === null || s.values[hover] === undefined ? null : (
                    <circle key={s.key} className="an-dot" data-slot={i + 1} cx={x(hover)} cy={y(s.values[hover]!)} r={4} />
                  ),
                )}
              </g>
            )}
          </svg>
          {hover !== null && (
            <div
              className="an-tip"
              style={{ left: `${(x(hover) / W) * 100}%` }}
              data-side={x(hover) > W * 0.6 ? 'left' : 'right'}
            >
              <strong>{fmt.day(days[hover]!)}</strong>
              {series.map((s, i) => (
                <span key={s.key}>
                  <i data-slot={i + 1} />
                  {s.label}
                  <b>{format(s.values[hover])}</b>
                </span>
              ))}
              {previous && (
                <span>
                  <i data-slot="previous" />
                  прошлый период
                  <b>{format(previous[hover])}</b>
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </figure>
  );
}

export interface BarRow {
  key: string;
  label: ReactNode;
  value: number | null;
  /** Вторая строка подписи: доля, люди, пояснение. */
  note?: ReactNode;
}

/** Разрез: полосы по убыванию значения, число — в конце строки, цвет один (первый слот). */
export function BarList({
  title,
  rows,
  format = fmt.count,
  limit = 8,
  empty = 'Данных пока нет',
}: {
  title?: string;
  rows: BarRow[];
  format?: Format;
  limit?: number;
  empty?: string;
}) {
  const [all, setAll] = useState(false);
  const sorted = [...rows].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  const shown = all ? sorted : sorted.slice(0, limit);
  const max = Math.max(...sorted.map((row) => row.value ?? 0), 0);
  return (
    <figure className="an-bars">
      {title && <figcaption>{title}</figcaption>}
      {!sorted.length && <p className="an-empty">{empty}</p>}
      <ul>
        {shown.map((row) => (
          <li key={row.key}>
            <span className="an-bars__label">
              {row.label}
              {row.note && <small>{row.note}</small>}
            </span>
            <span className="an-bars__track">
              <i style={{ width: `${max ? ((row.value ?? 0) / max) * 100 : 0}%` }} />
            </span>
            <b>{format(row.value)}</b>
          </li>
        ))}
      </ul>
      {sorted.length > limit && (
        <button type="button" className="an-more" onClick={() => setAll((v) => !v)}>
          {all ? 'Свернуть' : `Ещё ${sorted.length - limit}`}
        </button>
      )}
    </figure>
  );
}

/** Воронка: шаги сверху вниз, у каждого — число, доля от первого шага и потеря к предыдущему. */
export function Funnel({ steps }: { steps: { key: string; label: string; value: number; note?: ReactNode }[] }) {
  const first = steps[0]?.value ?? 0;
  return (
    <ol className="an-funnel">
      {steps.map((step, i) => {
        const before = i ? steps[i - 1]!.value : null;
        const lost = before ? 1 - step.value / before : null;
        return (
          <li key={step.key}>
            <span className="an-funnel__label">
              {step.label}
              {step.note && <small>{step.note}</small>}
            </span>
            <span className="an-funnel__track">
              <i style={{ width: `${first ? (step.value / first) * 100 : 0}%` }} />
            </span>
            <b>{fmt.count(step.value)}</b>
            <span className="an-funnel__share">{first ? fmt.share(step.value / first) : '—'}</span>
            <span className="an-funnel__lost">{lost === null ? '' : lost > 0 ? `−${fmt.share(lost)}` : '—'}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** Сетка удержания: строка — когорта, столбец — срок; заливка — одна шкала одного цвета, число — в ячейке. */
export function CohortGrid({
  columns,
  rows,
  total,
}: {
  columns: { key: string; label: string }[];
  rows: { key: string; label: string; size: number; cells: Record<string, number | null> }[];
  total?: { size: number; cells: Record<string, number | null> };
}) {
  const cell = (value: number | null | undefined, key: string) => (
    <td key={key} style={{ '--share': value ?? 0 } as React.CSSProperties} data-empty={value === null || value === undefined || undefined}>
      {value === null || value === undefined ? 'рано' : fmt.share(value)}
    </td>
  );
  return (
    <div className="an-table-wrap">
      <table className="an-cohorts">
        <thead>
          <tr>
            <th scope="col">Пришли</th>
            <th scope="col">Людей</th>
            {columns.map((column) => (
              <th scope="col" key={column.key}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row">{row.label}</th>
              <td className="an-cohorts__size">{fmt.count(row.size)}</td>
              {columns.map((column) => cell(row.cells[column.key], column.key))}
            </tr>
          ))}
        </tbody>
        {total && (
          <tfoot>
            <tr>
              <th scope="row">Всего</th>
              <td className="an-cohorts__size">{fmt.count(total.size)}</td>
              {columns.map((column) => cell(total.cells[column.key], column.key))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

/** Панель раздела: заголовок, пояснение одной строкой и содержимое. */
export function Block({ title, hint, children, wide }: { title: string; hint?: string; children: ReactNode; wide?: boolean }) {
  return (
    <section className="an-block" data-wide={wide || undefined}>
      <header>
        <h3>{title}</h3>
        {hint && <p>{hint}</p>}
      </header>
      {children}
    </section>
  );
}
