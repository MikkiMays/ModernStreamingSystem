import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ChevronRight } from 'lucide-react';
import { text } from '../../i18n/admin/ru';
import type { FleetMapView, MapContainer, MapMachine } from '../api';
import { plural } from '../parts';
import { squarify, type Placed } from './treemap';
import './fleet-map.css';

/**
 * Карта флота (R240, Р-148): вложенные прямоугольники «машина → контейнер». Все машины и все контейнеры видны
 * сразу, без прокрутки; нажатие проваливается в машину, `Esc` возвращает.
 *
 * Площадь машины — её память. Площадь контейнера — выбранная величина (память, ЦП, диск); мелкое не исчезает
 * (наименьшая доля). Цвет — нагрузка к пределу по одной шкале или состояние. Чужие контейнеры общей машины
 * собраны в одну приглушённую плитку «соседи»; в провале они видны по именам.
 */
const t = text.map;

export type MapMetric = 'mem' | 'cpu' | 'disk';
export type MapTint = 'load' | 'state';
export type MapPath = { machine?: string; container?: string };

type Tile = { kind: 'container'; container: MapContainer };

const HEADER = 58;
const GAP = 6;
const INSET = 8;
/** Уже этой ширины карта — машины столбцом. */
const STACK_BELOW = 560;
/** Наибольшая доля высоты машины под плитку «соседи». */
const NEIGHBOUR_CAP = 0.34;

const bytes = (value: number | null | undefined): string => {
  if (value === null || value === undefined) return '—';
  if (value >= 1e9) return `${(value / 1e9).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} ГБ`;
  return `${Math.round(value / 1e6).toLocaleString('ru-RU')} МБ`;
};
const share = (value: number | null | undefined): string =>
  value === null || value === undefined ? '—' : `${Math.round(value * 100)} %`;
const cores = (value: number | null | undefined): string =>
  value === null || value === undefined
    ? '—'
    : `${value.toLocaleString('ru-RU', { maximumFractionDigits: value < 1 ? 2 : 1 })} ${t.cores}`;

/** Имя плитки: служба compose, а без неё — имя контейнера без приставки проекта и номера копии. */
export function tileName(container: MapContainer): string {
  return (
    container.service ?? container.name.replace(/^(modern-streaming|cord)[-_]/, '').replace(/[-_]\d+$/, '')
  );
}

function metricValue(container: MapContainer, metric: MapMetric): number | null {
  return metric === 'mem' ? container.memBytes : metric === 'cpu' ? container.cpu : container.diskBytes;
}

function metricText(container: MapContainer, metric: MapMetric): string {
  return metric === 'cpu'
    ? cores(container.cpu)
    : bytes(metric === 'mem' ? container.memBytes : container.diskBytes);
}

/** Ступень шкалы нагрузки 1…5; `0` — данных нет. */
export function loadStep(value: number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (value < 0.25) return 1;
  if (value < 0.5) return 2;
  if (value < 0.7) return 3;
  if (value < 0.85) return 4;
  return 5;
}

function containerLoad(container: MapContainer, machine: MapMachine, metric: MapMetric): number | null {
  if (metric === 'cpu') return container.cpuShare;
  if (metric === 'mem') return container.memShare;
  const total = machine.hardware.diskTotalBytes;
  return container.diskBytes !== null && total ? container.diskBytes / total : null;
}

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

const box = (rect: { x: number; y: number; w: number; h: number }, gap = GAP): CSSProperties => ({
  left: rect.x + gap / 2,
  top: rect.y + gap / 2,
  width: Math.max(0, rect.w - gap),
  height: Math.max(0, rect.h - gap),
});

function machineHint(machine: MapMachine): string {
  const lines = [
    `${machine.title} — ${t.roles[machine.role] ?? machine.role}`,
    `${t.load.cpu}: ${share(machine.load.cpu)} · ${t.load.steal}: ${share(machine.load.steal)}`,
    `${t.load.mem}: ${share(machine.load.memUsed)} ${text.pulse.of} ${bytes(machine.hardware.memTotalBytes)}`,
    `${t.load.disk}: ${share(machine.load.diskUsed)}`,
  ];
  if (machine.load.netOutMbps !== null)
    lines.push(`${t.load.net}: ${Math.round(machine.load.netOutMbps)} ${text.pulse.mbps}`);
  return lines.join('\n');
}

function containerHint(container: MapContainer): string {
  const limit = container.memLimitBytes;
  return [
    container.name,
    `${t.metrics.mem}: ${bytes(container.memBytes)} — ${share(container.memShare)} ${limit ? t.ofLimit : t.ofMachine}`,
    `${t.metrics.cpu}: ${cores(container.cpu)} — ${share(container.cpuShare)} ${t.ofMachine}`,
    container.diskBytes !== null ? `${t.metrics.disk}: ${bytes(container.diskBytes)}` : '',
    container.image ? `${t.image}: ${container.image}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function Meter({ label, value }: { label: string; value: number | null }) {
  return (
    <span className="fleet-map__meter" data-step={loadStep(value)}>
      <span>{label}</span>
      <i>
        <b style={{ width: `${Math.round(Math.min(1, value ?? 0) * 100)}%` }} />
      </i>
      <span>{share(value)}</span>
    </span>
  );
}

function MachineTile({
  rect,
  machine,
  metric,
  tint,
  expanded,
  selected,
  onOpen,
  onPick,
}: {
  rect: Placed<MapMachine>;
  machine: MapMachine;
  metric: MapMetric;
  tint: MapTint;
  /** Машина раскрыта на всю карту: соседи — по именам. */
  expanded: boolean;
  selected?: string;
  onOpen: () => void;
  onPick: (container: string) => void;
}) {
  // Внутренняя область машины: минус зазор между машинами, рамка (2) и поле области контейнеров (2 × 3).
  const width = Math.max(0, rect.w - GAP - INSET);
  const height = Math.max(0, rect.h - GAP - HEADER - INSET);
  // Соседи — полосой внизу машины: её высота — их доля в выбранной величине, но не больше `NEIGHBOUR_CAP`,
  // чтобы чужое не вытесняло с карты своё (точные числа — в подписи и подсказке). В провале они — по именам,
  // вместе со своими.
  const { tiles, strip } = useMemo(() => {
    const own: { weight: number; data: Tile }[] = [];
    let ours = 0;
    let other = 0;
    for (const container of machine.containers) {
      const weight = Math.max(metricValue(container, metric) ?? 0, 0);
      if (container.group === 'neighbour' && !expanded) other += weight;
      else {
        ours += weight;
        own.push({ weight: weight || 1e-9, data: { kind: 'container', container } });
      }
    }
    const hasStrip = !expanded && machine.neighbours.count > 0;
    const share = hasStrip ? Math.min(NEIGHBOUR_CAP, Math.max(0.12, other / (ours + other || 1))) : 0;
    // Не ниже двух строк подписи — иначе в маленькой машине полосу не прочитать.
    const stripHeight = hasStrip
      ? Math.min(Math.max(44, Math.round(height * share)), Math.round(height * 0.5))
      : 0;
    return {
      tiles: squarify(own, width, height - stripHeight, expanded ? 0.03 : 0.045),
      strip: hasStrip ? { y: height - stripHeight, h: stripHeight } : null,
    };
  }, [machine, metric, expanded, width, height]);
  const state = machine.online === false ? 'bad' : machine.online ? 'ok' : 'unknown';
  const meetings = machine.meetings.live;
  return (
    <section
      className="fleet-map__machine"
      data-environment={machine.environment}
      data-state={state}
      style={box(rect)}
      aria-label={machine.title}
    >
      <button
        type="button"
        className="fleet-map__machine-head"
        title={machineHint(machine)}
        onClick={onOpen}
        aria-expanded={expanded}
      >
        <span className="fleet-map__machine-name">
          <i data-state={state} aria-hidden />
          <strong>{machine.title}</strong>
          <span>
            {t.roles[machine.role] ?? machine.role}
            {machine.environment === 'dev' ? ` · ${t.dev}` : ''}
            {machine.version ? ` · ${machine.version}` : ''}
          </span>
          {machine.online === false && <em>{t.offline}</em>}
        </span>
        <span className="fleet-map__machine-meta">
          {meetings !== null && (
            <span className="fleet-map__meetings">
              {meetings} {plural(meetings, t.meetingForms)} · {machine.meetings.people ?? 0}{' '}
              {plural(machine.meetings.people ?? 0, t.peopleForms)}
            </span>
          )}
          <Meter label={t.load.cpu} value={machine.load.cpu} />
          <Meter label={t.load.steal} value={machine.load.steal} />
          <Meter label={t.load.mem} value={machine.load.memUsed} />
          <Meter label={t.load.disk} value={machine.load.diskUsed} />
        </span>
      </button>
      <div className="fleet-map__containers" style={{ height }}>
        {!machine.containers.length && <p className="fleet-map__none">{t.noContainers}</p>}
        {strip && (
          <button
            type="button"
            className="fleet-map__tile"
            data-group="neighbour"
            style={box({ x: 0, y: strip.y, w: width, h: strip.h }, 4)}
            title={`${t.neighboursHint}\n${t.metrics.mem}: ${bytes(machine.neighbours.memBytes)} · ${t.metrics.cpu}: ${cores(machine.neighbours.cpu)}`}
            onClick={onOpen}
          >
            <strong>
              {t.neighbours} · {machine.neighbours.count} {plural(machine.neighbours.count, t.containerForms)}
            </strong>
            <span>
              {t.metrics.mem}: {bytes(machine.neighbours.memBytes)} · {t.metrics.cpu}:{' '}
              {cores(machine.neighbours.cpu)}
            </span>
          </button>
        )}
        {tiles.map((tile) => {
          const style = box(tile, 4);
          const roomy = tile.w > 86 && tile.h > 44;
          if (tile.data.kind !== 'container') return null;
          const container = tile.data.container;
          const load = containerLoad(container, machine, metric);
          return (
            <button
              key={container.name}
              type="button"
              className="fleet-map__tile"
              data-group={container.group}
              data-step={tint === 'load' ? loadStep(load) : undefined}
              data-state={tint === 'state' ? (machine.online === false ? 'bad' : 'ok') : undefined}
              data-selected={selected === container.name || undefined}
              data-small={tile.w < 64 || undefined}
              style={style}
              title={containerHint(container)}
              onClick={() => onPick(container.name)}
            >
              <strong>{tileName(container)}</strong>
              {roomy && (
                <span>
                  {metricText(container, metric)}
                  {load !== null && tile.w > 128 ? ` · ${share(load)}` : ''}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

export function FleetMap({
  data,
  metric,
  tint,
  path,
  onPath,
}: {
  data: FleetMapView;
  metric: MapMetric;
  tint: MapTint;
  path: MapPath;
  onPath: (path: MapPath) => void;
}) {
  const [ref, size] = useSize<HTMLDivElement>();
  const opened = data.machines.find((machine) => machine.id === path.machine);
  const shown = opened ? [opened] : data.machines;
  // Узкое окно (телефон): машины — столбцом во всю ширину, у каждой своя высота; страница листается.
  const stacked = size.width > 0 && size.width < STACK_BELOW && !opened;
  const machines = useMemo(() => {
    if (stacked) {
      let y = 0;
      return shown.map((machine) => {
        const h = HEADER + GAP + INSET + (machine.containers.length > 6 ? 230 : 170);
        const rect = { x: 0, y, w: size.width, h, data: machine };
        y += h;
        return rect;
      });
    }
    return squarify(
      shown.map((machine) => ({ weight: machine.hardware.memTotalBytes ?? 4e9, data: machine })),
      // До первого замера (и там, где раскладки нет вовсе) — условная рамка: карта не бывает пустой.
      size.width || 960,
      size.height || 540,
      0.16,
    );
  }, [shown, stacked, size.width, size.height]);
  const stackedHeight = stacked ? machines.reduce((sum, rect) => sum + rect.h, 0) : undefined;
  useEffect(() => {
    if (!path.machine) return;
    const up = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      onPath(path.container ? { machine: path.machine } : {});
    };
    addEventListener('keydown', up);
    return () => removeEventListener('keydown', up);
  }, [path.machine, path.container, onPath]);

  return (
    <div className="fleet-map">
      <nav className="fleet-map__path" aria-label={t.title}>
        <button type="button" onClick={() => onPath({})} disabled={!path.machine}>
          {t.root}
        </button>
        {opened && (
          <>
            <ChevronRight aria-hidden />
            <button type="button" onClick={() => onPath({ machine: opened.id })} disabled={!path.container}>
              {opened.title}
            </button>
          </>
        )}
        {opened && path.container && (
          <>
            <ChevronRight aria-hidden />
            <span>{path.container}</span>
          </>
        )}
        {tint === 'load' && (
          <span className="fleet-map__legend" aria-hidden>
            {t.legendLow}
            {[1, 2, 3, 4, 5].map((step) => (
              <i key={step} data-step={step} />
            ))}
            {t.legendHigh}
          </span>
        )}
      </nav>
      <div
        className="fleet-map__canvas"
        ref={ref}
        style={stackedHeight ? { height: stackedHeight } : undefined}
      >
        {!data.machines.length && <p className="fleet-map__none">{t.empty}</p>}
        {machines.map((rect) => (
          <MachineTile
            key={rect.data.id}
            rect={rect}
            machine={rect.data}
            metric={metric}
            tint={tint}
            expanded={!!opened}
            selected={path.container}
            onOpen={() => onPath(opened ? {} : { machine: rect.data.id })}
            onPick={(container) => onPath({ machine: rect.data.id, container })}
          />
        ))}
      </div>
      {/* Та же карта — таблицей: для чтения с экрана и для тех, кому числа удобнее плиток. */}
      <details className="fleet-map__table">
        <summary>{t.table}</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">{text.app.machine}</th>
              <th scope="col">{t.title}</th>
              <th scope="col">{t.metrics.cpu}</th>
              <th scope="col">{t.metrics.mem}</th>
              <th scope="col">{t.metrics.disk}</th>
            </tr>
          </thead>
          <tbody>
            {data.machines.flatMap((machine) =>
              machine.containers.map((container) => (
                <tr key={`${machine.id}/${container.name}`}>
                  <th scope="row">{machine.title}</th>
                  <td>{container.name}</td>
                  <td>{cores(container.cpu)}</td>
                  <td>{bytes(container.memBytes)}</td>
                  <td>{bytes(container.diskBytes)}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </details>
    </div>
  );
}

export const mapFormat = { bytes, share, cores };
