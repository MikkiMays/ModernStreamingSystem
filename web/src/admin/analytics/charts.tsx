import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { text } from '../../i18n/admin/ru';
import './charts.css';

/**
 * Графики аналитики пульта (R239, `docs/architecture/admin-console-v2.md` §6).
 *
 * Правила — по скиллу `dataviz`: форма по задаче данных (ряд во времени — линия, разрез — полосы по убыванию,
 * шаги — воронка, удержание — сетка одной шкалой), одна ось, тонкие метки, цвет ряда — из проверенной палитры
 * (`--data-1…5`, порядок слотов постоянен), прошлый период — серый пунктир, текст — цветом текста, а не ряда.
 * У каждого графика есть подсказка под указателем и вид таблицей.
 */
const t = text.analytics.chart;
const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const missing = (value: number | null | undefined): value is null | undefined =>
  value === null || value === undefined;

export const fmt = {
  count: (value: number | null | undefined) => (missing(value) ? '—' : number.format(value)),
  share: (value: number | null | undefined) => (missing(value) ? '—' : `${number.format(value * 100)} %`),
  hours: (value: number | null | undefined) => (missing(value) ? '—' : `${number.format(value)} ч`),
  minutes: (value: number | null | undefined) => (missing(value) ? '—' : `${number.format(value)} мин`),
  ms: (value: number | null | undefined) => (missing(value) ? '—' : `${number.format(value)} мс`),
  seconds: (ms: number | null | undefined) => (missing(ms) ? '—' : `${number.format(ms / 1000)} с`),
  bytes: (value: number | null | undefined) => {
    if (missing(value)) return '—';
    if (value >= 1e12) return `${number.format(value / 1e12)} ТБ`;
    if (value >= 1e9) return `${number.format(value / 1e9)} ГБ`;
    if (value >= 1e6) return `${number.format(value / 1e6)} МБ`;
    return `${number.format(value / 1e3)} КБ`;
  },
  day: (day: string) =>
    new Date(`${day}T00:00:00`)
      .toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
      .replace('.', ''),
  moment: (iso: string) =>
    new Date(iso).toLocaleString('ru-RU', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }),
};

export type Format = (value: number | null | undefined) => string;

/** Ряд плиток величин. */
export function Kpis({ children }: { children: ReactNode }) {
  return <div className="an-kpis">{children}</div>;
}

/** Плитка величины: число, изменение к прошлому периоду и подсказка-определение. */
export function Kpi({
  label,
  value,
  change,
  hint,
  note,
  inverse = false,
  lead = false,
}: {
  label: string;
  value: string;
  /** Изменение долей к прошлому периоду; `null` — сравнить не с чем; не задано — сравнение не показывается. */
  change?: number | null;
  hint?: string;
  note?: ReactNode;
  /** Рост — это плохо (ошибки, время входа). */
  inverse?: boolean;
  /** Главная величина экрана — крупнее остальных. */
  lead?: boolean;
}) {
  const direction = missing(change) || Math.abs(change) < 0.005 ? 'flat' : change > 0 ? 'up' : 'down';
  const good = direction === 'flat' ? undefined : (direction === 'up') !== inverse;
  return (
    <div className="an-kpi" data-lead={lead || undefined} title={hint}>
      <span className="an-kpi__label">{label}</span>
      <strong>{value}</strong>
      {change !== undefined && (
        <span className="an-kpi__change" data-good={good}>
          {change === null
            ? t.noPrevious
            : `${direction === 'up' ? '▲' : direction === 'down' ? '▼' : '•'} ${fmt.share(Math.abs(change))}`}
        </span>
      )}
      {note && <span className="an-kpi__note">{note}</span>}
    </div>
  );
}

export interface Series {
  key: string;
  label: string;
  /** Значение на каждую точку оси; `null` — данных нет. */
  values: (number | null)[];
}

const H = 220;
const PAD = { left: 48, right: 12, top: 12, bottom: 26 };

/** Ширина места под график: рисуем в настоящих пикселях, чтобы текст осей не рос вместе с панелью. */
function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  // До первого замера (и там, где раскладки нет вовсе) — условная ширина: график не бывает пустым.
  const [width, setWidth] = useState(720);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (node.clientWidth > 0) setWidth(Math.max(280, node.clientWidth));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** Отметки оси от нуля до круглого числа не ниже наибольшего значения. */
export function ticks(max: number): number[] {
  if (max <= 0) return [0];
  const raw = max / 3;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? raw;
  const out = [];
  for (let value = 0; value < max + step; value += step) out.push(Number(value.toPrecision(12)));
  return out;
}

/**
 * Ряды по дням: до пяти линий одной оси и, по желанию, прошлый период первого ряда серым пунктиром.
 * Под указателем — линия дня и подсказка со всеми значениями; кнопка переключает на таблицу.
 */
export function TimeSeries({
  days,
  series,
  previous,
  format = fmt.count,
  title,
  label = fmt.day,
  axis = t.day,
}: {
  days: string[];
  series: Series[];
  /** Тот же первый ряд за прошлый период (выравнивается по началу). */
  previous?: (number | null)[];
  format?: Format;
  title: string;
  /** Подпись точки оси: по умолчанию — день. */
  label?: (point: string) => string;
  /** Заголовок оси в таблице. */
  axis?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const id = useId();
  const [plot, W] = useWidth();
  const { marks, x, y } = useMemo(() => {
    const all = [...series.flatMap((s) => s.values), ...(previous ?? [])].filter(
      (v): v is number => v !== null,
    );
    const scaleMarks = ticks(Math.max(...all, 0));
    const scale = scaleMarks.at(-1) || 1;
    const inner = { w: W - PAD.left - PAD.right, h: H - PAD.top - PAD.bottom };
    return {
      marks: scaleMarks,
      x: (i: number) => PAD.left + (days.length > 1 ? (i / (days.length - 1)) * inner.w : inner.w / 2),
      y: (value: number) => PAD.top + inner.h - (value / scale) * inner.h,
    };
  }, [days.length, series, previous, W]);
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
  // Подписей оси — сколько помещается; штатная подпись не ставится вплотную к последней.
  const labelEvery = Math.max(1, Math.ceil(days.length / Math.max(2, Math.floor((W - PAD.left) / 96))));
  const labelled = (i: number) =>
    i === days.length - 1 || (i % labelEvery === 0 && days.length - 1 - i >= labelEvery * 0.7);
  const legend = series.length > 1 || !!previous;
  return (
    <figure className="an-chart">
      <figcaption>
        {legend && (
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
                {t.previous}
              </span>
            )}
          </span>
        )}
        <button
          type="button"
          className="an-switch"
          onClick={() => setAsTable((v) => !v)}
          aria-pressed={asTable}
        >
          {asTable ? t.asChart : t.asTable}
        </button>
      </figcaption>
      {!days.length ? (
        <p className="an-empty">{t.empty}</p>
      ) : asTable ? (
        <div className="an-table-wrap">
          <table className="an-table">
            <thead>
              <tr>
                <th scope="col">{axis}</th>
                {series.map((s) => (
                  <th scope="col" key={s.key} data-numeric>
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {days.map((day, i) => (
                <tr key={day}>
                  <th scope="row">{label(day)}</th>
                  {series.map((s) => (
                    <td key={s.key} data-numeric>
                      {format(s.values[i])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="an-plot" ref={plot}>
          <svg
            width={W}
            height={H}
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-labelledby={id}
            onPointerMove={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              if (!box.width) return;
              const at = ((event.clientX - box.left) / box.width) * W;
              const i = Math.round(((at - PAD.left) / (W - PAD.left - PAD.right)) * (days.length - 1));
              setHover(Math.max(0, Math.min(days.length - 1, i)));
            }}
            onPointerLeave={() => setHover(null)}
          >
            <title id={id}>{title}</title>
            {marks.map((mark) => (
              <g key={mark}>
                <line className="an-grid" x1={PAD.left} x2={W - PAD.right} y1={y(mark)} y2={y(mark)} />
                <text className="an-axis" x={PAD.left - 6} y={y(mark) + 4} textAnchor="end">
                  {format(mark)}
                </text>
              </g>
            ))}
            {days.map((day, i) =>
              labelled(i) ? (
                <text
                  key={day}
                  className="an-axis"
                  x={x(i)}
                  y={H - 6}
                  textAnchor={i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle'}
                >
                  {label(day)}
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
                {series.map((s, i) => {
                  const value = s.values[hover];
                  return missing(value) ? null : (
                    <circle
                      key={s.key}
                      className="an-dot"
                      data-slot={i + 1}
                      cx={x(hover)}
                      cy={y(value)}
                      r={4}
                    />
                  );
                })}
              </g>
            )}
          </svg>
          {hover !== null && (
            <div
              className="an-tip"
              style={{ left: `${(x(hover) / W) * 100}%` }}
              data-side={x(hover) > W * 0.6 ? 'left' : 'right'}
            >
              <strong>{label(days[hover]!)}</strong>
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
                  {t.previous}
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
  /** Вторая строка подписи: доля, сессии, пояснение. */
  note?: ReactNode;
}

/** Разрез: полосы (по убыванию значения, если порядок не задан данными), число — в конце строки, цвет один. */
export function BarList({
  title,
  rows,
  format = fmt.count,
  limit = 8,
  ordered = false,
}: {
  title?: string;
  rows: BarRow[];
  format?: Format;
  limit?: number;
  /** Порядок строк значим (корзины «1–5 минут», «5–15 минут»): не сортировать и не сворачивать. */
  ordered?: boolean;
}) {
  const [all, setAll] = useState(false);
  const sorted = ordered ? rows : [...rows].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  const shown = all || ordered ? sorted : sorted.slice(0, limit);
  const max = Math.max(...sorted.map((row) => row.value ?? 0), 0);
  return (
    <figure className="an-bars">
      {title && <figcaption>{title}</figcaption>}
      {!sorted.length && <p className="an-empty">{t.empty}</p>}
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
      {!ordered && sorted.length > limit && (
        <button type="button" className="an-switch" onClick={() => setAll((v) => !v)}>
          {all ? t.less : t.more(sorted.length - limit)}
        </button>
      )}
    </figure>
  );
}

/** Воронка: шаги сверху вниз, у каждого — число, доля от первого шага и потеря к предыдущему. */
export function Funnel({ steps }: { steps: { key: string; label: string; value: number }[] }) {
  const first = steps[0]?.value ?? 0;
  if (!steps.length) return <p className="an-empty">{t.empty}</p>;
  return (
    <ol className="an-funnel">
      <li className="an-funnel__head" aria-hidden="true">
        <span />
        <span />
        <span>{t.people}</span>
        <span>{t.shareShort}</span>
        <span>{t.lostShort}</span>
      </li>
      {steps.map((step, i) => {
        const before = i ? steps[i - 1]!.value : null;
        const lost = before ? 1 - step.value / before : null;
        return (
          <li key={step.key}>
            <span className="an-funnel__label">{step.label}</span>
            <span className="an-funnel__track">
              <i style={{ width: `${first ? (step.value / first) * 100 : 0}%` }} />
            </span>
            <b>{fmt.count(step.value)}</b>
            <span className="an-funnel__share" title={t.share}>
              {first ? fmt.share(step.value / first) : '—'}
            </span>
            <span className="an-funnel__lost" title={t.lost}>
              {lost === null ? '' : lost > 0 ? `−${fmt.share(lost)}` : '—'}
            </span>
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
    <td
      key={key}
      style={{ '--share': value ?? 0 } as CSSProperties}
      data-empty={missing(value) || undefined}
      title={missing(value) ? t.earlyHint : undefined}
    >
      {missing(value) ? t.early : fmt.share(value)}
    </td>
  );
  return (
    <div className="an-table-wrap">
      <table className="an-cohorts">
        <thead>
          <tr>
            <th scope="col">{t.arrived}</th>
            <th scope="col">{t.people}</th>
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
              <th scope="row">{t.total}</th>
              <td className="an-cohorts__size">{fmt.count(total.size)}</td>
              {columns.map((column) => cell(total.cells[column.key], column.key))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

export interface Column<T> {
  key: string;
  label: string;
  cell: (row: T) => ReactNode;
  /** Число — вправо, ровными цифрами. */
  numeric?: boolean;
}

/** Таблица разреза: первая колонка — имя строки, остальные — величины. */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRow,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  /** Строка нажимается (провал в подробности). */
  onRow?: (row: T) => void;
}) {
  if (!rows.length) return <p className="an-empty">{t.empty}</p>;
  return (
    <div className="an-table-wrap">
      <table className="an-table" data-rows={onRow ? 'links' : undefined}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th scope="col" key={column.key} data-numeric={column.numeric || undefined}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={rowKey(row, index)}
              tabIndex={onRow ? 0 : undefined}
              onClick={onRow ? () => onRow(row) : undefined}
              onKeyDown={
                onRow
                  ? (event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onRow(row);
                      }
                    }
                  : undefined
              }
            >
              {columns.map((column, i) =>
                i === 0 ? (
                  <th scope="row" key={column.key}>
                    {column.cell(row)}
                  </th>
                ) : (
                  <td key={column.key} data-numeric={column.numeric || undefined}>
                    {column.cell(row)}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Панель раздела: заголовок, пояснение одной строкой и содержимое. */
export function Block({
  title,
  hint,
  children,
  wide,
  actions,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  /** На всю ширину сетки раздела. */
  wide?: boolean;
  actions?: ReactNode;
}) {
  return (
    <section className="an-block" data-wide={wide || undefined}>
      <header>
        <div>
          <h3>{title}</h3>
          {hint && <p>{hint}</p>}
        </div>
        {actions}
      </header>
      {children}
    </section>
  );
}
