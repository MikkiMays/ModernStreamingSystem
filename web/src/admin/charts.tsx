import { useId, useState, type ReactNode } from 'react';

/**
 * Графики пульта (R209, R210): свои SVG на токенах набора — одна величина на график, один цвет
 * (`--accent`), подписи — цветом текста, а не ряда. Наведение показывает значение под указателем;
 * у каждого графика есть табличный вид рядом (экраны), поэтому цвет никогда не единственный носитель.
 */

/** Полоса-индикатор доли 0…1 с порогами: выше `warn` — янтарная, выше `bad` — красная. */
export function Meter({
  label,
  value,
  warn = 0.7,
  bad = 0.9,
  hint,
  suffix,
}: {
  label: ReactNode;
  value: number | null | undefined;
  warn?: number;
  bad?: number;
  hint?: string;
  suffix?: ReactNode;
}) {
  const known = value !== null && value !== undefined && Number.isFinite(value);
  const share = known ? Math.max(0, Math.min(1, value)) : 0;
  const tone = !known ? undefined : value >= bad ? 'bad' : value >= warn ? 'warn' : 'ok';
  return (
    <div className="admin-meter" data-tone={tone} title={hint}>
      <span className="admin-meter__label">{label}</span>
      <span className="admin-meter__track" aria-hidden="true">
        <span className="admin-meter__fill" style={{ width: `${share * 100}%` }} />
      </span>
      <span className="admin-meter__value">
        {known ? `${Math.round(value * 100)} %` : '—'}
        {suffix}
      </span>
    </div>
  );
}

type Point = [number, number | null];

/** Линия за последние минуты: 2 px, точка и значение под указателем, последнее значение справа. */
export function Sparkline({
  points,
  label,
  format,
  max,
}: {
  points: Point[];
  label: string;
  format: (value: number) => string;
  /** Верх шкалы; без него — максимум ряда. */
  max?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const values = points.filter((p): p is [number, number] => p[1] !== null);
  const last = values.at(-1)?.[1];
  const width = 240;
  const height = 48;
  if (values.length < 2)
    return (
      <figure className="admin-spark">
        <figcaption>
          <span>{label}</span>
          <strong>{last === undefined ? '—' : format(last)}</strong>
        </figcaption>
        <div className="admin-spark__empty">—</div>
      </figure>
    );
  const t0 = values[0]![0];
  const t1 = values.at(-1)![0];
  const top = Math.max(max ?? 0, ...values.map((v) => v[1]), 1e-9);
  const x = (t: number) => (t1 === t0 ? 0 : ((t - t0) / (t1 - t0)) * width);
  const y = (v: number) => height - 2 - (v / top) * (height - 4);
  const path = values.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const shown = hover === null ? null : values[hover];
  return (
    <figure className="admin-spark">
      <figcaption>
        <span>{label}</span>
        <strong>
          {shown ? `${format(shown[1])} · ${clock(shown[0])}` : last === undefined ? '—' : format(last)}
        </strong>
      </figcaption>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${label}: ${last === undefined ? '—' : format(last)}`}
        onPointerMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          const t = t0 + ((event.clientX - box.left) / box.width) * (t1 - t0);
          let best = 0;
          values.forEach((v, i) => {
            if (Math.abs(v[0] - t) < Math.abs(values[best]![0] - t)) best = i;
          });
          setHover(best);
        }}
        onPointerLeave={() => setHover(null)}
      >
        <line className="admin-spark__base" x1="0" x2={width} y1={height - 1} y2={height - 1} />
        <path className="admin-spark__line" d={path} vectorEffect="non-scaling-stroke" />
        {shown && (
          <line
            className="admin-spark__cross"
            x1={x(shown[0])}
            x2={x(shown[0])}
            y1="0"
            y2={height}
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
    </figure>
  );
}

function clock(seconds: number): string {
  return new Date(seconds * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

/** Столбики по дням: высота — величина, наведение — день и значение; подписи — первый и последний день. */
export function DayBars({
  days,
  label,
  format,
}: {
  days: { day: string; value: number | null }[];
  label: string;
  format: (value: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const id = useId();
  const top = Math.max(1e-9, ...days.map((d) => d.value ?? 0));
  const width = Math.max(days.length * 12, 240);
  const height = 140;
  const slot = width / Math.max(1, days.length);
  // Тонкие столбики: зазор — треть шага, не меньше 2 единиц.
  const gap = Math.max(Math.min(2, slot / 4), slot / 3);
  const shown = hover === null ? null : days[hover];
  return (
    <figure className="admin-bars" aria-labelledby={id}>
      <figcaption id={id}>
        <span>{label}</span>
        <strong>
          {shown ? `${dayLabel(shown.day)}: ${shown.value === null ? '—' : format(shown.value)}` : ' '}
        </strong>
      </figcaption>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={label}
        onPointerLeave={() => setHover(null)}
      >
        <line className="admin-bars__base" x1="0" x2={width} y1={height - 0.5} y2={height - 0.5} />
        {days.map((d, i) => {
          const h = d.value ? Math.max(1, (d.value / top) * (height - 6)) : 0;
          return (
            <g key={d.day} onPointerEnter={() => setHover(i)}>
              <rect className="admin-bars__hit" x={i * slot} y="0" width={slot} height={height} />
              {h > 0 && (
                <rect
                  className="admin-bars__bar"
                  data-hover={hover === i || undefined}
                  x={i * slot + gap / 2}
                  y={height - h}
                  width={Math.max(0.5, slot - gap)}
                  height={h}
                />
              )}
            </g>
          );
        })}
      </svg>
      <div className="admin-bars__axis" aria-hidden="true">
        <span>{days[0] ? dayLabel(days[0].day) : ''}</span>
        <span>{days.length > 1 ? dayLabel(days.at(-1)!.day) : ''}</span>
      </div>
    </figure>
  );
}

export function dayLabel(day: string): string {
  const date = new Date(`${day}T12:00:00`);
  return Number.isNaN(date.getTime())
    ? day
    : date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

/** Горизонтальные полосы с подписью и числом — воронка, клиенты, виды интеграций. */
export function HBars({
  rows,
  total,
  format = (value) => String(value),
}: {
  rows: { key: string; label: ReactNode; value: number; note?: ReactNode }[];
  /** Знаменатель доли; без него — самая длинная полоса. */
  total?: number;
  format?: (value: number) => string;
}) {
  const top = Math.max(1e-9, total ?? Math.max(0, ...rows.map((r) => r.value)));
  return (
    <ul className="admin-hbars">
      {rows.map((row) => (
        <li key={row.key}>
          <span className="admin-hbars__label">{row.label}</span>
          <span className="admin-hbars__track" aria-hidden="true">
            <span className="admin-hbars__fill" style={{ width: `${Math.min(1, row.value / top) * 100}%` }} />
          </span>
          <span className="admin-hbars__value">
            {format(row.value)}
            {row.note && <span className="admin-hint"> {row.note}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}
