import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity as ActivityIcon, Ban, LogOut, RefreshCw, ShieldOff } from 'lucide-react';
import type { Translate } from '../../i18n';
import { locale } from '../../i18n';
import { ApiError } from '../../api/client';
import { formatCode } from '../../core/invitation';
import { formatDuration } from '../../core/meeting-clock';
import {
  actionKey,
  activityApi,
  adminToken,
  forgetAdmin,
  login,
  needsLogin,
  type AuditEvent,
  type AuditFilter,
  type Block,
  type LiveRoom,
  type Now,
  type ServerInfo,
  type Summary,
} from '../../core/activity';
import { SupportTab } from './SupportTab';
import { QualityTab } from './QualityTab';
import { Button, Field, Input, Select, Tab, TabList, TabPanel, Tabs } from '../kit';
import { Logo } from '../primitives';
import { Bars } from './Bars';
import './activity.css';

/**
 * «Активность» — страница владельца сервера (`/activity`, E10-B, docs/observability.md §12).
 *
 * Встречи сейчас и за период, журнал аудита, блокировки и рычаги: завершить встречу, заблокировать её
 * создателя или адрес из строки журнала, снять «щит». Всё это — своя статистика ядра в PostgreSQL;
 * профиль `monitoring` для страницы не нужен (графики машины и SFU — в Grafana).
 *
 * Вход — паролем владельца (`ADMIN_PASSWORD`). Пароля на сервере нет — страница так и говорит.
 */
export function Activity() {
  const { t } = useTranslation();
  const [signedIn, setSignedIn] = useState(() => adminToken() !== null);
  useEffect(() => {
    document.documentElement.dataset.theme = localStorage.getItem('cord:theme') || 'system';
    document.title = t(($) => $.activity.title);
  }, [t]);
  const signOut = useCallback(() => {
    forgetAdmin();
    setSignedIn(false);
  }, []);
  return (
    <div className="activity-page">
      <header className="activity-header">
        <Logo />
        <h1>
          <ActivityIcon size={20} aria-hidden="true" />
          {t(($) => $.activity.title)}
        </h1>
        {signedIn && (
          <Button variant="quiet" size="sm" icon={<LogOut size={16} />} onClick={signOut}>
            {t(($) => $.activity.signOut)}
          </Button>
        )}
      </header>
      {signedIn ? <Board onExpired={signOut} /> : <Login onDone={() => setSignedIn(true)} />}
    </div>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(password);
      onDone();
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.code === 'ADMIN_DISABLED'
          ? t(($) => $.activity.disabled)
          : failure instanceof Error
            ? failure.message
            : t(($) => $.api.requestFailed),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="activity-login" onSubmit={submit}>
      <p>{t(($) => $.activity.loginHint)}</p>
      <Field label={t(($) => $.activity.password)} error={error}>
        <Input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
          autoFocus
        />
      </Field>
      <Button type="submit" variant="primary" loading={busy}>
        {t(($) => $.activity.signIn)}
      </Button>
    </form>
  );
}

/** Запрос к странице владельца: истёкший токен возвращает на вход, остальное — текстом отказа. */
export function useAdmin(onExpired: () => void) {
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async <T,>(call: () => Promise<T>): Promise<T | undefined> => {
      try {
        const result = await call();
        setError(null);
        return result;
      } catch (failure) {
        if (needsLogin(failure)) onExpired();
        else setError(failure instanceof Error ? failure.message : String(failure));
        return undefined;
      }
    },
    [onExpired],
  );
  return { run, error };
}

function Board({ onExpired }: { onExpired: () => void }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'now' | 'meetings' | 'quality' | 'audit' | 'blocks' | 'support' | 'server'>(
    'now',
  );
  return (
    <Tabs variant="line" value={tab} onValueChange={(value) => setTab(value as typeof tab)}>
      <TabList className="activity-tabs" aria-label={t(($) => $.activity.title)}>
        <Tab value="now">{t(($) => $.activity.tabs.now)}</Tab>
        <Tab value="meetings">{t(($) => $.activity.tabs.meetings)}</Tab>
        <Tab value="quality">{t(($) => $.activity.tabs.quality)}</Tab>
        <Tab value="audit">{t(($) => $.activity.tabs.audit)}</Tab>
        <Tab value="blocks">{t(($) => $.activity.tabs.blocks)}</Tab>
        <Tab value="support">{t(($) => $.activity.tabs.support)}</Tab>
        <Tab value="server">{t(($) => $.activity.tabs.server)}</Tab>
      </TabList>
      <TabPanel value="now">{tab === 'now' && <NowTab onExpired={onExpired} />}</TabPanel>
      <TabPanel value="meetings">{tab === 'meetings' && <MeetingsTab onExpired={onExpired} />}</TabPanel>
      <TabPanel value="quality">{tab === 'quality' && <QualityTab onExpired={onExpired} />}</TabPanel>
      <TabPanel value="audit">{tab === 'audit' && <AuditTab onExpired={onExpired} />}</TabPanel>
      <TabPanel value="blocks">{tab === 'blocks' && <BlocksTab onExpired={onExpired} />}</TabPanel>
      <TabPanel value="support">{tab === 'support' && <SupportTab onExpired={onExpired} />}</TabPanel>
      <TabPanel value="server">{tab === 'server' && <ServerTab onExpired={onExpired} />}</TabPanel>
    </Tabs>
  );
}

export function Tile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="activity-tile">
      <span className="activity-tile__value">{value}</span>
      <span className="activity-tile__label">{label}</span>
    </div>
  );
}

export function Failure({ text }: { text: string | null }) {
  return text ? (
    <p className="activity-error" role="alert">
      {text}
    </p>
  ) : null;
}

const integrationLabel = (t: Translate, kind: string) =>
  kind === 'watch' ||
  kind === 'music' ||
  kind === 'poker' ||
  kind === 'durak' ||
  kind === 'chess' ||
  kind === 'gartic'
    ? t(($) => $.activity.integrations[kind])
    : kind;

function NowTab({ onExpired }: { onExpired: () => void }) {
  const { t } = useTranslation();
  const { run, error } = useAdmin(onExpired);
  const [now, setNow] = useState<Now | null>(null);
  const [asked, setAsked] = useState<string | null>(null);
  const load = useCallback(() => run(activityApi.now).then((value) => value && setNow(value)), [run]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);
  const close = async (room: LiveRoom, block: boolean) => {
    const key = `${room.id}:${block}`;
    if (asked !== key) {
      setAsked(key);
      return;
    }
    setAsked(null);
    const value = await run(() => activityApi.close(room.id, block));
    if (value) setNow(value);
  };
  if (!now) return <Failure text={error} />;
  return (
    <section className="activity-section">
      <div className="activity-tiles">
        <Tile label={t(($) => $.activity.now.live)} value={now.live} />
        <Tile label={t(($) => $.activity.now.waiting)} value={now.waiting} />
        <Tile label={t(($) => $.activity.now.humans)} value={now.humans} />
        <Tile label={t(($) => $.activity.now.connected)} value={now.connected} />
        <Tile label={t(($) => $.activity.now.bots)} value={now.bots} />
        <Tile label={t(($) => $.activity.now.screens)} value={now.screens} />
      </div>
      <Failure text={error} />
      {now.rooms.length === 0 ? (
        <p className="activity-empty">{t(($) => $.activity.now.empty)}</p>
      ) : (
        <div className="activity-table-wrap">
          <table className="activity-table">
            <thead>
              <tr>
                <th scope="col">{t(($) => $.activity.now.code)}</th>
                <th scope="col">{t(($) => $.activity.now.duration)}</th>
                <th scope="col">{t(($) => $.activity.now.people)}</th>
                <th scope="col">{t(($) => $.activity.now.integrations)}</th>
                <th scope="col">
                  <span className="visually-hidden">{t(($) => $.activity.now.actions)}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {now.rooms.map((room) => (
                <tr key={room.id}>
                  <td className="activity-mono">{formatCode(room.code)}</td>
                  <td>
                    {room.startedAt === null
                      ? t(($) => $.activity.now.notStarted)
                      : formatDuration(now.serverTime - room.startedAt)}
                  </td>
                  <td>
                    {t(($) => $.activity.now.peopleValue, {
                      humans: room.humans,
                      connected: room.connected,
                    })}
                    {room.waiting > 0 && ` · ${t(($) => $.activity.now.atDoor, { count: room.waiting })}`}
                    {room.bots > 0 && ` · ${t(($) => $.activity.now.botsValue, { count: room.bots })}`}
                  </td>
                  <td>{room.integrations.map((kind) => integrationLabel(t, kind)).join(', ') || '—'}</td>
                  <td className="activity-actions">
                    <Button size="sm" variant="secondary" onClick={() => void close(room, false)}>
                      {asked === `${room.id}:false`
                        ? t(($) => $.activity.now.sure)
                        : t(($) => $.activity.now.close)}
                    </Button>
                    {room.createdHere && (
                      <Button
                        size="sm"
                        variant="danger"
                        icon={<Ban size={14} />}
                        onClick={() => void close(room, true)}
                      >
                        {asked === `${room.id}:true`
                          ? t(($) => $.activity.now.sure)
                          : t(($) => $.activity.now.closeAndBlock)}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const PERIODS = { day: 1, week: 7, month: 30 } as const;
type Period = keyof typeof PERIODS;

function hours(t: Translate, seconds: number) {
  return new Intl.NumberFormat(locale(t), { maximumFractionDigits: 1 }).format(seconds / 3600);
}

function MeetingsTab({ onExpired }: { onExpired: () => void }) {
  const { t } = useTranslation();
  const { run, error } = useAdmin(onExpired);
  const [period, setPeriod] = useState<Period>('week');
  const [summary, setSummary] = useState<Summary | null>(null);
  useEffect(() => {
    const to = Date.now();
    const from = to - PERIODS[period] * 86_400_000;
    void run(() => activityApi.meetings(from, to)).then((value) => value && setSummary(value));
  }, [period, run]);
  const days = useMemo(() => {
    if (!summary) return [];
    const format = new Intl.DateTimeFormat(locale(t), { day: 'numeric', month: 'short' });
    return summary.days.map((day) => ({
      key: day.day,
      label: format.format(new Date(`${day.day}T12:00:00`)),
      value: day.meetings,
      tip: t(($) => $.activity.meetings.dayTip, {
        count: day.meetings,
        hours: hours(t, day.humanSeconds),
        peak: day.peakHumans,
      }),
    }));
  }, [summary, t]);
  const durations = useMemo(
    () =>
      (summary?.durations ?? []).map((bucket, index, all) => {
        const label =
          bucket.upToSeconds < 0
            ? t(($) => $.activity.meetings.longer, {
                duration: formatDuration((all[index - 1]?.upToSeconds ?? 0) * 1000),
              })
            : t(($) => $.activity.meetings.upTo, { duration: formatDuration(bucket.upToSeconds * 1000) });
        return {
          key: String(bucket.upToSeconds),
          label,
          value: bucket.meetings,
          tip: t(($) => $.activity.meetings.count, { count: bucket.meetings }),
        };
      }),
    [summary, t],
  );
  return (
    <section className="activity-section">
      <div className="activity-filters" role="group" aria-label={t(($) => $.activity.meetings.period)}>
        {(Object.keys(PERIODS) as Period[]).map((key) => (
          <Button
            key={key}
            size="sm"
            variant={period === key ? 'primary' : 'secondary'}
            aria-pressed={period === key}
            onClick={() => setPeriod(key)}
          >
            {t(($) => $.activity.meetings.periods[key])}
          </Button>
        ))}
      </div>
      <Failure text={error} />
      {summary && (
        <>
          <div className="activity-tiles">
            <Tile label={t(($) => $.activity.meetings.total)} value={summary.meetings} />
            <Tile label={t(($) => $.activity.meetings.humanHours)} value={hours(t, summary.humanSeconds)} />
            <Tile
              label={t(($) => $.activity.meetings.median)}
              value={formatDuration(summary.medianSeconds * 1000)}
            />
            <Tile label={t(($) => $.activity.meetings.peak)} value={summary.peakHumans} />
            <Tile label={t(($) => $.activity.meetings.devices)} value={summary.uniqueDevices} />
            <Tile
              label={t(($) => $.activity.meetings.joins)}
              value={t(($) => $.activity.meetings.joinsValue, {
                ok: summary.joins,
                failed: summary.joinFailures,
              })}
            />
          </div>
          {summary.meetings === 0 ? (
            <p className="activity-empty">{t(($) => $.activity.meetings.empty)}</p>
          ) : (
            <div className="activity-charts">
              <Bars title={t(($) => $.activity.meetings.byDay)} items={days} />
              <Bars title={t(($) => $.activity.meetings.byDuration)} items={durations} />
              <Bars
                title={t(($) => $.activity.meetings.integrations)}
                horizontal
                items={Object.entries(summary.integrations).map(([kind, count]) => ({
                  key: kind,
                  label: integrationLabel(t, kind),
                  value: count,
                  tip: t(($) => $.activity.meetings.count, { count }),
                }))}
              />
            </div>
          )}
        </>
      )}
    </section>
  );
}

export function when(t: Translate, at: number) {
  return new Date(at).toLocaleString(locale(t), {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function AuditTab({ onExpired }: { onExpired: () => void }) {
  const { t } = useTranslation();
  const { run, error } = useAdmin(onExpired);
  const [filter, setFilter] = useState<AuditFilter>({});
  const [items, setItems] = useState<AuditEvent[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<Record<number, boolean>>({});
  const load = useCallback(
    async (cursor?: string) => {
      const page = await run(() => activityApi.audit({ ...filter, cursor }));
      if (!page) return;
      setItems((current) => (cursor ? [...current, ...page.items] : page.items));
      setNext(page.next);
    },
    [filter, run],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const block = async (event: AuditEvent) => {
    const done = await run(() =>
      event.ipHash
        ? activityApi.block({ kind: 'ip', subject: event.ipHash, reason: t(($) => $.activity.audit.reason) })
        : activityApi.block({
            kind: 'profile',
            subject: event.profileHash ?? '',
            reason: t(($) => $.activity.audit.reason),
          }),
    );
    if (done) setBlocked((current) => ({ ...current, [event.id]: true }));
  };
  return (
    <section className="activity-section">
      <div className="activity-filters">
        <Field label={t(($) => $.activity.audit.group)}>
          <Select
            value={filter.group ?? ''}
            onChange={(event) => setFilter({ ...filter, group: event.target.value || undefined })}
          >
            <option value="">{t(($) => $.activity.audit.groups.all)}</option>
            <option value="room">{t(($) => $.activity.audit.groups.room)}</option>
            <option value="participant">{t(($) => $.activity.audit.groups.participant)}</option>
            <option value="admin">{t(($) => $.activity.audit.groups.admin)}</option>
            <option value="block">{t(($) => $.activity.audit.groups.block)}</option>
          </Select>
        </Field>
        <Field label={t(($) => $.activity.audit.outcome)}>
          <Select
            value={filter.outcome ?? ''}
            onChange={(event) => setFilter({ ...filter, outcome: event.target.value || undefined })}
          >
            <option value="">{t(($) => $.activity.audit.outcomes.all)}</option>
            <option value="ok">{t(($) => $.activity.audit.outcomes.ok)}</option>
            <option value="denied">{t(($) => $.activity.audit.outcomes.denied)}</option>
          </Select>
        </Field>
        <Field label={t(($) => $.activity.audit.code)}>
          <Input
            inputMode="numeric"
            placeholder="123-456-789"
            value={filter.code ?? ''}
            onChange={(event) => {
              const digits = event.target.value.replace(/\D/g, '').slice(0, 9);
              setFilter({ ...filter, code: digits.length === 9 ? digits : undefined });
            }}
          />
        </Field>
        <Button variant="quiet" size="sm" icon={<RefreshCw size={14} />} onClick={() => void load()}>
          {t(($) => $.activity.refresh)}
        </Button>
      </div>
      <Failure text={error} />
      {items.length === 0 ? (
        <p className="activity-empty">{t(($) => $.activity.audit.empty)}</p>
      ) : (
        <div className="activity-table-wrap">
          <table className="activity-table">
            <thead>
              <tr>
                <th scope="col">{t(($) => $.activity.audit.when)}</th>
                <th scope="col">{t(($) => $.activity.audit.action)}</th>
                <th scope="col">{t(($) => $.activity.audit.who)}</th>
                <th scope="col">{t(($) => $.activity.audit.meeting)}</th>
                <th scope="col">{t(($) => $.activity.audit.address)}</th>
                <th scope="col">
                  <span className="visually-hidden">{t(($) => $.activity.now.actions)}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((event) => (
                <tr key={event.id} data-outcome={event.outcome}>
                  <td className="activity-nowrap">{when(t, event.at)}</td>
                  <td>
                    {t(($) => $.activity.audit.actions[actionKey(event.action)])}
                    {event.outcome !== 'ok' && (
                      <span className="activity-denied">
                        {' · '}
                        {t(($) => $.activity.audit.refused, { code: event.code ?? '' })}
                      </span>
                    )}
                  </td>
                  <td>{event.actorName ?? t(($) => $.activity.audit.kinds[kindKey(event.actorKind)])}</td>
                  <td className="activity-mono">{event.roomCode ? formatCode(event.roomCode) : '—'}</td>
                  <td className="activity-mono" title={t(($) => $.activity.audit.addressHint)}>
                    {event.ipHash ? event.ipHash.slice(0, 8) : '—'}
                  </td>
                  <td>
                    {(event.ipHash || event.profileHash) && !event.action.startsWith('admin.') && (
                      <Button
                        size="sm"
                        variant="quiet"
                        icon={<Ban size={14} />}
                        disabled={blocked[event.id]}
                        onClick={() => void block(event)}
                      >
                        {blocked[event.id]
                          ? t(($) => $.activity.audit.blocked)
                          : t(($) => $.activity.audit.block)}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next && (
        <Button variant="secondary" onClick={() => void load(next)}>
          {t(($) => $.activity.audit.more)}
        </Button>
      )}
    </section>
  );
}

const KINDS = ['participant', 'creator', 'host', 'bot', 'system', 'admin', 'anonymous'] as const;
const kindKey = (kind: string) =>
  (KINDS as readonly string[]).includes(kind) ? (kind as (typeof KINDS)[number]) : 'system';

function BlocksTab({ onExpired }: { onExpired: () => void }) {
  const { t } = useTranslation();
  const { run, error } = useAdmin(onExpired);
  const [blocks, setBlocks] = useState<Block[] | null>(null);
  const load = useCallback(() => run(activityApi.blocks).then((value) => value && setBlocks(value)), [run]);
  useEffect(() => {
    void load();
  }, [load]);
  const now = Date.now();
  if (!blocks) return <Failure text={error} />;
  return (
    <section className="activity-section">
      <p className="activity-hint">{t(($) => $.activity.blocks.hint)}</p>
      <Failure text={error} />
      {blocks.length === 0 ? (
        <p className="activity-empty">{t(($) => $.activity.blocks.empty)}</p>
      ) : (
        <ul className="activity-blocks">
          {blocks.map((block) => {
            const active = block.liftedAt === null && block.expiresAt > now;
            return (
              <li key={block.id} data-active={active}>
                <div>
                  <strong>
                    {block.kind === 'ip'
                      ? t(($) => $.activity.blocks.ip)
                      : t(($) => $.activity.blocks.profile)}{' '}
                    <span className="activity-mono">{block.subject.slice(0, 8)}</span>
                  </strong>
                  <span>
                    {block.createdBy === 'auto'
                      ? t(($) => $.activity.blocks.auto)
                      : t(($) => $.activity.blocks.manual)}
                    {' · '}
                    {!active
                      ? t(($) => $.activity.blocks.ended)
                      : block.expiresAt - now > 50 * 365 * 86_400_000
                        ? t(($) => $.activity.blocks.forever)
                        : t(($) => $.activity.blocks.until, { date: when(t, block.expiresAt) })}
                  </span>
                  {block.reason && <span>{block.reason}</span>}
                </div>
                {active && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void run(() => activityApi.lift(block.id)).then(() => load())}
                  >
                    {t(($) => $.activity.blocks.lift)}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function term(t: Translate, ms: number) {
  if (ms < 0) return t(($) => $.activity.server.never);
  const days = ms / 86_400_000;
  if (days >= 1) return t(($) => $.activity.server.days, { count: Math.round(days) });
  const minutes = Math.round(ms / 60_000);
  return minutes >= 60
    ? t(($) => $.activity.server.hours, { count: Math.round(minutes / 60) })
    : t(($) => $.activity.server.minutes, { count: minutes });
}

function ServerTab({ onExpired }: { onExpired: () => void }) {
  const { t } = useTranslation();
  const { run, error } = useAdmin(onExpired);
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const load = useCallback(() => run(activityApi.server).then((value) => value && setInfo(value)), [run]);
  useEffect(() => {
    void load();
  }, [load]);
  if (!info) return <Failure text={error} />;
  return (
    <section className="activity-section">
      <Failure text={error} />
      <dl className="activity-facts">
        <dt>{t(($) => $.activity.server.shield)}</dt>
        <dd>
          {info.shield ? t(($) => $.activity.server.shieldOn) : t(($) => $.activity.server.shieldOff)}
          {info.shield && (
            <Button
              size="sm"
              variant="secondary"
              icon={<ShieldOff size={14} />}
              onClick={() => void run(activityApi.clearShield).then(() => load())}
            >
              {t(($) => $.activity.server.clearShield)}
            </Button>
          )}
        </dd>
        <dt>{t(($) => $.activity.server.blocks)}</dt>
        <dd>{info.blocksActive}</dd>
        <dt>{t(($) => $.activity.server.autoBlock)}</dt>
        <dd>
          {info.autoBlockCount === null
            ? t(($) => $.activity.server.off)
            : t(($) => $.activity.server.autoBlockValue, {
                count: info.autoBlockCount,
                window: term(t, info.autoBlockWindowMs),
                term: term(t, info.autoBlockTermMs),
              })}
        </dd>
        <dt>{t(($) => $.activity.server.blockDefault)}</dt>
        <dd>{term(t, info.blockDefaultMs)}</dd>
        <dt>{t(($) => $.activity.server.retention)}</dt>
        <dd>
          {t(($) => $.activity.server.retentionValue, {
            audit: term(t, info.auditMs),
            meetings: term(t, info.meetingStatsMs),
            daily: term(t, info.activityDailyMs),
          })}
        </dd>
        <dt>{t(($) => $.activity.server.build)}</dt>
        <dd className="activity-mono">{info.build ?? '—'}</dd>
      </dl>
      <p className="activity-hint">{t(($) => $.activity.server.grafana)}</p>
      <pre className="activity-code">ssh -L 3000:127.0.0.1:3000 root@{location.hostname}</pre>
    </section>
  );
}
