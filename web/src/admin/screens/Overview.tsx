import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  BellRing,
  CircleCheck,
  Inbox,
  OctagonAlert,
  ServerCrash,
  TriangleAlert,
  Unplug,
} from 'lucide-react';
import { Segmented } from '../../ui/kit';
import { text } from '../../i18n/admin/ru';
import {
  fleet,
  type Environment,
  type FleetMapView,
  type FleetState,
  type Job,
  type Live,
  type LiveHistory,
  type LiveMachine,
  type MapHistory,
  type MapMachine,
  type Point,
  type StateProblem,
  type SupportCounts,
} from '../api';
import { environmentOf, useEnvironment } from '../environment';
import type { Console } from '../AdminApp';
import {
  FleetMap,
  mapFormat,
  tileName,
  type MapMetric,
  type MapPath,
  type MapTint,
} from '../fleet-map/FleetMap';
import { Empty, ErrorLine, Skeleton, duration, iso, plural } from '../parts';
import './overview.css';

/**
 * Обзор пульта, вторая версия (R240, Р-148…Р-150; `docs/architecture/admin-console-v2.md` §5).
 *
 * Один экран без прокрутки отвечает на три вопроса: всё ли работает (состояние среды с причиной), кто что
 * потребляет (карта флота «машина → контейнер» с провалом) и что требует владельца (оповещения, обращения,
 * сбои задач). Среды «Продукт» и «Стенд» не складываются: приборы и список считаются по выбранной.
 */
const t = text.pulse;
const m = text.map;

/** Путь провала карты живёт в адресе: `?m=<машина>&c=<контейнер>` — ссылку можно сохранить. */
function readPath(): MapPath {
  const params = new URLSearchParams(location.search);
  const machine = params.get('m') ?? undefined;
  return machine ? { machine, container: params.get('c') ?? undefined } : {};
}

function writePath(path: MapPath): void {
  const params = new URLSearchParams(location.search);
  params.delete('m');
  params.delete('c');
  if (path.machine) params.set('m', path.machine);
  if (path.machine && path.container) params.set('c', path.container);
  const query = params.toString();
  history.replaceState(null, '', location.pathname + (query ? `?${query}` : ''));
}

const sum = (values: (number | null | undefined)[]): number | null => {
  const known = values.filter((value): value is number => typeof value === 'number');
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
};

/** Ряд без осей: только форма за последние полчаса, рядом с числом прибора. */
function Spark({ points }: { points: Point[] }) {
  const values = points.filter((point): point is [number, number] => point[1] !== null);
  if (values.length < 2) return null;
  const max = Math.max(...values.map((point) => point[1]), 1);
  const [first, last] = [values[0]![0], values.at(-1)![0]];
  const line = values
    .map(([time, value], i) => {
      const x = ((time - first) / (last - first || 1)) * 96;
      const y = 26 - (value / max) * 24;
      return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg className="pulse__spark" viewBox="0 0 96 28" preserveAspectRatio="none" aria-hidden>
      <path d={line} />
    </svg>
  );
}

function Instrument({
  label,
  value,
  note,
  hint,
  tone,
  points,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  hint?: string;
  tone?: 'warn' | 'bad';
  points?: Point[];
}) {
  return (
    <div className="pulse__instrument" data-tone={tone} title={hint}>
      <span className="pulse__label">{label}</span>
      <strong>{value}</strong>
      {points ? <Spark points={points} /> : note ? <span className="pulse__note">{note}</span> : null}
    </div>
  );
}

const PROBLEM_ICON: Record<StateProblem['kind'], ReactNode> = {
  core: <ServerCrash />,
  metrics: <Unplug />,
  alert: <BellRing />,
};

type AttentionItem = {
  key: string;
  level: 'bad' | 'warn' | 'note';
  icon: ReactNode;
  title: string;
  meta?: string;
  to?: string;
};

export function attentionOf(
  environment: Environment,
  state: FleetState | undefined,
  counts: SupportCounts | undefined,
  jobs: Job[] | undefined,
  machines: { id: string; role: string; title?: string }[],
): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const [i, problem] of (state?.environments[environment].problems ?? []).entries())
    items.push({
      key: `problem-${i}`,
      level: problem.level,
      icon: PROBLEM_ICON[problem.kind],
      title: problem.summary,
      meta: problem.since ? iso(problem.since) : undefined,
    });
  const mine = new Set(
    machines.filter((machine) => environmentOf(machine.role) === environment).map((machine) => machine.id),
  );
  for (const job of jobs ?? [])
    if (job.status === 'failed' && !job.dryRun && mine.has(job.machine))
      items.push({
        key: `job-${job.id}`,
        level: 'warn',
        icon: <TriangleAlert />,
        title: `${text.overview.jobFailed}: ${job.kind} · ${job.machine}`,
        meta: job.summary ?? undefined,
        to: `/jobs/${job.id}`,
      });
  // Ящик обращений — общий на среду продукта: стенд обращений людей не принимает.
  if (environment === 'product' && counts) {
    if (counts.breached)
      items.push({
        key: 'breached',
        level: 'warn',
        icon: <Inbox />,
        title: `${t.tickets}: ${counts.breached} ${t.ticketsOverdue}`,
        to: '/support',
      });
    if (counts.fresh)
      items.push({
        key: 'fresh',
        level: 'note',
        icon: <Inbox />,
        title: `${t.tickets}: ${counts.fresh} ${t.ticketsNew}`,
        to: '/support',
      });
  }
  const rank = { bad: 0, warn: 1, note: 2 };
  return items.sort((a, b) => rank[a.level] - rank[b.level]);
}

function Detail({
  machine,
  container,
  onBack,
}: {
  machine: MapMachine;
  container?: string;
  onBack: () => void;
}) {
  const history = useQuery({
    queryKey: ['map-history', machine.id, container ?? ''],
    queryFn: () => fleet.get<MapHistory>('/map/history', { machine: machine.id, container, minutes: 30 }),
    refetchInterval: 30_000,
  });
  const picked = container ? machine.containers.find((item) => item.name === container) : undefined;
  const rows: [string, string][] = picked
    ? [
        [
          m.metrics.mem,
          `${mapFormat.bytes(picked.memBytes)} · ${mapFormat.share(picked.memShare)} ${picked.memLimitBytes ? m.ofLimit : m.ofMachine}`,
        ],
        [
          m.metrics.cpu,
          `${mapFormat.cores(picked.cpu)} · ${mapFormat.share(picked.cpuShare)} ${m.ofMachine}`,
        ],
        [m.metrics.disk, mapFormat.bytes(picked.diskBytes)],
        [
          m.network,
          picked.netOutMbps === null
            ? '—'
            : `${Math.round(picked.netOutMbps)} / ${Math.round(picked.netInMbps ?? 0)} ${t.mbps}`,
        ],
        [m.image, picked.image ?? '—'],
        [m.since, picked.startedAt ? new Date(picked.startedAt * 1000).toLocaleString('ru-RU') : '—'],
      ]
    : [
        [m.load.cpu, `${mapFormat.share(machine.load.cpu)} · ${machine.hardware.cores ?? '—'} ${m.cores}`],
        [m.load.steal, mapFormat.share(machine.load.steal)],
        [
          m.load.mem,
          `${mapFormat.share(machine.load.memUsed)} ${t.of} ${mapFormat.bytes(machine.hardware.memTotalBytes)}`,
        ],
        [
          m.load.disk,
          `${mapFormat.share(machine.load.diskUsed)} ${t.of} ${mapFormat.bytes(machine.hardware.diskTotalBytes)}`,
        ],
        [
          m.load.net,
          machine.load.netOutMbps === null ? '—' : `${Math.round(machine.load.netOutMbps)} ${t.mbps}`,
        ],
        [
          m.neighbours,
          machine.neighbours.count
            ? `${machine.neighbours.count} · ${mapFormat.bytes(machine.neighbours.memBytes)}`
            : '—',
        ],
      ];
  return (
    <section className="pulse__detail" aria-label={picked ? picked.name : machine.title}>
      <header>
        <button type="button" onClick={onBack} aria-label={m.back}>
          <ArrowLeft />
        </button>
        <div>
          <strong>{picked ? tileName(picked) : machine.title}</strong>
          <span>{picked ? picked.name : `${m.roles[machine.role] ?? machine.role} · ${machine.host}`}</span>
        </div>
      </header>
      <dl>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {picked && picked.netOutMbps === null && <p className="pulse__hint">{m.networkShared}</p>}
      <div className="pulse__series">
        {Object.entries(history.data?.series ?? {}).map(([name, points]) => (
          <figure key={name}>
            <figcaption>{m.history[name] ?? name}</figcaption>
            <Spark points={points} />
          </figure>
        ))}
        {history.isPending && <Skeleton rows={2} />}
      </div>
    </section>
  );
}

function people(machines: LiveMachine[]): number | null {
  return sum(machines.map((machine) => machine.core?.connected));
}

export function Overview({ console }: { console: Console }) {
  const [environment, setEnvironment] = useEnvironment();
  const [metric, setMetric] = useState<MapMetric>('mem');
  const [tint, setTint] = useState<MapTint>('load');
  const [path, setPathState] = useState<MapPath>(readPath);
  const setPath = useCallback((next: MapPath) => {
    setPathState(next);
    writePath(next);
  }, []);

  const state = useQuery({
    queryKey: ['state'],
    queryFn: () => fleet.get<FleetState>('/state'),
    refetchInterval: 10_000,
  });
  const map = useQuery({
    queryKey: ['map'],
    queryFn: () => fleet.get<FleetMapView>('/map'),
    refetchInterval: 5_000,
  });
  const live = useQuery({
    queryKey: ['live'],
    queryFn: () => fleet.get<Live>('/live'),
    refetchInterval: 10_000,
  });
  const series = useQuery({
    queryKey: ['live-history', 30],
    queryFn: () => fleet.get<LiveHistory>('/live/history', { minutes: 30 }),
    refetchInterval: 30_000,
  });
  // Тот же ключ и та же форма ответа, что у счётчика обращений в навигации: один запрос на двоих.
  const counts = useQuery({
    queryKey: ['support-counts'],
    queryFn: () => fleet.get<{ total: SupportCounts; machines: Record<string, unknown> }>('/support/counts'),
    refetchInterval: 60_000,
    select: (answer) => answer.total,
  });
  const jobs = useQuery({
    queryKey: ['jobs', 'recent'],
    queryFn: () => fleet.get<Job[]>('/jobs', { limit: 10 }),
    refetchInterval: 30_000,
  });

  const mine = useMemo(
    () => (live.data?.machines ?? []).filter((machine) => environmentOf(machine.role) === environment),
    [live.data, environment],
  );
  const current = state.data?.environments[environment];
  const joins = sum(mine.map((machine) => machine.core?.joinsPerMin));
  const failures = sum(mine.map((machine) => machine.core?.failuresPerMin));
  const success =
    joins !== null && failures !== null && joins + failures > 0 ? joins / (joins + failures) : null;
  const uplink = sum(mine.map((machine) => machine.sfu?.outMbps ?? machine.load.netOutMbps));
  const connected = useMemo(() => {
    // Люди на связи за полчаса: сумма рядов ядер выбранной среды по общим отметкам времени.
    const total = new Map<number, number>();
    for (const machine of mine)
      for (const [time, value] of series.data?.machines[machine.id]?.connected ?? [])
        if (value !== null) total.set(time, (total.get(time) ?? 0) + value);
    return [...total.entries()].sort((a, b) => a[0] - b[0]) as Point[];
  }, [mine, series.data]);
  const rooms = mine.flatMap((machine) => machine.now?.data?.rooms ?? []).filter((room) => room.startedAt);
  const attention = attentionOf(environment, state.data, counts.data, jobs.data, console.machines);
  const opened = map.data?.machines.find((machine) => machine.id === path.machine);
  const level = current?.level ?? 'ok';

  return (
    <div className="pulse">
      <header className="pulse__head" data-level={level} role="status" aria-live="polite">
        <span className="pulse__state">
          {level === 'ok' ? <CircleCheck /> : level === 'warn' ? <TriangleAlert /> : <OctagonAlert />}
          <strong>{state.data ? t.state[level] : text.app.loading}</strong>
          {current?.reason && <span>{current.reason}</span>}
        </span>
        <Segmented
          aria-label={text.app.machine}
          size="sm"
          value={environment}
          onValueChange={setEnvironment}
          options={[
            { value: 'product', label: t.environments.product },
            { value: 'dev', label: t.environments.dev },
          ]}
        />
      </header>
      {state.error && <ErrorLine error={state.error} onRetry={() => void state.refetch()} />}

      <section className="pulse__instruments" aria-label={text.nav.overview}>
        <Instrument label={t.people} value={people(mine) ?? '—'} points={connected} />
        <Instrument label={t.meetings} value={sum(mine.map((machine) => machine.core?.live)) ?? '—'} />
        <Instrument
          label={t.joinSuccess}
          value={
            success === null
              ? '—'
              : `${(success * 100).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} %`
          }
          hint={t.joinSuccessHint}
          tone={
            success !== null && success < 0.9
              ? 'bad'
              : success !== null && success < 0.98
                ? 'warn'
                : undefined
          }
          note={success === null ? t.noData : undefined}
        />
        <Instrument label={t.uplink} value={uplink === null ? '—' : Math.round(uplink)} note={t.mbps} />
        <Instrument
          label={t.nodes}
          value={current ? `${current.online} ${t.of} ${current.machines}` : '—'}
          tone={current && current.online < current.machines ? 'warn' : undefined}
        />
        <Instrument
          label={t.tickets}
          value={counts.data ? counts.data.fresh + counts.data.open : '—'}
          note={counts.data?.breached ? `${counts.data.breached} ${t.ticketsOverdue}` : undefined}
          tone={counts.data?.breached ? 'warn' : undefined}
        />
      </section>

      <div className="pulse__body">
        <section className="pulse__map" aria-label={m.title}>
          <header>
            <h2>{m.title}</h2>
            <Segmented
              aria-label={m.size}
              size="sm"
              value={metric}
              onValueChange={setMetric}
              options={(['mem', 'cpu', 'disk'] as const).map((value) => ({ value, label: m.metrics[value] }))}
            />
            <Segmented
              aria-label={m.tint}
              size="sm"
              value={tint}
              onValueChange={setTint}
              options={(['load', 'state'] as const).map((value) => ({ value, label: m.tints[value] }))}
            />
          </header>
          {map.error && <ErrorLine error={map.error} onRetry={() => void map.refetch()} />}
          {map.data?.error && <p className="pulse__hint">{map.data.error}</p>}
          {map.data ? (
            <FleetMap data={map.data} metric={metric} tint={tint} path={path} onPath={setPath} />
          ) : (
            map.isPending && <Skeleton rows={6} />
          )}
        </section>

        <aside className="pulse__side">
          {opened ? (
            <Detail
              machine={opened}
              container={path.container}
              onBack={() => setPath(path.container ? { machine: opened.id } : {})}
            />
          ) : (
            <>
              <section aria-label={t.attention}>
                <h2>{t.attention}</h2>
                {!attention.length && <Empty>{t.calm}</Empty>}
                <ul className="pulse__attention">
                  {attention.map((item) => (
                    <li key={item.key} data-level={item.level}>
                      {item.icon}
                      {item.to ? (
                        <button type="button" onClick={() => console.go(item.to!)}>
                          {item.title}
                        </button>
                      ) : (
                        <span>{item.title}</span>
                      )}
                      {item.meta && <small>{item.meta}</small>}
                    </li>
                  ))}
                </ul>
              </section>
              <section aria-label={t.meetingsNow}>
                <h2>{t.meetingsNow}</h2>
                {!rooms.length && <p className="pulse__hint">{t.noMeetings}</p>}
                <ul className="pulse__rooms">
                  {rooms.slice(0, 8).map((room) => (
                    <li key={room.id}>
                      <strong>{room.code}</strong>
                      <span>
                        {room.connected} {plural(room.connected, m.peopleForms)}
                      </span>
                      <span>{room.mediaNode ?? ''}</span>
                      <span>
                        {room.startedAt
                          ? duration(
                              Math.max(0, (live.data?.serverTime ?? 0) - Math.floor(room.startedAt / 1000)),
                            )
                          : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
