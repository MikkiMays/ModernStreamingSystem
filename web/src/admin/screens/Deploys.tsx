import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Field, Input, Switch } from '../../ui/kit';
import { text } from '../../i18n/admin/ru';
import { fleet, type Job, type Machine } from '../api';
import type { Console } from '../AdminApp';
import { Confirm, Empty, ErrorLine, Panel, Skeleton, when } from '../parts';
import { JobRow } from './Jobs';

const SERVICES = ['gateway', 'core', 'services'] as const;

/** Выкатки и откаты (§8.6): по машине — что стоит (из последнего `status`), история, выкатить/откатить. */
export function Deploys({ console }: { console: Console }) {
  const client = useQueryClient();
  const history = useQuery({
    queryKey: ['jobs', 'deploy'],
    queryFn: () => fleet.get<Job[]>('/jobs', { kind: 'deploy', limit: 50 }),
  });
  const rollbacks = useQuery({
    queryKey: ['jobs', 'rollback'],
    queryFn: () => fleet.get<Job[]>('/jobs', { kind: 'rollback', limit: 50 }),
  });
  const [target, setTarget] = useState<{ machine: Machine; mode: 'deploy' | 'rollback' } | null>(null);
  const [ref, setRef] = useState('');
  const [commit, setCommit] = useState('');
  const [services, setServices] = useState<string[]>(['gateway', 'core']);
  const [drain, setDrain] = useState(true);
  const [force, setForce] = useState(false);
  const start = useMutation({
    mutationFn: (dryRun: boolean) => {
      if (!target) throw new Error();
      const args =
        target.mode === 'deploy' ? { services, ref: ref || undefined, drain, force } : { services, commit };
      return fleet.post<Job>('/jobs', { kind: target.mode, machine: target.machine.id, args, dryRun });
    },
    onSuccess: (job) => {
      setTarget(null);
      void client.invalidateQueries({ queryKey: ['jobs'] });
      console.go(`/jobs/${job.id}`);
    },
  });
  const machines = console.machines.filter((m) => m.role !== 'media-node');
  const live = (m: Machine) =>
    console.me.executor.mode === 'ssh' && console.me.executor.sshMachines.includes(m.id);
  const all = [...(history.data ?? []), ...(rollbacks.data ?? [])].sort((a, b) => b.createdAt - a.createdAt);
  const lastOf = (id: string) => all.find((j) => j.machine === id && !j.dryRun && j.status === 'ok');
  const toggle = (service: string) =>
    setServices((s) => (s.includes(service) ? s.filter((x) => x !== service) : [...s, service]));
  return (
    <div className="admin-stack">
      <Panel title={text.deploys.title}>
        <p className="admin-hint">{text.deploys.warning}</p>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>{text.deploys.machine}</th>
                <th>{text.deploys.lastDeploy}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {machines.map((m) => {
                const last = lastOf(m.id);
                return (
                  <tr key={m.id}>
                    <td>
                      <strong>{m.title}</strong> <span className="admin-hint">{m.installDir}</span>
                    </td>
                    <td className="admin-hint">
                      {last
                        ? `${when(last.createdAt, true)} · ${String(last.args.ref ?? last.args.commit ?? '')} ${(last.args.services as string[] | undefined)?.join(' ') ?? ''}`
                        : text.deploys.none}
                    </td>
                    <td className="admin-actions">
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => setTarget({ machine: m, mode: 'deploy' })}
                      >
                        {text.deploys.deploy}
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setTarget({ machine: m, mode: 'rollback' })}
                      >
                        {text.deploys.rollback}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel title={text.deploys.history}>
        <ErrorLine error={history.error ?? rollbacks.error} onRetry={() => void history.refetch()} />
        {history.isPending && <Skeleton />}
        {history.data && all.length === 0 && <Empty>{text.deploys.noHistory}</Empty>}
        {all.length > 0 && (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <tbody>
                {all.map((job) => (
                  <JobRow key={job.id} job={job} onOpen={() => console.go(`/jobs/${job.id}`)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <Confirm
        open={target !== null}
        onOpenChange={(open) => !open && setTarget(null)}
        title={
          target
            ? `${target.mode === 'deploy' ? text.deploys.deployTitle : text.deploys.rollbackTitle}: ${target.machine.title}`
            : ''
        }
        warning={text.deploys.warning}
        confirmWord={target && live(target.machine) && force ? target.machine.id : undefined}
        confirmLabel={target && live(target.machine) ? text.app.live : text.app.dryRun}
        dryRun={target && live(target.machine) ? () => start.mutate(true) : undefined}
        busy={start.isPending}
        error={start.error}
        onConfirm={() => target && start.mutate(!live(target.machine))}
      >
        {target?.mode === 'deploy' ? (
          <Field label={text.deploys.ref}>
            <Input
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              placeholder="release/1.2"
              autoComplete="off"
            />
          </Field>
        ) : (
          <Field label={text.deploys.commit}>
            <Input
              value={commit}
              onChange={(e) => setCommit(e.target.value)}
              placeholder="5b4718f"
              autoComplete="off"
            />
          </Field>
        )}
        <fieldset className="admin-fieldset">
          <legend>{text.deploys.services}</legend>
          {SERVICES.map((service) => (
            <Switch
              key={service}
              checked={services.includes(service)}
              onCheckedChange={() => toggle(service)}
              label={service}
            />
          ))}
        </fieldset>
        {target?.mode === 'deploy' && (
          <>
            <Switch checked={drain} onCheckedChange={setDrain} label={text.deploys.drain} />
            <Switch
              checked={force}
              onCheckedChange={setForce}
              label={text.deploys.force}
              description={text.deploys.forceHint}
            />
          </>
        )}
      </Confirm>
    </div>
  );
}
