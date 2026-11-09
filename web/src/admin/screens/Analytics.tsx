import { useQuery } from '@tanstack/react-query';
import { useMemo, useState, type CSSProperties } from 'react';
import { Button, Field, HintIcon, Input, Segmented, Select } from '../../ui/kit';
import { text } from '../../i18n/admin/ru';
import { fleet, type AnalyticsMode, type AnalyticsReport, type Cohort, type Machine } from '../api';
import type { Console } from '../AdminApp';
import { DayBars, HBars, dayLabel } from '../charts';
import { Empty, ErrorLine, Panel, Skeleton } from '../parts';

const t = text.analytics;

type Series = 'visitors' | 'fresh' | 'callers' | 'entries' | 'presenceHours' | 'meetings';

/** Дата `YYYY-MM-DD` по местному времени смотрящего (сервер считает дни по своему поясу, его зовём рядом). */
export function isoDay(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function shift(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return isoDay(date);
}

/** Ядро по умолчанию — продукт; нет продукта — первое с учётными данными. */
export function defaultCore(machines: Machine[]): Machine | null {
  const withCore = machines.filter((m) => m.core?.credential);
  return withCore.find((m) => m.role === 'product-core') ?? withCore[0] ?? null;
}

/**
 * «Аналитика» (R210): метрики продукта за период в двух измерениях — АКТУАЛ (всё, что было в эти дни) и ЛТВ
 * (когорта пришедших в эти дни и вся её жизнь). Определения — подсказками у плиток и в
 * `docs/architecture/admin-analytics.md` §2.6.
 */
export function Analytics({ console }: { console: Console }) {
  const cores = console.machines.filter((m) => m.core?.credential);
  const [machineId, setMachineId] = useState<string | null>(null);
  const machine = cores.find((m) => m.id === machineId) ?? defaultCore(console.machines);
  const [from, setFrom] = useState(shift(-29));
  const [to, setTo] = useState(shift(0));
  const [mode, setMode] = useState<AnalyticsMode>('actual');
  const [series, setSeries] = useState<Series>('visitors');
  const [asTable, setAsTable] = useState(false);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;
  const report = useQuery({
    queryKey: ['analytics', machine?.id, from, to, mode],
    queryFn: () => fleet.get<AnalyticsReport>(`/core/${machine!.id}/analytics`, { from, to, mode }),
    enabled: !!machine && valid,
    placeholderData: (previous) => previous,
  });
  if (!machine) return <Empty>{t.noCore}</Empty>;
  const data = report.data;
  const quick = (days: number) => {
    setFrom(shift(-(days - 1)));
    setTo(shift(0));
  };
  return (
    <div className="admin-stack">
      <Panel title={t.period}>
        <div className="admin-filters">
          {cores.length > 1 && (
            <Field label={t.machine} inline>
              <Select value={machine.id} onChange={(event) => setMachineId(event.target.value)}>
                {cores.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.product ? `${m.title} · ${m.product}` : m.title}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <div className="admin-actions">
            <Button variant="quiet" size="sm" onClick={() => quick(7)}>
              {t.days7}
            </Button>
            <Button variant="quiet" size="sm" onClick={() => quick(30)}>
              {t.days30}
            </Button>
            <Button variant="quiet" size="sm" onClick={() => quick(90)}>
              {t.days90}
            </Button>
            <Button
              variant="quiet"
              size="sm"
              onClick={() => {
                setFrom(shift(-(new Date().getDate() - 1)));
                setTo(shift(0));
              }}
            >
              {t.month}
            </Button>
          </div>
          <Field label={t.from} inline>
            <Input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} />
          </Field>
          <Field label={t.to} inline>
            <Input type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} />
          </Field>
          <Segmented<AnalyticsMode>
            aria-label={t.mode}
            value={mode}
            onValueChange={setMode}
            options={[
              { value: 'actual', label: t.actual, title: t.actualHint },
              { value: 'ltv', label: t.ltv, title: t.ltvHint },
            ]}
          />
        </div>
        <p className="admin-hint">
          {mode === 'ltv' ? t.ltvHint : t.actualHint}
          {data && ` ${t.zone} ${data.zone}, ${t.today} ${dayLabel(data.today)}.`}
        </p>
        <ErrorLine error={report.error} onRetry={() => void report.refetch()} />
      </Panel>
      {report.isPending && <Skeleton rows={4} />}
      {data && (
        <Report data={data} series={series} setSeries={setSeries} asTable={asTable} setAsTable={setAsTable} />
      )}
    </div>
  );
}

function Report({
  data,
  series,
  setSeries,
  asTable,
  setAsTable,
}: {
  data: AnalyticsReport;
  series: Series;
  setSeries: (series: Series) => void;
  asTable: boolean;
  setAsTable: (value: boolean) => void;
}) {
  const ltv = data.mode === 'ltv';
  const v = data.visitors;
  const r = data.rates;
  const c = data.calls;
  const empty = v.total === 0 && (c.meetings ?? 0) === 0;
  const seriesOptions = (Object.keys(t.series) as Series[]).filter((key) => !(ltv && key === 'meetings'));
  const shown = seriesOptions.includes(series) ? series : 'visitors';
  const days = useMemo(
    () => data.days.map((d) => ({ day: d.day, value: d[shown] as number | null })),
    [data.days, shown],
  );
  const format = (value: number) =>
    shown === 'presenceHours' ? value.toFixed(1) : String(Math.round(value));
  return (
    <>
      {empty && <Empty>{t.empty}</Empty>}
      <Panel title={t.visitorsTitle}>
        <div className="admin-tiles">
          <Metric value={v.total} label={t.visitors} hint={t.visitorsHint} />
          <Metric value={v.fresh} label={t.fresh} hint={t.freshHint} />
          <Metric
            value={v.returning}
            label={t.returning}
            hint={ltv ? t.returningLtvHint : t.returningActualHint}
          />
          <Metric value={v.callers} label={t.callers} hint={t.callersHint} />
          <Metric value={v.newCallers} label={t.newCallers} hint={t.newCallersHint} />
          <Metric value={v.sameDayCallers} label={t.sameDay} hint={t.sameDayHint} />
        </div>
      </Panel>
      <Panel title={t.engagementTitle}>
        <div className="admin-tiles">
          <Metric value={share(r.er)} label={t.er} hint={t.erHint} />
          <Metric
            value={share(r.stickiness)}
            label={t.stickiness}
            hint={r.stickiness === null ? t.onlyActual : t.stickinessHint}
          />
          <Metric value={number(r.activeDays, 1)} label={t.activeDays} hint={t.activeDaysHint} />
          <Metric
            value={share(data.retention.total.d1)}
            label={`${t.retentionTotal} D1`}
            hint={t.earlyHint}
          />
          <Metric
            value={share(data.retention.total.d7)}
            label={`${t.retentionTotal} D7`}
            hint={t.earlyHint}
          />
          <Metric
            value={share(data.retention.total.d30)}
            label={`${t.retentionTotal} D30`}
            hint={t.earlyHint}
          />
          <Metric value={number(r.errorsPerVisit, 2)} label={t.errorsPerVisit} hint={t.errorsPerVisitHint} />
          <Metric
            value={share(r.joinFailureRate)}
            label={t.joinFailureRate}
            hint={t.joinFailureRateHint}
            tone={(r.joinFailureRate ?? 0) > 0.1 ? 'warn' : undefined}
          />
        </div>
      </Panel>
      <Panel title={t.callsTitle}>
        <div className="admin-tiles">
          <Metric
            value={number(c.meetings)}
            label={t.meetings}
            hint={c.meetings === null ? t.onlyActual : t.meetingsHint}
          />
          <Metric value={c.created} label={t.created} />
          <Metric value={c.entries} label={t.entries} hint={t.entriesHint} />
          <Metric value={c.presenceHours.toFixed(1)} label={t.presenceHours} hint={t.presenceHoursHint} />
          <Metric
            value={number(c.meetingHours, 1)}
            label={t.meetingHours}
            hint={c.meetingHours === null ? t.onlyActual : t.meetingHoursHint}
          />
          <Metric value={number(c.hoursPerCaller, 1)} label={t.hoursPerCaller} />
          <Metric
            value={number(c.minutesPerEntry, 0)}
            label={t.minutesPerEntry}
            hint={t.minutesPerEntryHint}
          />
          <Metric
            value={number(c.avgMinutes, 0)}
            label={t.avgMinutes}
            hint={c.avgMinutes === null && ltv ? t.onlyActual : undefined}
          />
          <Metric
            value={number(c.medianMinutes, 0)}
            label={t.medianMinutes}
            hint={ltv ? t.onlyActual : undefined}
          />
          <Metric
            value={number(c.longestMinutes, 0)}
            label={t.longestMinutes}
            hint={ltv ? t.onlyActual : undefined}
          />
          <Metric
            value={number(c.peakMeetings)}
            label={t.peakMeetings}
            hint={ltv ? t.onlyActual : undefined}
          />
          <Metric
            value={number(c.largestMeeting)}
            label={t.largestMeeting}
            hint={ltv ? t.onlyActual : undefined}
          />
        </div>
      </Panel>
      <Panel
        title={t.byDays}
        actions={
          <>
            <Segmented<Series>
              size="sm"
              aria-label={t.byDays}
              value={shown}
              onValueChange={setSeries}
              options={seriesOptions.map((key) => ({ value: key, label: t.series[key]! }))}
            />
            <Button variant="quiet" size="sm" onClick={() => setAsTable(!asTable)}>
              {asTable ? t.chart : t.table}
            </Button>
          </>
        }
      >
        {asTable ? (
          <DaysTable data={data} />
        ) : (
          <DayBars days={days} label={t.series[shown]!} format={format} />
        )}
      </Panel>
      <div className="admin-grid-3">
        <Panel title={t.funnel}>
          <p className="admin-hint">{t.funnelHint}</p>
          <HBars
            total={data.funnel.opened}
            rows={[
              { key: 'opened', label: t.opened, value: data.funnel.opened },
              {
                key: 'prejoined',
                label: t.prejoined,
                value: data.funnel.prejoined,
                note: shareOf(data.funnel.prejoined, data.funnel.opened),
              },
              {
                key: 'joined',
                label: t.joined,
                value: data.funnel.joined,
                note: shareOf(data.funnel.joined, data.funnel.opened),
              },
            ]}
          />
        </Panel>
        <Panel title={t.clients}>
          <HBars
            rows={data.clients.map((s) => ({
              key: s.kind,
              label: t.clientNames[s.kind] ?? s.kind,
              value: s.count,
            }))}
          />
          <h3 className="admin-subhead">{t.os}</h3>
          <HBars
            rows={data.os.map((s) => ({ key: s.kind, label: t.osNames[s.kind] ?? s.kind, value: s.count }))}
          />
        </Panel>
        <Panel title={t.integrations}>
          {data.integrations.meetings.length > 0 && (
            <HBars
              rows={data.integrations.meetings.map((s) => ({
                key: s.kind,
                label: text.live.integrationKinds[s.kind] ?? s.kind,
                value: s.count,
              }))}
            />
          )}
          <dl className="admin-dl admin-dl--compact">
            <dt>{t.integrationMeetings}</dt>
            <dd>{number(data.integrations.meetingsWithAny)}</dd>
            <dt>{t.integrationVisitors}</dt>
            <dd>{data.integrations.visitors}</dd>
            <dt>{t.integrationEncounters}</dt>
            <dd>{data.integrations.encounters}</dd>
          </dl>
        </Panel>
      </div>
      <Panel title={t.retention}>
        <p className="admin-hint">{ltv ? t.retentionLtvHint : t.retentionActualHint}</p>
        <RetentionTable cohorts={data.retention.cohorts} total={data.retention.total} />
      </Panel>
    </>
  );
}

function Metric({
  value,
  label,
  hint,
  tone,
}: {
  value: number | string;
  label: string;
  hint?: string;
  tone?: 'warn' | 'bad' | 'ok';
}) {
  return (
    <div className="admin-tile" data-tone={tone}>
      <div className="admin-tile__value">{value}</div>
      <div className="admin-tile__label">
        {label}
        {hint && (
          <>
            {' '}
            <HintIcon text={hint} label={label} focusable />
          </>
        )}
      </div>
    </div>
  );
}

function DaysTable({ data }: { data: AnalyticsReport }) {
  return (
    <div className="admin-table-wrap admin-table-wrap--tall">
      <table className="admin-table">
        <thead>
          <tr>
            <th>{t.day}</th>
            {(Object.keys(t.series) as Series[])
              .filter((key) => !(data.mode === 'ltv' && key === 'meetings'))
              .map((key) => (
                <th key={key}>{t.series[key]}</th>
              ))}
          </tr>
        </thead>
        <tbody>
          {data.days.map((d) => (
            <tr key={d.day}>
              <td>{dayLabel(d.day)}</td>
              <td>{d.visitors}</td>
              <td>{d.fresh}</td>
              <td>{d.callers}</td>
              <td>{d.entries}</td>
              <td>{d.presenceHours.toFixed(1)}</td>
              {data.mode !== 'ltv' && <td>{d.meetings ?? '—'}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Когорты удержания: заливка ячейки — доля вернувшихся (одна гамма, светлее — меньше), число — всегда. */
function RetentionTable({ cohorts, total }: { cohorts: Cohort[]; total: Cohort }) {
  if (cohorts.length === 0) return <Empty>{t.empty}</Empty>;
  const cell = (value: number | null) =>
    value === null ? (
      <td className="admin-retention__early" title={t.earlyHint}>
        {t.early}
      </td>
    ) : (
      <td style={{ '--share': value } as CSSProperties} className="admin-retention__cell">
        {share(value)}
      </td>
    );
  const label = (cohort: Cohort) =>
    cohort.since === cohort.until
      ? dayLabel(cohort.since)
      : `${dayLabel(cohort.since)} — ${dayLabel(cohort.until)}`;
  return (
    <div className="admin-table-wrap">
      <table className="admin-table admin-retention">
        <thead>
          <tr>
            <th>{t.cohort}</th>
            <th>{t.size}</th>
            <th>D1</th>
            <th>D3</th>
            <th>D7</th>
            <th>D30</th>
          </tr>
        </thead>
        <tbody>
          {cohorts.map((cohort) => (
            <tr key={cohort.since}>
              <td>{label(cohort)}</td>
              <td>{cohort.size}</td>
              {cell(cohort.d1)}
              {cell(cohort.d3)}
              {cell(cohort.d7)}
              {cell(cohort.d30)}
            </tr>
          ))}
          <tr className="admin-retention__total">
            <td>{t.total}</td>
            <td>{total.size}</td>
            {cell(total.d1)}
            {cell(total.d3)}
            {cell(total.d7)}
            {cell(total.d30)}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function share(value: number | null | undefined): string {
  return value === null || value === undefined
    ? '—'
    : `${(value * 100).toFixed(value < 0.1 && value > 0 ? 1 : 0)} %`;
}

function shareOf(part: number, whole: number): string {
  return whole > 0 ? share(part / whole) : '';
}

function number(value: number | null | undefined, digits = 0): string {
  return value === null || value === undefined ? '—' : value.toFixed(digits);
}
