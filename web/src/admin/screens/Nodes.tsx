import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Plus } from 'lucide-react';
import {
  Badge,
  Button,
  Dialog,
  Field,
  Flag,
  Input,
  LoadBars,
  Switch,
  useToast,
  type LoadState,
} from '../../ui/kit';
import { text } from '../../i18n/admin/ru';
import { fleet, type AddServerPlan, type Job, type NodesView, type RegistryNode } from '../api';
import type { Console } from '../AdminApp';
import { Confirm, Empty, ErrorLine, Panel, Skeleton } from '../parts';

type Action = 'drain' | 'undrain' | 'check' | 'update' | 'remove' | 'logs';

const STATE: Record<string, LoadState> = {
  ok: 'ok',
  busy: 'busy',
  full: 'full',
  down: 'unknown',
  drained: 'maintenance',
};

/** Узлы выбранной машины-ядра (§8.2): реестр + ступени ядра; действия — задачи каталога. */
export function Nodes({ console }: { console: Console }) {
  const client = useQueryClient();
  const machine = console.machine;
  const id = machine?.id ?? '';
  const nodes = useQuery({
    queryKey: ['nodes', id],
    queryFn: () => fleet.get<NodesView>(`/nodes/${id}`),
    enabled: !!id,
    refetchInterval: 15_000,
  });
  const [pending, setPending] = useState<{ node: RegistryNode; action: Action } | null>(null);
  const [adding, setAdding] = useState(false);
  const act = useMutation({
    mutationFn: ({ node, action, dryRun }: { node: RegistryNode; action: Action; dryRun: boolean }) =>
      fleet.post<Job>(`/nodes/${id}/${node.id}/${action}`, {
        dryRun,
        args: action === 'remove' ? { confirm: node.id } : {},
      }),
    onSuccess: (job) => {
      setPending(null);
      void client.invalidateQueries({ queryKey: ['jobs'] });
      console.go(`/jobs/${job.id}`);
    },
  });
  if (!machine) return <Empty>{text.overview.noCore}</Empty>;
  const live = console.me.executor.mode === 'ssh' && console.me.executor.sshMachines.includes(machine.id);
  const data = nodes.data;
  const levels = new Map((data?.levels.data ?? []).map((l) => [l.id, l]));
  const registryNodes: RegistryNode[] =
    data?.registry?.nodes ??
    (data?.levels.data ?? []).map((l) => ({
      id: l.id,
      control: l.control,
      country: l.country ?? undefined,
      title: l.title,
    }));
  const titles: Record<Action, string> = {
    drain: text.nodes.drainTitle,
    undrain: text.nodes.undrainTitle,
    check: text.nodes.check,
    update: text.nodes.updateTitle,
    remove: text.nodes.removeTitle,
    logs: text.nodes.logs,
  };
  const warnings: Partial<Record<Action, string>> = {
    drain: text.nodes.drainWarning,
    undrain: text.nodes.undrainWarning,
    update: text.nodes.updateWarning,
    remove: text.nodes.removeWarning,
  };
  return (
    <div className="admin-stack">
      <Panel
        title={`${text.nodes.title} — ${machine.product ?? machine.title}`}
        actions={
          <Button variant="primary" size="sm" icon={<Plus size={16} />} onClick={() => setAdding(true)}>
            {text.nodes.add}
          </Button>
        }
      >
        <ErrorLine error={nodes.error} onRetry={() => void nodes.refetch()} />
        {data?.registryError && !data.registry && <p className="admin-hint">{data.registryError}</p>}
        {data?.levels.error && (
          <p className="admin-hint">
            {text.nodes.levelsError}: {data.levels.error.detail}
          </p>
        )}
        {nodes.isPending && <Skeleton />}
        {data && registryNodes.length === 0 && <Empty>{text.nodes.empty}</Empty>}
        {data && registryNodes.length > 0 && (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>{text.nodes.node}</th>
                  <th>{text.nodes.country}</th>
                  <th>{text.nodes.state}</th>
                  <th>{text.nodes.level}</th>
                  <th>{text.nodes.rooms}</th>
                  <th>{text.nodes.uplink}</th>
                  <th>{text.nodes.cores}</th>
                  <th>{text.nodes.actions}</th>
                </tr>
              </thead>
              <tbody>
                {registryNodes.map((node) => {
                  const level = levels.get(node.id);
                  const drained = node.enabled === false;
                  return (
                    <tr key={node.id}>
                      <td>
                        <strong>{node.id}</strong>
                        <span className="admin-hint"> {node.title?.ru ?? ''}</span>
                        {node.control && <Badge variant="neutral">{text.nodes.control}</Badge>}
                      </td>
                      <td>{node.country ? <Flag country={node.country} /> : '—'}</td>
                      <td>
                        {drained ? (
                          <Badge variant="soon">{text.nodes.drained}</Badge>
                        ) : level ? (
                          <Badge
                            variant={
                              level.state === 'down' ? 'danger' : level.state === 'ok' ? 'success' : 'accent'
                            }
                          >
                            {level.state}
                          </Badge>
                        ) : (
                          <Badge variant="neutral">{text.nodes.enabled}</Badge>
                        )}
                      </td>
                      <td>
                        {level ? <LoadBars level={level.level} state={STATE[level.state] ?? 'ok'} /> : '—'}
                      </td>
                      <td>{node.maxRooms ?? '—'}</td>
                      <td>{node.uplinkMbps ?? '—'}</td>
                      <td>{node.cores ?? '—'}</td>
                      <td className="admin-actions">
                        {!node.control && (
                          <>
                            <Button
                              variant="quiet"
                              size="sm"
                              onClick={() => setPending({ node, action: 'check' })}
                            >
                              {text.nodes.check}
                            </Button>
                            <Button
                              variant="quiet"
                              size="sm"
                              onClick={() => setPending({ node, action: 'logs' })}
                            >
                              {text.nodes.logs}
                            </Button>
                            {drained ? (
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => setPending({ node, action: 'undrain' })}
                              >
                                {text.nodes.undrain}
                              </Button>
                            ) : (
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => setPending({ node, action: 'drain' })}
                              >
                                {text.nodes.drain}
                              </Button>
                            )}
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => setPending({ node, action: 'update' })}
                            >
                              {text.nodes.update}
                            </Button>
                            <Button
                              variant="danger"
                              size="sm"
                              disabled={!drained}
                              onClick={() => setPending({ node, action: 'remove' })}
                            >
                              {text.nodes.remove}
                            </Button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <Confirm
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        title={pending ? `${titles[pending.action]}: ${pending.node.id}` : ''}
        warning={pending ? warnings[pending.action] : undefined}
        confirmWord={pending?.action === 'remove' ? pending.node.id : undefined}
        confirmLabel={live ? text.app.live : text.app.dryRun}
        danger={pending?.action === 'remove' || pending?.action === 'update'}
        dryRun={live && pending ? () => act.mutate({ ...pending, dryRun: true }) : undefined}
        busy={act.isPending}
        error={act.error}
        onConfirm={() => pending && act.mutate({ ...pending, dryRun: !live })}
      />
      <AddServer
        open={adding}
        onOpenChange={setAdding}
        machine={machine.id}
        product={machine.product ?? ''}
        live={live}
        console={console}
      />
    </div>
  );
}

type Form = {
  id: string;
  ip: string;
  product: string;
  country: string;
  titleRu: string;
  titleEn: string;
  app: string;
  rtc: string;
  turn: string;
  maxRooms: string;
  uplinkMbps: string;
  cores: string;
  ssh: string;
  sshKey: string;
  dnsReady: boolean;
};

/** «Добавить сервер» (§8.3): форма → план команд и DNS-записей; выполнение — только вживую. */
export function AddServer({
  open,
  onOpenChange,
  machine,
  product,
  live,
  console,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  machine: string;
  product: string;
  live: boolean;
  console: Console;
}) {
  const toast = useToast();
  const [form, setForm] = useState<Form>({
    id: '',
    ip: '',
    product,
    country: '',
    titleRu: '',
    titleEn: '',
    app: '',
    rtc: '',
    turn: '',
    maxRooms: '4',
    uplinkMbps: '500',
    cores: '2',
    ssh: '',
    sshKey: '',
    dnsReady: false,
  });
  const set = (key: keyof Form) => (event: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: event.target.value }));
  const payload = () => ({
    ...form,
    app: form.app || undefined,
    rtc: form.rtc || undefined,
    turn: form.turn || undefined,
    ssh: form.ssh || undefined,
    sshKey: form.sshKey || undefined,
    maxRooms: Number(form.maxRooms),
    uplinkMbps: Number(form.uplinkMbps),
    cores: Number(form.cores),
  });
  const plan = useMutation({
    mutationFn: (dryRun: boolean) =>
      fleet.post<AddServerPlan>(`/nodes/${machine}/add`, { form: payload(), dryRun }),
  });
  const result = plan.data;
  const copy = async () => {
    if (!result) return;
    await navigator.clipboard?.writeText(result.plan.join('\n'));
    toast.add({ title: text.app.copied });
  };
  const preview = `${form.id || 'id'}.${form.product || 'cordcam.ru'}`;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={text.nodes.form.title}
      size="lg"
      footer={
        <>
          <Button variant="quiet" onClick={() => onOpenChange(false)}>
            {text.app.close}
          </Button>
          <Button variant="secondary" loading={plan.isPending} onClick={() => plan.mutate(true)}>
            {text.nodes.form.plan}
          </Button>
          {result && (
            <Button variant="quiet" onClick={() => void copy()}>
              {text.app.copy}
            </Button>
          )}
          <Button
            variant="danger"
            disabled={!live || !result}
            title={live ? undefined : text.nodes.form.runDisabled}
            onClick={() =>
              plan.mutate(false, {
                onSuccess: (data) => {
                  if (data.job) {
                    onOpenChange(false);
                    console.go(`/jobs/${data.job.id}`);
                  }
                },
              })
            }
          >
            {text.nodes.form.run}
          </Button>
        </>
      }
    >
      <div className="admin-form-grid">
        <Field label={text.nodes.form.id}>
          <Input value={form.id} onChange={set('id')} placeholder="hel" autoComplete="off" />
        </Field>
        <Field label={text.nodes.form.ip}>
          <Input value={form.ip} onChange={set('ip')} placeholder="152.234.227.199" autoComplete="off" />
        </Field>
        <Field label={text.nodes.form.product}>
          <Input value={form.product} onChange={set('product')} placeholder="cordcam.ru" />
        </Field>
        <Field label={text.nodes.form.country}>
          <Input value={form.country} onChange={set('country')} placeholder="FI" maxLength={2} />
        </Field>
        <Field label={text.nodes.form.titleRu}>
          <Input
            value={form.titleRu}
            onChange={set('titleRu')}
            placeholder={text.nodes.form.titleRuPlaceholder}
          />
        </Field>
        <Field label={text.nodes.form.titleEn}>
          <Input value={form.titleEn} onChange={set('titleEn')} placeholder="Helsinki" />
        </Field>
        <Field label={text.nodes.form.app}>
          <Input value={form.app} onChange={set('app')} placeholder={preview} />
        </Field>
        <Field label={text.nodes.form.rtc}>
          <Input value={form.rtc} onChange={set('rtc')} placeholder={`rtc-${preview}`} />
        </Field>
        <Field label={text.nodes.form.turn}>
          <Input value={form.turn} onChange={set('turn')} placeholder={`turn-${preview}`} />
        </Field>
        <Field label={text.nodes.form.maxRooms}>
          <Input inputMode="numeric" value={form.maxRooms} onChange={set('maxRooms')} />
        </Field>
        <Field label={text.nodes.form.uplinkMbps}>
          <Input inputMode="numeric" value={form.uplinkMbps} onChange={set('uplinkMbps')} />
        </Field>
        <Field label={text.nodes.form.cores}>
          <Input inputMode="numeric" value={form.cores} onChange={set('cores')} />
        </Field>
        <Field label={text.nodes.form.ssh}>
          <Input value={form.ssh} onChange={set('ssh')} placeholder={`root@${form.ip || '…'}`} />
        </Field>
        <Field label={text.nodes.form.sshKey}>
          <Input value={form.sshKey} onChange={set('sshKey')} placeholder="/root/.ssh/cord_fi" />
        </Field>
      </div>
      <Switch
        checked={form.dnsReady}
        onCheckedChange={(dnsReady) => setForm((f) => ({ ...f, dnsReady }))}
        label={text.nodes.form.dnsReady}
        description={text.nodes.form.dnsHint}
      />
      <ErrorLine error={plan.error} />
      {result && (
        <div className="admin-plan">
          <h3>{text.nodes.form.planTitle}</h3>
          <p className="admin-hint">{text.nodes.form.dns}</p>
          <pre className="admin-log">
            {result.dns.map((r) => `${r.name.padEnd(28)} ${r.type} ${r.value}\n`)}
          </pre>
          <p className="admin-hint">
            {text.nodes.form.commands} <code>{result.installDir}</code>
          </p>
          <pre className="admin-log">{result.plan.map((line) => `${line}\n`)}</pre>
          <p className="admin-hint">{text.nodes.form.after}</p>
        </div>
      )}
    </Dialog>
  );
}
