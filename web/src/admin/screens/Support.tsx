import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ChevronRight, Inbox } from 'lucide-react';
import {
  Button,
  Drawer,
  Field,
  Input,
  PHONE_QUERY,
  Segmented,
  Select,
  Textarea,
  useMediaQuery,
} from '../../ui/kit';
import { text } from '../../i18n/admin/ru';
import {
  fleet,
  type Boxed,
  type SupportCounts,
  type SupportInbox,
  type SupportNote,
  type SupportStats,
  type SupportTicket,
  type TicketPriority,
  type TicketStatus,
} from '../api';
import type { Console } from '../AdminApp';
import { Empty, ErrorLine, Panel, Pill, Skeleton, Stat, Stats, duration, type Tone } from '../parts';

const t = text.support;

type Tab = 'INBOX' | TicketStatus;
type Sort = 'NEW' | 'OLD' | 'PRIORITY';

const TABS: Tab[] = ['INBOX', 'NEW', 'OPEN', 'WAITING', 'DONE', 'ARCHIVED'];
const PRIORITY_TONE: Record<TicketPriority, Tone> = {
  urgent: 'bad',
  high: 'warn',
  normal: 'neutral',
  low: 'neutral',
};
const STATUS_TONE: Record<TicketStatus, Tone> = {
  NEW: 'accent',
  OPEN: 'warn',
  WAITING: 'neutral',
  DONE: 'ok',
  ARCHIVED: 'neutral',
};

const COUNT_OF: Record<TicketStatus, keyof SupportCounts> = {
  NEW: 'fresh',
  OPEN: 'open',
  WAITING: 'waiting',
  DONE: 'done',
  ARCHIVED: 'archived',
};

/** Ссылка ответа по контакту человека: `@ник` — Telegram, почта — письмо, номер — звонок. */
export function contactLink(contact: string | null): { href: string; label: string } | null {
  if (!contact) return null;
  const value = contact.trim();
  const handle = /^@?([A-Za-z0-9_]{5,32})$/.exec(value);
  if (value.startsWith('@') && handle) return { href: `https://t.me/${handle[1]}`, label: t.writeTelegram };
  const tme = /^(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]{5,32})\/?$/.exec(value);
  if (tme) return { href: `https://t.me/${tme[1]}`, label: t.writeTelegram };
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return { href: `mailto:${value}`, label: t.writeMail };
  const digits = value.replace(/[^\d+]/g, '');
  if (/^\+?\d{10,15}$/.test(digits)) return { href: `tel:${digits}`, label: t.call };
  return null;
}

/** Срок SLA словами: «осталось 2 ч 10 мин», «просрочено 1 ч», «часы стоят», «в срок». */
export function slaText(ticket: SupportTicket, now: number): { text: string; tone?: 'bad' | 'warn' | 'ok' } {
  if (ticket.slaMet !== null)
    return ticket.slaMet ? { text: t.met, tone: 'ok' } : { text: t.missed, tone: 'warn' };
  if (ticket.status === 'WAITING') return { text: t.paused };
  const due =
    ticket.firstResponseAt === null
      ? Math.min(ticket.firstResponseDueAt, ticket.resolveDueAt)
      : ticket.resolveDueAt;
  const left = due - now;
  if (ticket.breached || left < 0)
    return { text: `${t.breached} ${duration(Math.abs(left) / 1000)}`, tone: 'bad' };
  return { text: `${t.dueIn} ${duration(left / 1000)}`, tone: left < 3_600_000 ? 'warn' : undefined };
}

function when(ms: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * «Обращения» (R215): все обращения людей со всей системы — ядро каждой машины отдаёт свой ящик, пульт склеивает.
 * Вкладки-статусы со счётчиками, фильтры и поиск, SLA, назначение, лента заметок и ответов, архив.
 */
export function Support({ console }: { console: Console }) {
  const cores = console.machines.filter((m) => m.core?.credential);
  const [tab, setTab] = useState<Tab>('INBOX');
  const [machine, setMachine] = useState('');
  const [topic, setTopic] = useState('');
  const [priority, setPriority] = useState('');
  const [assignee, setAssignee] = useState('');
  const [overdue, setOverdue] = useState(false);
  const [sort, setSort] = useState<Sort>('NEW');
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  const [opened, setOpened] = useState<{ machine: string; id: string } | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setQ(typed.trim()), 300);
    return () => clearTimeout(timer);
  }, [typed]);
  const filters = {
    status: tab === 'INBOX' ? undefined : tab,
    machine: machine || undefined,
    topic: topic || undefined,
    priority: priority || undefined,
    assignee: assignee || undefined,
    overdue: overdue || undefined,
    sort,
    q: q || undefined,
    limit: 50,
  };
  const inbox = useInfiniteQuery({
    queryKey: ['support', filters],
    queryFn: ({ pageParam }) => fleet.get<SupportInbox>('/support', { ...filters, before: pageParam }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) =>
      last.more && sort === 'NEW' && last.tickets.length ? last.tickets.at(-1)!.createdAt : undefined,
    refetchInterval: 30_000,
  });
  const counts = useQuery({
    queryKey: ['support-counts'],
    queryFn: () =>
      fleet.get<{ total: SupportCounts; machines: Record<string, Boxed<SupportCounts>> }>('/support/counts'),
    refetchInterval: 30_000,
  });
  const stats = useQuery({
    queryKey: ['support-stats'],
    queryFn: () =>
      fleet.get<{ days: number; machines: Record<string, Boxed<SupportStats>> }>('/support/stats', {
        days: 30,
      }),
    staleTime: 60_000,
  });
  const total = counts.data?.total;
  const pages = inbox.data?.pages ?? [];
  const tickets = pages.flatMap((page) => page.tickets);
  const errors = pages[0]?.errors ?? [];
  const skipped = pages[0]?.skipped ?? [];
  const now = Date.now();
  const phone = useMediaQuery(PHONE_QUERY);
  const filterFields = (
    <>
      {cores.length > 1 && (
        <Field label={t.machine} inline>
          <Select value={machine} onChange={(event) => setMachine(event.target.value)}>
            <option value="">{t.allMachines}</option>
            {cores.map((m) => (
              <option key={m.id} value={m.id}>
                {m.product ?? m.title}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field label={t.topic} inline>
        <Select value={topic} onChange={(event) => setTopic(event.target.value)}>
          <option value="">{t.anyTopic}</option>
          {Object.entries(t.topics).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t.priority} inline>
        <Select value={priority} onChange={(event) => setPriority(event.target.value)}>
          <option value="">{t.anyPriority}</option>
          {Object.entries(t.priorities).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t.assignee} inline>
        <Select value={assignee} onChange={(event) => setAssignee(event.target.value)}>
          <option value="">{t.anyone}</option>
          <option value="-">{t.nobody}</option>
          <option value="owner">{t.authors.owner}</option>
          <option value="agent">{t.authors.agent}</option>
        </Select>
      </Field>
      <Field label={t.sort} inline>
        <Select value={sort} onChange={(event) => setSort(event.target.value as Sort)}>
          {Object.entries(t.sorts).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </Select>
      </Field>
    </>
  );
  return (
    <div className="admin-stack">
      <Panel title={text.nav.support} flush>
        <div className="admin-scroll-x">
          <Segmented<Tab>
            aria-label={t.all}
            value={tab}
            onValueChange={setTab}
            options={TABS.map((value) => ({
              value,
              label:
                value === 'INBOX'
                  ? t.all
                  : `${t.statuses[value]}${total ? ` · ${total[COUNT_OF[value]]}` : ''}`,
              title: value === 'INBOX' ? t.allHint : undefined,
            }))}
          />
        </div>
        <div className="admin-filters">
          <Field label={t.searchLabel} inline className="admin-search">
            <Input
              type="search"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              placeholder={t.search}
            />
          </Field>
          <Button
            variant={overdue ? 'danger' : 'secondary'}
            size="sm"
            aria-pressed={overdue}
            onClick={() => setOverdue(!overdue)}
          >
            {t.overdue}
            {total ? ` · ${total.breached}` : ''}
          </Button>
          {!phone && filterFields}
        </div>
        {phone && (
          <details className="admin-more">
            <summary>
              <ChevronRight size={16} aria-hidden="true" />
              {t.filters}
            </summary>
            <div className="admin-filters">{filterFields}</div>
          </details>
        )}
        {errors.map((error) => (
          <ErrorLine key={error.machine} error={new Error(`${error.machine}: ${error.detail}`)} />
        ))}
        {skipped.length > 0 && (
          <p className="admin-hint">
            {t.skipped} {skipped.join(', ')}
          </p>
        )}
        <ErrorLine
          error={inbox.error}
          onRetry={() => void inbox.refetch()}
          updatedAt={inbox.data ? inbox.dataUpdatedAt : undefined}
        />
        {inbox.isPending && <Skeleton rows={5} />}
        {inbox.data && tickets.length === 0 && <Empty icon={<Inbox />}>{t.empty}</Empty>}
        {tickets.length > 0 && (
          <div className="admin-table-wrap">
            <table className="admin-table" data-stack>
              <thead>
                <tr>
                  <th>{t.message}</th>
                  <th>{t.number}</th>
                  <th>{t.contact}</th>
                  <th>{t.priority}</th>
                  <th>{t.assignee}</th>
                  <th>{t.sla}</th>
                  <th>{t.created}</th>
                </tr>
              </thead>
              <tbody>
                {tickets.map((ticket) => {
                  const sla = slaText(ticket, now);
                  return (
                    <tr
                      key={`${ticket.machine}:${ticket.id}`}
                      className="admin-table__row"
                      tabIndex={0}
                      onClick={() => setOpened({ machine: ticket.machine, id: ticket.id })}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setOpened({ machine: ticket.machine, id: ticket.id });
                        }
                      }}
                    >
                      <td className="admin-ticket__summary" data-primary data-wrap>
                        <span className="admin-row">
                          <strong>{t.topics[ticket.topic] ?? ticket.topic}</strong>
                          {tab === 'INBOX' && (
                            <Pill tone={STATUS_TONE[ticket.status]}>{t.status[ticket.status]}</Pill>
                          )}
                        </span>
                        <div className="admin-ticket__text">
                          {ticket.message || ticket.issues.map((i) => t.issues[i] ?? i).join(', ')}
                        </div>
                        {ticket.tags.length > 0 && (
                          <div className="admin-chips">
                            {ticket.tags.map((tag) => (
                              <Pill key={tag}>{tag}</Pill>
                            ))}
                          </div>
                        )}
                      </td>
                      <td data-label={t.number}>
                        <code>{ticket.number}</code>
                        <span className="admin-sub">{ticket.product ?? ticket.machineTitle}</span>
                      </td>
                      <td data-label={t.contact}>
                        {ticket.contact ?? <span className="admin-hint">{t.noContact}</span>}
                      </td>
                      <td data-label={t.priority}>
                        <Pill tone={PRIORITY_TONE[ticket.priority]}>{t.priorities[ticket.priority]}</Pill>
                      </td>
                      <td data-label={t.assignee}>
                        {ticket.assignee ?? <span className="admin-hint">—</span>}
                      </td>
                      <td data-label={t.sla} data-tone={sla.tone}>
                        {sla.text}
                      </td>
                      <td data-label={t.created}>{when(ticket.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {inbox.hasNextPage && (
          <Button
            variant="secondary"
            size="sm"
            loading={inbox.isFetchingNextPage}
            onClick={() => void inbox.fetchNextPage()}
          >
            {t.more}
          </Button>
        )}
      </Panel>
      <StatsPanel stats={stats.data?.machines} />
      <TicketDrawer opened={opened} onClose={() => setOpened(null)} />
    </div>
  );
}

function StatsPanel({ stats }: { stats?: Record<string, Boxed<SupportStats>> }) {
  if (!stats) return null;
  const rows = Object.entries(stats).filter(([, box]) => box.data);
  if (rows.length === 0) return null;
  return (
    <Panel title={t.stats}>
      {rows.map(([machine, box]) => {
        const s = box.data!;
        return (
          <div key={machine} className="admin-stack">
            {rows.length > 1 && <h3 className="admin-subhead">{machine}</h3>}
            <Stats>
              <Stat value={s.created} label={t.statsCreated} />
              <Stat value={s.resolved} label={t.statsResolved} />
              <Stat value={minutes(s.firstResponseMedianMinutes)} label={t.statsFirst} compact />
              <Stat value={minutes(s.resolveMedianMinutes)} label={t.statsResolve} compact />
              <Stat
                value={s.withinSla === null ? '—' : `${Math.round(s.withinSla * 100)} %`}
                label={t.statsWithin}
                tone={s.withinSla !== null && s.withinSla < 0.8 ? 'warn' : undefined}
              />
            </Stats>
            {Object.keys(s.topics).length > 0 && (
              <p className="admin-hint">
                {Object.entries(s.topics)
                  .sort((a, b) => b[1] - a[1])
                  .map(([topic, n]) => `${t.topics[topic] ?? topic}: ${n}`)
                  .join(' · ')}
              </p>
            )}
          </div>
        );
      })}
    </Panel>
  );
}

function minutes(value: number | null): string {
  return value === null ? '—' : duration(value * 60);
}

type Opened = { ticket: SupportTicket; notes: SupportNote[] };

function TicketDrawer({
  opened,
  onClose,
}: {
  opened: { machine: string; id: string } | null;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const key = ['support-ticket', opened?.machine, opened?.id];
  const ticket = useQuery({
    queryKey: key,
    queryFn: () => fleet.get<Opened>(`/support/${opened!.machine}/${opened!.id}`),
    enabled: !!opened,
  });
  const refresh = () => {
    void client.invalidateQueries({ queryKey: key });
    void client.invalidateQueries({ queryKey: ['support'] });
    void client.invalidateQueries({ queryKey: ['support-counts'] });
  };
  const base = opened ? `/support/${opened.machine}/${opened.id}` : '';
  const status = useMutation({
    mutationFn: (next: TicketStatus) => fleet.put(`${base}/status`, { status: next }),
    onSuccess: refresh,
  });
  const update = useMutation({
    mutationFn: (body: { assignee?: string; priority?: TicketPriority; tags?: string }) =>
      fleet.put(base, body),
    onSuccess: refresh,
  });
  const [kind, setKind] = useState<'note' | 'reply'>('note');
  const [note, setNote] = useState('');
  const [assignee, setAssignee] = useState('');
  const [tags, setTags] = useState('');
  const data = ticket.data;
  useEffect(() => {
    setAssignee(data?.ticket.assignee ?? '');
    setTags(data?.ticket.tags.join(' ') ?? '');
  }, [data?.ticket.assignee, data?.ticket.tags]);
  useEffect(() => {
    setNote('');
    setKind('note');
  }, [opened?.id]);
  const add = useMutation({
    mutationFn: () => fleet.post(`${base}/notes`, { kind, text: note }),
    onSuccess: () => {
      setNote('');
      refresh();
    },
  });
  const current = data?.ticket;
  const link = contactLink(current?.contact ?? null);
  return (
    <Drawer
      open={!!opened}
      onOpenChange={(open) => !open && onClose()}
      title={
        current ? `${t.ticket} ${current.number} · ${t.topics[current.topic] ?? current.topic}` : t.ticket
      }
      height="85"
      closeLabel={text.app.close}
    >
      <ErrorLine error={ticket.error} onRetry={() => void ticket.refetch()} />
      {ticket.isPending && <Skeleton rows={4} />}
      {current && (
        <div className="admin-stack admin-ticket">
          <div className="admin-row">
            <Pill tone={current.breached ? 'bad' : STATUS_TONE[current.status]} dot>
              {t.status[current.status]}
            </Pill>
            <Pill tone={PRIORITY_TONE[current.priority]}>{t.priorities[current.priority]}</Pill>
            <span className="admin-hint">
              {current.product ?? current.machineTitle} · {when(current.createdAt)}
            </span>
          </div>
          <div className="admin-actions">
            {current.status !== 'OPEN' && current.status !== 'ARCHIVED' && (
              <Button size="sm" onClick={() => status.mutate('OPEN')} loading={status.isPending}>
                {current.status === 'NEW' ? t.take : t.reopen}
              </Button>
            )}
            {current.status !== 'WAITING' && current.status !== 'ARCHIVED' && (
              <Button size="sm" variant="secondary" onClick={() => status.mutate('WAITING')}>
                {t.wait}
              </Button>
            )}
            {current.status !== 'DONE' && current.status !== 'ARCHIVED' && (
              <Button size="sm" variant="secondary" onClick={() => status.mutate('DONE')}>
                {t.resolve}
              </Button>
            )}
            {current.status !== 'ARCHIVED' ? (
              <Button size="sm" variant="quiet" onClick={() => status.mutate('ARCHIVED')}>
                {t.archive}
              </Button>
            ) : (
              <Button size="sm" variant="secondary" onClick={() => status.mutate('OPEN')}>
                {t.reopen}
              </Button>
            )}
            {current.status !== 'NEW' && current.status !== 'ARCHIVED' && (
              <Button size="sm" variant="quiet" onClick={() => status.mutate('NEW')}>
                {t.toNew}
              </Button>
            )}
          </div>
          <ErrorLine error={status.error ?? update.error} />
          <p className="admin-ticket__message">{current.message}</p>
          {current.issues.length > 0 && (
            <p>
              <strong>{t.issuesTitle}:</strong> {current.issues.map((i) => t.issues[i] ?? i).join(', ')}
            </p>
          )}
          <dl className="admin-dl">
            <dt>{t.contact}</dt>
            <dd>
              {current.contact ?? t.noContact}
              {link && (
                <>
                  {' · '}
                  <a href={link.href} target="_blank" rel="noreferrer noopener">
                    {link.label}
                  </a>
                </>
              )}
            </dd>
            <dt>{t.firstDue}</dt>
            <dd>{when(current.firstResponseDueAt)}</dd>
            <dt>{t.firstAt}</dt>
            <dd>{when(current.firstResponseAt)}</dd>
            <dt>{t.resolveDue}</dt>
            <dd>{when(current.resolveDueAt)}</dd>
            <dt>{t.resolvedAt}</dt>
            <dd>{when(current.resolvedAt)}</dd>
            {current.pausedMs > 0 && (
              <>
                <dt>{t.pausedFor}</dt>
                <dd>{duration(current.pausedMs / 1000)}</dd>
              </>
            )}
            <dt>{t.sla}</dt>
            <dd data-tone={slaText(current, Date.now()).tone}>{slaText(current, Date.now()).text}</dd>
          </dl>
          <p className="admin-hint">{t.meetingsAround}</p>
          <div className="admin-filters">
            <Field label={t.assignee} inline>
              <Input value={assignee} onChange={(event) => setAssignee(event.target.value)} maxLength={40} />
            </Field>
            <Button size="sm" variant="quiet" onClick={() => update.mutate({ assignee: 'owner' })}>
              {t.assignMe}
            </Button>
            <Field label={t.priority} inline>
              <Select
                value={current.priority}
                onChange={(event) => update.mutate({ priority: event.target.value as TicketPriority })}
              >
                {Object.entries(t.priorities).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t.tags} inline>
              <Input value={tags} onChange={(event) => setTags(event.target.value)} maxLength={200} />
            </Field>
            <Button
              size="sm"
              variant="secondary"
              loading={update.isPending}
              onClick={() => update.mutate({ assignee, tags })}
            >
              {t.save}
            </Button>
          </div>
          {current.diagnostics && <Diagnostics raw={current.diagnostics} />}
          <section aria-label={t.timeline}>
            <h3 className="admin-subhead">{t.timeline}</h3>
            {data!.notes.length === 0 ? (
              <Empty>{t.noNotes}</Empty>
            ) : (
              <ol className="admin-timeline">
                {data!.notes.map((n) => (
                  <li key={n.id} data-kind={n.kind}>
                    <span className="admin-hint">
                      {when(n.createdAt)} · {t.authors[n.author] ?? n.author} · {t.kinds[n.kind] ?? n.kind}
                    </span>
                    <div>
                      {n.kind === 'status'
                        ? (t.status[n.text.toUpperCase()] ?? n.text)
                        : n.kind === 'priority'
                          ? (t.priorities[n.text] ?? n.text)
                          : n.text}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>
          <section className="admin-stack">
            <Segmented<'note' | 'reply'>
              aria-label={t.noteKind}
              value={kind}
              onValueChange={setKind}
              options={[
                { value: 'note', label: t.noteSelf },
                { value: 'reply', label: t.noteReply, title: t.noteReplyHint },
              ]}
            />
            {kind === 'reply' && <p className="admin-hint">{t.noteReplyHint}</p>}
            <Field label={t.templates}>
              <Select
                value=""
                onChange={(event) => {
                  const template = event.target.value;
                  if (template) setNote((current) => (current ? `${current}\n${template}` : template));
                }}
              >
                <option value="">—</option>
                {t.templateList.map((template) => (
                  <option key={template} value={template}>
                    {template.length > 60 ? `${template.slice(0, 60)}…` : template}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t.noteText}>
              <Textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={4}
                maxLength={4000}
              />
            </Field>
            <ErrorLine error={add.error} />
            <div className="admin-actions">
              <Button onClick={() => add.mutate()} disabled={!note.trim()} loading={add.isPending}>
                {t.add}
              </Button>
            </div>
          </section>
        </div>
      )}
    </Drawer>
  );
}

/** Диагностика, которую человек приложил сам: JSON — таблицей, иначе — как есть. */
function Diagnostics({ raw }: { raw: string }) {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const entries =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.entries(parsed as Record<string, unknown>)
      : null;
  return (
    <details className="admin-diagnostics">
      <summary>{t.diagnostics}</summary>
      {entries ? (
        <dl className="admin-dl">
          {entries.map(([key, value]) => (
            <div key={key} className="admin-dl__pair">
              <dt>{key}</dt>
              <dd>
                {typeof value === 'object' ? <pre>{JSON.stringify(value, null, 2)}</pre> : String(value)}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <pre>{raw}</pre>
      )}
    </details>
  );
}
