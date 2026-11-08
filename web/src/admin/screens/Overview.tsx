import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { Badge, Button } from '../../ui/kit';
import { text } from '../../i18n/admin/ru';
import { fleet, type Overview as OverviewData, type OverviewMachine } from '../api';
import type { Console } from '../AdminApp';
import { Empty, ErrorLine, Panel, Skeleton, Tile, gigabytes, percent, when } from '../parts';
import { JobRow } from './Jobs';

/** Обзор (§8.1): машины, встречи сейчас, окно работ, алерты, последние задачи. Раз в 15 с. */
export function Overview({ console }: { console: Console }) {
  const overview = useQuery({
    queryKey: ['overview'],
    queryFn: () => fleet.get<OverviewData>('/overview'),
    refetchInterval: 15_000,
  });
  const data = overview.data;
  const totals = (data?.machines ?? []).reduce(
    (sum, m) => {
      const now = m.now?.data;
      if (!now) return sum;
      return {
        live: sum.live + now.live,
        humans: sum.humans + now.humans,
        bots: sum.bots + now.bots,
        screens: sum.screens + now.screens,
      };
    },
    { live: 0, humans: 0, bots: 0, screens: 0 },
  );
  return (
    <div className="admin-stack">
      <Panel
        title={text.overview.machines}
        actions={
          <Button
            variant="quiet"
            size="sm"
            icon={<RefreshCw size={16} />}
            loading={overview.isFetching}
            onClick={() => void overview.refetch()}
          >
            {text.app.refresh}
          </Button>
        }
      >
        <ErrorLine error={overview.error} onRetry={() => void overview.refetch()} />
        {overview.isPending && <Skeleton rows={3} />}
        {data && data.machines.length === 0 && <Empty>{text.overview.noMachines}</Empty>}
        {data && data.machines.length > 0 && (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <tbody>
                {data.machines.map((m) => (
                  <MachineRow key={m.id} machine={m} console={console} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <div className="admin-grid-3">
        <Panel title={text.overview.now}>
          <div className="admin-tiles">
            <Tile value={totals.live} label={text.overview.meetings} />
            <Tile value={totals.humans} label={text.overview.humans} />
            <Tile value={totals.bots} label={text.overview.bots} />
            <Tile value={totals.screens} label={text.overview.screens} />
          </div>
        </Panel>
        <Panel title={text.overview.maintenance}>
          {(data?.machines ?? [])
            .filter((m) => m.maintenance)
            .map((m) => {
              const status = m.maintenance!.data;
              return (
                <div key={m.id} className="admin-row">
                  <span className="admin-row__name">{m.product ?? m.title}</span>
                  {m.maintenance!.error ? (
                    <Badge variant="danger">{m.maintenance!.error.code}</Badge>
                  ) : (
                    <Badge variant={status?.phase === 'none' ? 'neutral' : 'danger'}>
                      {text.overview.phase[status?.phase ?? 'none']}
                    </Badge>
                  )}
                </div>
              );
            })}
          <Button variant="secondary" size="sm" onClick={() => console.go('/maintenance')}>
            {text.nav.maintenance}
          </Button>
        </Panel>
        <Panel title={text.overview.alerts}>
          {data?.alerts.error && <p className="admin-hint">{data.alerts.error}</p>}
          {data && !data.alerts.error && data.alerts.alerts.length === 0 && (
            <Empty>{text.overview.noAlerts}</Empty>
          )}
          {data?.alerts.alerts.map((alert, i) => (
            <div key={i} className="admin-row">
              <Badge variant={alert.severity === 'critical' ? 'danger' : 'accent'}>{alert.name}</Badge>
              <span className="admin-hint">
                {alert.node ?? ''} {alert.summary ?? ''}
              </span>
            </div>
          ))}
        </Panel>
      </div>
      <Panel
        title={text.overview.jobs}
        actions={
          <Button variant="quiet" size="sm" onClick={() => console.go('/jobs')}>
            {text.nav.jobs}
          </Button>
        }
      >
        {data && data.jobs.length === 0 && <Empty>{text.overview.noJobs}</Empty>}
        {data && data.jobs.length > 0 && (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <tbody>
                {data.jobs.map((job) => (
                  <JobRow key={job.id} job={job} onOpen={() => console.go(`/jobs/${job.id}`)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

function MachineRow({ machine: m, console }: { machine: OverviewMachine; console: Console }) {
  const now = m.now?.data;
  const metrics = m.metrics;
  const alive = m.now ? !m.now.error : null;
  return (
    <tr>
      <td>
        <span
          className="admin-dot"
          data-state={alive === null ? 'unknown' : alive ? 'ok' : 'bad'}
          aria-hidden="true"
        />
        <strong>{m.title}</strong>
        <span className="admin-hint"> {m.host}</span>
      </td>
      <td>
        {text.overview.role[m.role] ?? m.role}
        {m.nodeId && <span className="admin-hint"> · {m.nodeId}</span>}
      </td>
      <td className="admin-metrics">
        {metrics.error ? (
          <span className="admin-hint" title={metrics.error}>
            {text.overview.noMetrics}
          </span>
        ) : (
          <>
            <span>
              {text.overview.cpu} {percent(metrics.cpu)}
            </span>
            <span data-tone={metrics.steal !== null && metrics.steal > 0.1 ? 'bad' : undefined}>
              {text.overview.steal} {percent(metrics.steal)}
            </span>
            <span>
              {text.overview.mem} {percent(metrics.memUsed)}
            </span>
            <span>
              {text.overview.disk} {gigabytes(metrics.diskFreeBytes)}
            </span>
          </>
        )}
      </td>
      <td>
        {m.now === null ? (
          <span className="admin-hint">{m.core ? text.overview.noCredential : text.overview.noCore}</span>
        ) : m.now.error ? (
          <Badge variant="danger" title={m.now.error.detail}>
            {m.now.error.code}
          </Badge>
        ) : (
          <span>
            {now!.live} {text.overview.meetings} · {now!.humans} {text.overview.humans}
          </span>
        )}
      </td>
      <td className="admin-hint">
        {m.status ? `${m.status.lines[0] ?? ''} · ${text.app.updatedAt} ${when(m.status.updatedAt)}` : ''}
        {m.role === 'media-node' && !m.now && (
          <Button variant="quiet" size="sm" onClick={() => console.go('/nodes')}>
            {text.nav.nodes}
          </Button>
        )}
      </td>
    </tr>
  );
}
