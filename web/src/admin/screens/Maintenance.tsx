import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Field, Input, Switch } from '../../ui/kit';
import { text } from '../../i18n/admin/ru';
import { fleet, type MaintenanceStatus, type Now } from '../api';
import type { Console } from '../AdminApp';
import { Confirm, Empty, ErrorLine, Panel, Pill, Skeleton, iso } from '../parts';

type Mode = 'now' | 'schedule' | 'extend' | null;

/** Окно технических работ (R194 API) и дренаж — ядро выбранной машины (§8.5). */
export function Maintenance({ console }: { console: Console }) {
  const client = useQueryClient();
  const machine = console.machine;
  const id = machine?.id ?? '';
  const status = useQuery({
    queryKey: ['maintenance', id],
    queryFn: () => fleet.get<MaintenanceStatus>(`/core/${id}/maintenance`),
    enabled: !!id,
    refetchInterval: (query) => (query.state.data && query.state.data.phase !== 'none' ? 5_000 : 15_000),
  });
  const drain = useQuery({
    queryKey: ['drain', id],
    queryFn: () => fleet.get<{ on: boolean; since: number }>(`/core/${id}/drain`),
    enabled: !!id,
    refetchInterval: 15_000,
  });
  const now = useQuery({
    queryKey: ['now', id],
    queryFn: () => fleet.get<Now>(`/core/${id}/now`),
    enabled: !!id,
    refetchInterval: 15_000,
  });
  const [mode, setMode] = useState<Mode>(null);
  const [grace, setGrace] = useState('120');
  const [until, setUntil] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [reason, setReason] = useState('');
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['maintenance', id] });
    void client.invalidateQueries({ queryKey: ['drain', id] });
    void client.invalidateQueries({ queryKey: ['overview'] });
  };
  const lever = useMutation({
    mutationFn: async () => {
      const body = { endsAt: until || undefined, reason: reason || undefined };
      if (mode === 'now')
        return fleet.post(`/core/${id}/maintenance/now`, { graceSeconds: Number(grace), ...body });
      if (mode === 'schedule') return fleet.post(`/core/${id}/maintenance/schedule`, { startsAt, ...body });
      if (mode === 'extend') return fleet.post(`/core/${id}/maintenance/extend`, { endsAt: until });
      return undefined;
    },
    onSuccess: () => {
      setMode(null);
      refresh();
    },
  });
  const finish = useMutation({
    mutationFn: () => fleet.delete(`/core/${id}/maintenance`),
    onSuccess: refresh,
  });
  const toggleDrain = useMutation({
    mutationFn: (on: boolean) => fleet.post(`/core/${id}/drain`, { on }),
    onSuccess: refresh,
  });

  if (!machine) return <Empty>{text.overview.noCore}</Empty>;
  const window = status.data?.window;
  const phase = status.data?.phase ?? 'none';
  return (
    <div className="admin-stack">
      <Panel
        title={`${text.maintenance.title} — ${machine.product ?? machine.title}`}
        description={text.maintenance.hint}
        actions={
          <>
            <Button variant="danger" size="sm" onClick={() => setMode('now')} disabled={phase === 'active'}>
              {text.maintenance.now}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setMode('schedule')}
              disabled={phase !== 'none'}
            >
              {text.maintenance.schedule}
            </Button>
          </>
        }
      >
        <ErrorLine
          error={status.error ?? finish.error ?? toggleDrain.error}
          onRetry={() => void status.refetch()}
        />
        {status.isPending && <Skeleton rows={2} />}
        {status.data && (
          <div className="admin-stack">
            <div className="admin-row">
              <span className="admin-strong">{text.maintenance.status}</span>
              <Pill tone={phase === 'none' ? 'ok' : phase === 'scheduled' ? 'warn' : 'bad'} dot>
                {text.overview.phase[phase]}
              </Pill>
              {now.data && (
                <span className="admin-hint">
                  {text.maintenance.liveNow
                    .replace('{live}', String(now.data.live))
                    .replace('{humans}', String(now.data.humans))}
                </span>
              )}
            </div>
            {window && (
              <dl className="admin-dl">
                <dt>{text.maintenance.window}</dt>
                <dd>
                  <code>{window.kind}</code> {window.id}
                </dd>
                <dt>{text.maintenance.startsAt}</dt>
                <dd>{iso(window.startsAt)}</dd>
                <dt>{text.maintenance.endsAt}</dt>
                <dd>{iso(window.endsAt)}</dd>
                <dt>{text.maintenance.expiresAt}</dt>
                <dd>{iso(window.expiresAt)}</dd>
                <dt>{text.maintenance.reason}</dt>
                <dd>{window.reason ?? '—'}</dd>
              </dl>
            )}
            {phase !== 'none' && (
              <div className="admin-actions">
                <Button variant="secondary" size="sm" onClick={() => setMode('extend')}>
                  {text.maintenance.extend}
                </Button>
                <Button variant="danger" size="sm" loading={finish.isPending} onClick={() => finish.mutate()}>
                  {phase === 'scheduled' ? text.maintenance.cancelWindow : text.maintenance.finish}
                </Button>
              </div>
            )}
          </div>
        )}
      </Panel>
      <Panel title={text.maintenance.drainTitle}>
        <ErrorLine error={drain.error} onRetry={() => void drain.refetch()} />
        <Switch
          checked={drain.data?.on ?? false}
          onCheckedChange={(on) => toggleDrain.mutate(on)}
          label={drain.data?.on ? text.maintenance.drainOn : text.maintenance.drainOff}
          description={text.maintenance.drainHint}
          disabled={toggleDrain.isPending || !drain.data}
        />
      </Panel>
      <Confirm
        open={mode !== null}
        onOpenChange={(open) => !open && setMode(null)}
        title={
          mode === 'now'
            ? text.maintenance.now
            : mode === 'schedule'
              ? text.maintenance.schedule
              : text.maintenance.extend
        }
        warning={
          mode === 'now'
            ? text.maintenance.nowWarning
            : mode === 'schedule'
              ? text.maintenance.scheduleWarning
              : undefined
        }
        confirmLabel={
          mode === 'now'
            ? text.maintenance.confirmNow
            : mode === 'schedule'
              ? text.maintenance.confirmSchedule
              : text.maintenance.confirmExtend
        }
        danger={mode === 'now'}
        busy={lever.isPending}
        error={lever.error}
        onConfirm={() => lever.mutate()}
      >
        {mode === 'now' && (
          <Field label={text.maintenance.grace}>
            <Input inputMode="numeric" value={grace} onChange={(e) => setGrace(e.target.value)} />
          </Field>
        )}
        {mode === 'schedule' && (
          <Field label={text.maintenance.start}>
            <Input
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
              placeholder="2026-11-10T04:00:00+03:00"
            />
          </Field>
        )}
        <Field label={text.maintenance.until}>
          <Input
            value={until}
            onChange={(e) => setUntil(e.target.value)}
            placeholder="2026-11-10T05:00:00+03:00"
          />
        </Field>
        {mode !== 'extend' && (
          <Field label={text.maintenance.reason}>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={text.maintenance.reasonPlaceholder}
            />
          </Field>
        )}
      </Confirm>
    </div>
  );
}
