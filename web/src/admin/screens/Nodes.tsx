import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Plus, Server } from 'lucide-react';
import { Button, Dialog, Field, Flag, Input, Switch, useToast } from '../../ui/kit';
import { text } from '../../i18n/admin/ru';
import { fleet, type AddServerPlan, type Job, type NodesView, type RegistryNode } from '../api';
import type { Console } from '../AdminApp';
import { Confirm, Empty, ErrorLine, Panel, Pill, Skeleton, type Tone } from '../parts';

type Action = 'drain' | 'undrain' | 'check' | 'update' | 'remove' | 'logs';

const STATE_TONE: Record<string, Tone> = {
  ok: 'ok',
  busy: 'warn',
  full: 'warn',
  down: 'bad',
  drained: 'neutral',
};

/**
 * Ступень загрузки узла палочками, как у людей в выборе узла (`LoadBars` набора), но с подписью пульта: слой
 * переводов приложения пульт не поднимает, и подпись набора осталась бы пустой.
 */
function Level({ level, state }: { level: number; state: string }) {
  const known = level >= 1 && level <= 4 && state !== 'down' && state !== 'drained';
  const filled = known ? level : 0;
  const label = `${text.nodes.level}: ${known ? `${level} ${text.nodes.of} 4` : (text.nodes.states[state] ?? state)}`;
  return (
    <span
      className="ui-load"
      role="img"
      aria-label={label}
      title={label}
      data-tone={known ? (filled >= 4 ? 'danger' : filled === 3 ? 'warning' : 'success') : undefined}
    >
      <span className="ui-load__bars" aria-hidden="true">
        {[1, 2, 3, 4].map((bar) => (
          <span key={bar} className="ui-load__bar" data-on={bar <= filled || undefined} />
        ))}
      </span>
    </span>
  );
}

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
        description={text.nodes.hint}
        flush
        actions={
          <Button variant="primary" size="sm" icon={<Plus size={16} />} onClick={() => setAdding(true)}>
            {text.nodes.add}
          </Button>
        }
      >
        <ErrorLine
          error={nodes.error}
          onRetry={() => void nodes.refetch()}
          updatedAt={data ? nodes.dataUpdatedAt : undefined}
        />
        {data?.registryError && !data.registry && <p className="admin-hint">{data.registryError}</p>}
        {data?.levels.error && (
          <p className="admin-hint">
            {text.nodes.levelsError}: {data.levels.error.detail}
          </p>
        )}
        {nodes.isPending && <Skeleton />}
        {data && registryNodes.length === 0 && (
          <Empty
            icon={<Server />}
            action={
              <Button variant="secondary" size="sm" icon={<Plus size={16} />} onClick={() => setAdding(true)}>
                {text.nodes.add}
              </Button>
            }
          >
            {text.nodes.empty}
          </Empty>
        )}
        {data && registryNodes.length > 0 && (
          <div className="admin-table-wrap">
            <table className="admin-table" data-stack>
              <thead>
                <tr>
                  <th>{text.nodes.node}</th>
                  <th>{text.nodes.state}</th>
                  <th>{text.nodes.level}</th>
                  <th data-num>{text.nodes.uplink}</th>
                  <th data-num>{text.nodes.cores}</th>
                  <th>{text.nodes.actions}</th>
                </tr>
              </thead>
              <tbody>
                {registryNodes.map((node) => {
                  const level = levels.get(node.id);
                  const drained = node.enabled === false;
                  return (
                    <tr key={node.id}>
                      <td data-primary>
                        <span className="admin-row">
                          {node.country ? <Flag country={node.country} /> : null}
                          <strong>{node.id}</strong>
                          <span className="admin-hint">{node.title?.ru ?? ''}</span>
                          {node.control && <Pill>{text.nodes.control}</Pill>}
                        </span>
                        {node.ip && <span className="admin-sub">{node.ip}</span>}
                      </td>
                      <td data-label={text.nodes.state}>
                        {drained ? (
                          <Pill dot>{text.nodes.drained}</Pill>
                        ) : level ? (
                          <Pill tone={STATE_TONE[level.state] ?? 'neutral'} dot>
                            {text.nodes.states[level.state] ?? level.state}
                          </Pill>
                        ) : (
                          <Pill dot>{text.nodes.enabled}</Pill>
                        )}
                      </td>
                      <td data-label={text.nodes.level}>
                        {level ? <Level level={level.level} state={level.state} /> : '—'}
                      </td>
                      <td data-num data-label={text.nodes.uplink}>
                        {node.uplinkMbps ?? '—'}
                      </td>
                      <td data-num data-label={text.nodes.cores}>
                        {node.cores ?? '—'}
                      </td>
                      <td data-actions>
                        <div className="admin-actions">
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
                                title={drained ? undefined : text.nodes.removeHint}
                                onClick={() => setPending({ node, action: 'remove' })}
                              >
                                {text.nodes.remove}
                              </Button>
                            </>
                          )}
                        </div>
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
      closeLabel={text.app.close}
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
