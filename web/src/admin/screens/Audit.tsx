import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { BookOpen, Download, LogOut } from 'lucide-react';
import { Button, Field, Input, Select, Tab, TabList, TabPanel, Tabs } from '../../ui/kit';
import { text } from '../../i18n/admin/ru';
import { fleet, type AuditRow, type Session } from '../api';
import type { Console } from '../AdminApp';
import { Empty, ErrorLine, Panel, Pill, Skeleton, when } from '../parts';

/** Журнал (§8.12): пульт (с фильтрами и экспортом), ядро выбранной машины, сессии. */
export function Audit({ console }: { console: Console }) {
  return (
    <Tabs defaultValue="fleet" variant="line" className="admin-tabs">
      <TabList>
        <Tab value="fleet">{text.audit.title}</Tab>
        <Tab value="core">{text.audit.core}</Tab>
        <Tab value="sessions">{text.audit.sessions}</Tab>
      </TabList>
      <TabPanel value="fleet">
        <FleetAudit console={console} />
      </TabPanel>
      <TabPanel value="core">
        <CoreAudit console={console} />
      </TabPanel>
      <TabPanel value="sessions">
        <Sessions console={console} />
      </TabPanel>
    </Tabs>
  );
}

function FleetAudit({ console }: { console: Console }) {
  const [actor, setActor] = useState('');
  const [action, setAction] = useState('');
  const [outcome, setOutcome] = useState('');
  const [cursor, setCursor] = useState<number | null>(null);
  const rows = useQuery({
    queryKey: ['audit', actor, action, outcome, cursor],
    queryFn: () => fleet.get<AuditRow[]>('/audit', { actor, action, outcome, cursor, limit: 100 }),
  });
  return (
    <Panel
      title={text.audit.title}
      description={text.audit.hint}
      flush
      actions={
        <Button
          variant="secondary"
          size="sm"
          icon={<Download size={16} />}
          onClick={() => window.open('/api/fleet/audit/export', '_blank')}
        >
          {text.audit.export}
        </Button>
      }
    >
      <div className="admin-filters">
        <Field label={text.audit.filterActor} inline>
          <Select value={actor} onChange={(e) => setActor(e.target.value)}>
            <option value="">{text.audit.all}</option>
            <option value="owner">{text.app.owner}</option>
            <option value="agent">{text.app.agent}</option>
          </Select>
        </Field>
        <Field label={text.audit.filterAction} inline>
          <Input value={action} onChange={(e) => setAction(e.target.value)} placeholder="job." />
        </Field>
        <Field label={text.audit.filterOutcome} inline>
          <Select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            <option value="">{text.audit.all}</option>
            <option value="ok">{text.audit.outcomes.ok}</option>
            <option value="refused">{text.audit.outcomes.refused}</option>
            <option value="failed">{text.audit.outcomes.failed}</option>
          </Select>
        </Field>
      </div>
      <ErrorLine error={rows.error} onRetry={() => void rows.refetch()} />
      {rows.isPending && <Skeleton />}
      {rows.data && rows.data.length === 0 && <Empty icon={<BookOpen />}>{text.audit.empty}</Empty>}
      {rows.data && rows.data.length > 0 && (
        <div className="admin-table-wrap">
          <table className="admin-table" data-stack>
            <thead>
              <tr>
                <th>{text.audit.when}</th>
                <th>{text.audit.actor}</th>
                <th>{text.audit.action}</th>
                <th>{text.audit.target}</th>
                <th>{text.audit.outcome}</th>
                <th>{text.audit.detail}</th>
              </tr>
            </thead>
            <tbody>
              {rows.data.map((row) => (
                <tr
                  key={row.id}
                  className={row.jobId ? 'admin-table__row' : undefined}
                  tabIndex={row.jobId ? 0 : undefined}
                  onClick={() => row.jobId && console.go(`/jobs/${row.jobId}`)}
                  onKeyDown={(event) => {
                    if (row.jobId && (event.key === 'Enter' || event.key === ' ')) {
                      event.preventDefault();
                      console.go(`/jobs/${row.jobId}`);
                    }
                  }}
                >
                  <td data-label={text.audit.when} className="admin-hint">
                    {when(row.ts, true)}
                  </td>
                  <td data-label={text.audit.actor}>
                    {row.actor === 'owner' ? text.app.owner : text.app.agent}{' '}
                    <span className="admin-hint">{row.ip ?? ''}</span>
                  </td>
                  <td data-primary>
                    <code>{row.action}</code>
                  </td>
                  <td data-label={text.audit.target}>{row.target ?? ''}</td>
                  <td data-label={text.audit.outcome}>
                    <Pill tone={row.outcome === 'ok' ? 'ok' : row.outcome === 'refused' ? 'warn' : 'bad'} dot>
                      {text.audit.outcomes[row.outcome]}
                    </Pill>
                  </td>
                  <td data-label={text.audit.detail} data-wrap className="admin-hint">
                    {row.detail ?? ''} {row.args ? <code>{JSON.stringify(row.args)}</code> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.data.length === 100 && (
            <Button
              variant="quiet"
              size="sm"
              onClick={() => setCursor(rows.data![rows.data!.length - 1]!.id)}
            >
              {text.audit.more}
            </Button>
          )}
        </div>
      )}
    </Panel>
  );
}

type CoreAuditPage = {
  events: {
    ts?: number;
    at?: number;
    code?: string;
    group?: string;
    outcome?: string;
    ip?: string;
    room?: string;
    detail?: Record<string, unknown>;
  }[];
  cursor?: string | null;
};

function CoreAudit({ console }: { console: Console }) {
  const id = console.machine?.id ?? '';
  const rows = useQuery({
    queryKey: ['core-audit', id],
    queryFn: () => fleet.get<CoreAuditPage>(`/core/${id}/audit`, { limit: 100 }),
    enabled: !!id,
  });
  if (!id) return <Empty>{text.overview.noCore}</Empty>;
  const events = rows.data?.events ?? [];
  return (
    <Panel title={`${text.audit.core} — ${console.machine!.product ?? console.machine!.title}`} flush>
      <ErrorLine error={rows.error} onRetry={() => void rows.refetch()} />
      {rows.isPending && <Skeleton />}
      {rows.data && events.length === 0 && <Empty icon={<BookOpen />}>{text.audit.empty}</Empty>}
      {events.length > 0 && (
        <div className="admin-table-wrap">
          <table className="admin-table" data-stack>
            <thead>
              <tr>
                <th>{text.audit.when}</th>
                <th>{text.audit.action}</th>
                <th>{text.audit.outcome}</th>
                <th>{text.audit.target}</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event, i) => (
                <tr key={i}>
                  <td data-label={text.audit.when} className="admin-hint">
                    {when(Math.round(((event.ts ?? event.at ?? 0) as number) / 1000), true)}
                  </td>
                  <td data-primary>
                    <code>{event.code ?? event.group ?? ''}</code>
                  </td>
                  <td data-label={text.audit.outcome}>{event.outcome ?? ''}</td>
                  <td data-label={text.audit.target} className="admin-hint">
                    {event.room ?? event.ip ?? ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function Sessions({ console }: { console: Console }) {
  const client = useQueryClient();
  const sessions = useQuery({
    queryKey: ['sessions'],
    queryFn: () => fleet.get<Session[]>('/auth/sessions'),
  });
  const drop = useMutation({
    mutationFn: (id: string | null) =>
      id ? fleet.delete(`/auth/sessions/${id}`) : fleet.delete('/auth/sessions'),
    onSuccess: (_, id) => {
      if (id) void client.invalidateQueries({ queryKey: ['sessions'] });
      else void client.invalidateQueries({ queryKey: ['me'] });
    },
  });
  return (
    <Panel
      title={text.audit.sessions}
      flush
      actions={
        <Button
          variant="danger"
          size="sm"
          icon={<LogOut size={16} />}
          onClick={() => drop.mutate(null)}
          loading={drop.isPending}
        >
          {text.audit.sessionsDropAll}
        </Button>
      }
    >
      <ErrorLine error={sessions.error ?? drop.error} onRetry={() => void sessions.refetch()} />
      {sessions.isPending && <Skeleton />}
      {sessions.data && (
        <div className="admin-table-wrap">
          <table className="admin-table" data-stack>
            <thead>
              <tr>
                <th>{text.audit.sessionCreated}</th>
                <th>{text.audit.sessionSeen}</th>
                <th>{text.audit.ip}</th>
                <th>{text.audit.device}</th>
                <th>
                  <span className="sr-only">{text.nodes.actions}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sessions.data.map((s) => (
                <tr key={s.id}>
                  <td data-label={text.audit.sessionCreated}>{when(s.createdAt, true)}</td>
                  <td data-label={text.audit.sessionSeen}>{when(s.lastSeenAt, true)}</td>
                  <td data-label={text.audit.ip}>{s.ip ?? ''}</td>
                  <td data-label={text.audit.device} className="admin-hint">
                    {s.current && <Pill tone="ok">{text.audit.sessionCurrent}</Pill>} {s.userAgent ?? ''}
                  </td>
                  <td data-actions data-num>
                    <div className="admin-actions">
                      <Button variant="quiet" size="sm" onClick={() => drop.mutate(s.id)}>
                        {text.audit.sessionDrop}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {console.me.allowIps && <p className="admin-hint">FLEET_ALLOW_IPS</p>}
    </Panel>
  );
}
