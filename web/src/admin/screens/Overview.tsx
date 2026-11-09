import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  AlertTriangle,
  BellRing,
  CheckCircle2,
  ChevronRight,
  Inbox,
  OctagonAlert,
  RefreshCw,
  ServerCrash,
  Unplug,
  Wrench,
  XOctagon,
} from 'lucide-react';
import { Button, Flag } from '../../ui/kit';
import { text } from '../../i18n/admin/ru';
import {
  fleet,
  type Machine,
  type Overview as OverviewData,
  type OverviewMachine,
  type SupportCounts,
} from '../api';
import { NODE_TONE, useProductNodes, type NodeState } from '../nodes';
import type { Console } from '../AdminApp';
import { Meter } from '../charts';
import {
  Dot,
  Empty,
  ErrorLine,
  Panel,
  Pill,
  Skeleton,
  Stat,
  Stats,
  gigabytes,
  iso,
  plural,
  when,
} from '../parts';
import { JobsTable } from './Jobs';

const t = text.overview;

type Tone = 'bad' | 'warn' | 'neutral';

export type Attention = {
  key: string;
  tone: Tone;
  icon: ReactNode;
  title: string;
  meta?: string;
  /** Куда ведёт строка; `machine` — сделать машину контекстом раздела ядра перед переходом. */
  to: string;
  machine?: string;
};

const RANK: Record<Tone, number> = { bad: 0, warn: 1, neutral: 2 };

function ago(iso: string | null, now: number): string | undefined {
  if (!iso) return undefined;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return undefined;
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  return minutes < 60
    ? `${minutes} ${text.units.minutes} ${t.ago}`
    : `${Math.floor(minutes / 60)} ${text.units.hours} ${minutes % 60} ${text.units.minutes} ${t.ago}`;
}

/**
 * Что требует внимания (R220): алерты, молчащие ядра и агенты метрик, окна работ, упавшие задачи и обращения — одним
 * списком, худшее сверху. Каждая строка ведёт туда, где с этим разбираются.
 */
export function attention(
  data: OverviewData | undefined,
  counts: SupportCounts | undefined,
  now: number,
  nodes: { core: Machine | null; states: Map<string, NodeState> } = { core: null, states: new Map() },
): Attention[] {
  const items: Attention[] = [];
  // Узел, до которого ядро продукта не достаёт (`down` по реестру и магистрали), — встречи на него не встанут.
  for (const state of nodes.states.values())
    if (state.state === 'down')
      items.push({
        key: `node-${state.id}`,
        tone: 'bad',
        icon: <Unplug />,
        title: `${state.id}${state.title ? ` (${state.title})` : ''}: ${t.nodeDown}`,
        meta: nodes.core ? `${text.live.linkCore} ${nodes.core.title}` : undefined,
        to: '/nodes',
        machine: nodes.core?.id,
      });
  for (const [i, alert] of (data?.alerts.alerts ?? []).entries())
    items.push({
      key: `alert-${i}`,
      tone: alert.severity === 'critical' ? 'bad' : 'warn',
      icon: <BellRing />,
      title: `${alert.node ? `${alert.node}: ` : ''}${alert.summary ?? alert.name}`,
      meta: [`${t.alert} ${alert.name}`, ago(alert.activeAt, now)].filter(Boolean).join(' · '),
      to: '/live',
    });
  for (const m of data?.machines ?? []) {
    if (m.now?.error)
      items.push({
        key: `core-${m.id}`,
        tone: 'bad',
        icon: <ServerCrash />,
        title: `${m.title}: ${t.coreDown}`,
        meta: m.now.error.detail || m.now.error.code,
        to: `/live#machine-${m.id}`,
      });
    if (m.metrics.error)
      items.push({
        key: `metrics-${m.id}`,
        tone: 'warn',
        icon: <Unplug />,
        title: `${m.title}: ${t.metricsDown}`,
        meta: m.metrics.error,
        to: `/live#machine-${m.id}`,
      });
    const phase = m.maintenance?.data?.phase;
    if (phase && phase !== 'none') {
      const window = m.maintenance!.data!.window;
      items.push({
        key: `maintenance-${m.id}`,
        tone: phase === 'scheduled' ? 'warn' : 'bad',
        icon: <Wrench />,
        title: `${m.product ?? m.title}: ${t.maintenanceOn} — ${t.phase[phase] ?? phase}`,
        meta: window ? `${iso(window.startsAt)} — ${iso(window.endsAt)}` : undefined,
        to: '/maintenance',
        machine: m.id,
      });
    }
  }
  for (const job of data?.jobs ?? [])
    if (job.status === 'failed')
      items.push({
        key: `job-${job.id}`,
        tone: 'bad',
        icon: <XOctagon />,
        title: `${t.jobFailed}: ${job.kind} · ${job.machine}`,
        meta: [job.summary, when(job.createdAt, true)].filter(Boolean).join(' · '),
        to: `/jobs/${job.id}`,
      });
  if (counts?.breached)
    items.push({
      key: 'tickets-breached',
      tone: 'bad',
      icon: <Inbox />,
      title: `${t.ticketsBreached}: ${counts.breached}`,
      to: '/support',
    });
  if (counts?.fresh)
    items.push({
      key: 'tickets-new',
      tone: 'neutral',
      icon: <Inbox />,
      title: `${t.ticketsNew}: ${counts.fresh}`,
      to: '/support',
    });
  return items.sort((a, b) => RANK[a.tone] - RANK[b.tone]);
}

function count(n: number, forms: readonly [string, string, string]): string {
  return `${n} ${plural(n, forms)}`;
}

/** Машина на связи: агент метрик отвечает и ядро (если оно есть) — тоже. */
function online(m: OverviewMachine): boolean | null {
  if (m.metrics.error && !m.now) return false;
  if (m.now?.error) return false;
  if (m.metrics.error) return null;
  return true;
}

/** Обзор (§8.1, R220): ответ «всё ли в порядке» первым, затем что идёт, что требует внимания, машины и задачи. */
export function Overview({ console }: { console: Console }) {
  const overview = useQuery({
    queryKey: ['overview'],
    queryFn: () => fleet.get<OverviewData>('/overview'),
    refetchInterval: 15_000,
  });
  const counts = useQuery({
    queryKey: ['support-counts'],
    queryFn: () => fleet.get<{ total: SupportCounts; machines: Record<string, unknown> }>('/support/counts'),
    refetchInterval: 60_000,
  });
  const data = overview.data;
  const total = counts.data?.total;
  const now = Date.now();
  const nodes = useProductNodes(console.machines);
  const items = attention(data, total, now, nodes);
  const tone = items.some((i) => i.tone === 'bad')
    ? 'bad'
    : items.some((i) => i.tone === 'warn')
      ? 'warn'
      : 'ok';
  const machines = data?.machines ?? [];
  const up = machines.filter((m) => online(m) === true).length;
  const totals = machines.reduce(
    (sum, m) => {
      const live = m.now?.data;
      if (!live) return sum;
      return {
        live: sum.live + live.live,
        humans: sum.humans + live.humans,
        bots: sum.bots + live.bots,
        screens: sum.screens + live.screens,
      };
    },
    { live: 0, humans: 0, bots: 0, screens: 0 },
  );
  const open = (item: Attention) => {
    if (item.machine) console.setMachine(item.machine);
    console.go(item.to);
  };
  return (
    <div className="admin-stack">
      <ErrorLine
        error={overview.error}
        onRetry={() => void overview.refetch()}
        updatedAt={data ? overview.dataUpdatedAt : undefined}
      />
      {overview.isPending ? (
        <div className="admin-status">
          <Skeleton rows={2} />
        </div>
      ) : (
        <section className="admin-status" data-tone={tone} aria-labelledby="admin-status-title">
          <span className="admin-status__icon" aria-hidden="true">
            {tone === 'ok' ? <CheckCircle2 /> : tone === 'warn' ? <AlertTriangle /> : <OctagonAlert />}
          </span>
          <div>
            <h2 className="admin-status__title" id="admin-status-title">
              {t.status[tone]}
            </h2>
            <p className="admin-status__sub">
              {up} {t.of} {machines.length} {t.machinesUp}
              {data && ` · ${text.app.updated} ${when(data.serverTime)}`}
            </p>
          </div>
          <Button
            variant="quiet"
            size="sm"
            icon={<RefreshCw size={16} />}
            loading={overview.isFetching}
            onClick={() => void overview.refetch()}
          >
            {text.app.refresh}
          </Button>
          <div className="admin-status__live">
            <Stats>
              <Stat value={totals.live} label={text.live.meetings} />
              <Stat value={totals.humans} label={text.live.humans} />
              <Stat value={totals.screens} label={text.live.screens} />
              <Stat value={totals.bots} label={t.botsLabel} />
            </Stats>
          </div>
        </section>
      )}
      <div className="admin-grid-2">
        <Panel title={t.attention} flush>
          {data && items.length === 0 ? (
            <Empty icon={<CheckCircle2 />}>{t.calm}</Empty>
          ) : (
            <ul className="admin-list">
              {items.map((item) => (
                <li key={item.key}>
                  <a
                    className="admin-attention__item"
                    data-tone={item.tone}
                    href={item.to}
                    onClick={(event) => {
                      event.preventDefault();
                      open(item);
                    }}
                  >
                    <span className="admin-attention__icon" aria-hidden="true">
                      {item.icon}
                    </span>
                    <span className="admin-attention__text">
                      <span className="admin-attention__title">{item.title}</span>
                      {item.meta && <span className="admin-attention__meta">{item.meta}</span>}
                    </span>
                    <ChevronRight className="admin-attention__go" size={16} aria-hidden="true" />
                  </a>
                </li>
              ))}
            </ul>
          )}
          {overview.isPending && <Skeleton rows={3} />}
          {data?.alerts.error && <p className="admin-hint">{data.alerts.error}</p>}
        </Panel>
        <div className="admin-stack">
          <Panel
            title={t.support}
            actions={
              <Button variant="secondary" size="sm" onClick={() => console.go('/support')}>
                {t.toSupport}
              </Button>
            }
          >
            <ErrorLine error={counts.error} onRetry={() => void counts.refetch()} />
            {counts.isPending && <Skeleton rows={1} />}
            {total && (
              <Stats>
                <Stat value={total.fresh} label={t.supportNew} />
                <Stat value={total.open} label={t.supportOpen} />
                <Stat value={total.waiting} label={t.supportWaiting} />
                <Stat
                  value={total.breached}
                  label={t.supportBreached}
                  tone={total.breached ? 'bad' : undefined}
                />
              </Stats>
            )}
          </Panel>
          <Panel
            title={t.maintenance}
            actions={
              <Button variant="secondary" size="sm" onClick={() => console.go('/maintenance')}>
                {text.nav.maintenance}
              </Button>
            }
          >
            {overview.isPending && <Skeleton rows={2} />}
            <ul className="admin-list admin-list--rows">
              {machines
                .filter((m) => m.maintenance)
                .map((m) => {
                  const status = m.maintenance!.data;
                  return (
                    <li key={m.id} className="admin-row">
                      <span className="admin-strong">{m.product ?? m.title}</span>
                      {m.maintenance!.error ? (
                        <Pill tone="bad" title={m.maintenance!.error.detail}>
                          {m.maintenance!.error.code}
                        </Pill>
                      ) : (
                        <Pill
                          tone={
                            status?.phase === 'none'
                              ? 'neutral'
                              : status?.phase === 'scheduled'
                                ? 'warn'
                                : 'bad'
                          }
                          dot
                        >
                          {t.phase[status?.phase ?? 'none']}
                        </Pill>
                      )}
                      {status?.window && (
                        <span className="admin-sub">
                          {iso(status.window.startsAt)} — {iso(status.window.endsAt)}
                        </span>
                      )}
                    </li>
                  );
                })}
            </ul>
          </Panel>
        </div>
      </div>
      <Panel
        title={t.machines}
        flush
        actions={
          <Button variant="quiet" size="sm" onClick={() => console.go('/live')}>
            {t.toLive}
          </Button>
        }
      >
        {overview.isPending && <Skeleton rows={4} />}
        {data && machines.length === 0 && <Empty>{t.noMachines}</Empty>}
        {machines.length > 0 && (
          <ul className="admin-list">
            {machines.map((m) => (
              <li key={m.id}>
                <MachineRow
                  machine={m}
                  console={console}
                  states={nodes.states}
                  product={machines.find((x) => x.id === nodes.core?.id) ?? null}
                />
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel
        title={t.jobs}
        flush
        actions={
          <Button variant="quiet" size="sm" onClick={() => console.go('/jobs')}>
            {text.nav.jobs}
          </Button>
        }
      >
        {data && data.jobs.length === 0 && <Empty>{t.noJobs}</Empty>}
        {data && data.jobs.length > 0 && <JobsTable jobs={data.jobs} console={console} />}
      </Panel>
    </div>
  );
}

function MachineRow({
  machine: m,
  console,
  states,
  product,
}: {
  machine: OverviewMachine;
  console: Console;
  states: Map<string, NodeState>;
  product: OverviewMachine | null;
}) {
  const now = m.now?.data;
  const mediaNode = m.role === 'media-node' && !m.core;
  const node = mediaNode ? states.get(m.nodeId ?? m.id) : undefined;
  // Комнаты и люди на узле — по встречам ядра продукта (`mediaNode` комнаты).
  const onNode = (product?.now?.data?.rooms ?? []).filter((r) => r.mediaNode === (m.nodeId ?? m.id));
  const working = [...states.values()].filter((s) => s.state === 'ok' || s.state === 'busy').length;
  const metrics = m.metrics;
  const state = online(m);
  const stateWord = state === null ? t.unknown : state ? t.online : t.offline;
  return (
    <a
      className="admin-machine"
      href={`/live#machine-${m.id}`}
      onClick={(event) => {
        event.preventDefault();
        console.go(`/live#machine-${m.id}`);
      }}
    >
      <span className="admin-machine__name">
        <Dot state={state === null ? 'warn' : state ? 'ok' : 'bad'} label={stateWord} />
        <span className="admin-machine__title">{m.title}</span>
        <span className="admin-sub">
          {t.role[m.role] ?? m.role}
          {m.nodeId && ` · ${m.nodeId}`} · {m.host}
        </span>
      </span>
      <span className="admin-machine__meters">
        {metrics.error ? (
          <span className="admin-hint" title={metrics.error}>
            {t.noMetrics}: {metrics.error}
          </span>
        ) : (
          <>
            <Meter compact label={t.cpu} value={metrics.cpu} />
            <Meter
              compact
              label={t.steal}
              value={metrics.steal}
              warn={0.05}
              bad={0.1}
              hint={text.live.stealHint}
            />
            <Meter compact label={t.mem} value={metrics.memUsed} warn={0.8} bad={0.92} />
            <span className="admin-meter" data-compact="">
              <span className="admin-meter__label">{t.disk}</span>
              <span className="admin-meter__text">
                {gigabytes(metrics.diskFreeBytes)} {t.free}
              </span>
            </span>
          </>
        )}
      </span>
      <span className="admin-machine__side">
        {mediaNode ? (
          <>
            <span className="admin-row">
              {node?.country && <Flag country={node.country} />}
              <Pill tone={node?.state ? (NODE_TONE[node.state] ?? 'neutral') : node ? 'neutral' : 'warn'} dot>
                {node
                  ? `${t.nodeOf} ${product?.title ?? ''}: ${node.state ? (text.nodes.states[node.state] ?? node.state) : text.nodes.enabled}`
                  : t.nodeNotLinked}
              </Pill>
            </span>
            {node && (
              <span className="admin-sub">
                {count(onNode.length, t.meetingForms)} ·{' '}
                {count(
                  onNode.reduce((sum, r) => sum + r.humans, 0),
                  t.peopleForms,
                )}
              </span>
            )}
          </>
        ) : m.now === null ? (
          <span className="admin-sub">{m.core ? t.noCredential : t.noCore}</span>
        ) : m.now.error ? (
          <Pill tone="bad" title={m.now.error.detail}>
            {m.now.error.code}
          </Pill>
        ) : (
          <>
            <span className="admin-strong">
              {count(now!.live, t.meetingForms)} · {count(now!.humans, t.peopleForms)}
            </span>
            {m.id === product?.id && states.size > 0 && (
              <span className="admin-sub">
                {text.nav.nodes}: {working} {t.of} {states.size} {t.nodesOk}
              </span>
            )}
          </>
        )}
        {m.status && (
          <span className="admin-sub">
            {m.status.lines[0] ?? ''} · {text.app.updatedAt} {when(m.status.updatedAt)}
          </span>
        )}
      </span>
    </a>
  );
}
