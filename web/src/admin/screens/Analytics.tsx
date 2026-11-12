import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { HintIcon, Segmented } from '../../ui/kit';
import { text } from '../../i18n/admin/ru';
import { FleetError, fleet } from '../api';
import type { Console } from '../AdminApp';
import { coreOf, useEnvironment } from '../environment';
import { Empty, ErrorLine, Skeleton } from '../parts';
import { BarList, Block, DataTable, Kpi, Kpis, TimeSeries, fmt, type Column } from '../analytics/charts';
import {
  AcquisitionSection,
  ActivationSection,
  AudienceSection,
  EngagementSection,
  ErrorsSection,
  IntegrationsSection,
  PulseSection,
  QualitySection,
  RetentionSection,
  TrafficSection,
  word,
} from '../analytics/sections';
import type { ErrorDetail, Report, Reports, Section, Slice, View } from '../analytics/types';

const t = text.analytics;

const SECTIONS: Section[] = [
  'pulse',
  'audience',
  'acquisition',
  'activation',
  'retention',
  'engagement',
  'integrations',
  'quality',
  'errors',
  'traffic',
];

/** Дата `ГГГГ-ММ-ДД` по местному времени смотрящего (служба считает сутки по своему поясу — он назван рядом). */
export function isoDay(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function shift(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return isoDay(date);
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Что выбрано на экране — в адресе: ссылку на отчёт можно сохранить и переслать. */
type Query = {
  section: Section;
  from: string;
  to: string;
  view: View;
  strict: boolean;
  compare: boolean;
  group: string | null;
};

function readQuery(): Query {
  const params = new URLSearchParams(location.search);
  const section = params.get('s') as Section | null;
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const dated = DAY.test(from) && DAY.test(to) && from <= to;
  return {
    section: section && SECTIONS.includes(section) ? section : 'pulse',
    from: dated ? from : shift(-27),
    to: dated ? to : shift(0),
    view: params.get('view') === 'cohort' ? 'cohort' : 'period',
    strict: params.get('strict') === '1',
    compare: params.get('compare') !== '0',
    group: params.get('e'),
  };
}

function writeQuery(query: Query): void {
  const params = new URLSearchParams();
  if (query.section !== 'pulse') params.set('s', query.section);
  params.set('from', query.from);
  params.set('to', query.to);
  if (query.view === 'cohort') params.set('view', 'cohort');
  if (query.strict) params.set('strict', '1');
  if (!query.compare) params.set('compare', '0');
  if (query.group) params.set('e', query.group);
  history.replaceState(null, '', `${location.pathname}?${params}`);
}

/**
 * «Аналитика» (R239): десять разделов-вопросов над отчётами службы `insight` выбранной среды. Период, вид («За
 * период» или «Когорты»), строгий счёт и сравнение с прошлым периодом — общие для всех разделов; определения
 * величин — подсказками у плиток (`docs/architecture/analytics-v2.md` §8).
 */
export function Analytics({ console }: { console: Console }) {
  const [environment, setEnvironment] = useEnvironment();
  const [query, setQueryState] = useState<Query>(readQuery);
  const setQuery = useCallback((patch: Partial<Query>) => {
    setQueryState((current) => {
      const next = { ...current, ...patch };
      writeQuery(next);
      return next;
    });
  }, []);
  // Адрес сменили мимо экрана (ссылка из другого раздела, «назад» в браузере) — выбор читается заново.
  useEffect(() => {
    const onPop = () => setQueryState(readQuery());
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);
  const core = coreOf(console.machines, environment);
  const valid = DAY.test(query.from) && DAY.test(query.to) && query.from <= query.to;
  const params = {
    env: environment,
    from: query.from,
    to: query.to,
    view: query.view,
    strict: query.strict ? 1 : 0,
    compare: query.compare ? 1 : 0,
  };
  const report = useQuery({
    queryKey: ['insight', query.section, params],
    queryFn: () => fleet.get<Report<Reports[Section]>>(`/insight/${query.section}`, params),
    enabled: !!core && valid && !query.group,
    placeholderData: (previous, previousQuery) =>
      // Прежний отчёт остаётся на экране, пока грузится новый период того же раздела, — но не чужой раздел.
      previousQuery?.queryKey[1] === query.section ? previous : undefined,
    staleTime: 60_000,
  });
  const quick = (days: number) => setQuery({ from: shift(-(days - 1)), to: shift(0) });
  const span = valid ? Math.round((Date.parse(query.to) - Date.parse(query.from)) / 86_400_000) + 1 : 0;
  const today = query.to === shift(0);
  const preset = today && [7, 28, 90].includes(span) ? span : 0;
  return (
    <div className="an">
      <div className="an-bar">
        <Segmented
          size="sm"
          aria-label={t.environment}
          value={environment}
          onValueChange={setEnvironment}
          options={[
            { value: 'product', label: text.pulse.environments.product },
            { value: 'dev', label: text.pulse.environments.dev },
          ]}
        />
        <Segmented
          size="sm"
          aria-label={t.period}
          value={preset}
          onValueChange={(days) => quick(Number(days))}
          options={[
            { value: 7, label: t.days7 },
            { value: 28, label: t.days28 },
            { value: 90, label: t.days90 },
          ]}
        />
        <div className="an-bar__dates">
          <label>
            {t.from}
            <input
              type="date"
              value={query.from}
              max={query.to}
              onChange={(event) => event.target.value && setQuery({ from: event.target.value })}
            />
          </label>
          <label>
            {t.to}
            <input
              type="date"
              value={query.to}
              min={query.from}
              max={shift(0)}
              onChange={(event) => event.target.value && setQuery({ to: event.target.value })}
            />
          </label>
        </div>
        <Segmented
          size="sm"
          aria-label={t.view}
          value={query.view}
          onValueChange={(view) => setQuery({ view })}
          options={[
            { value: 'period', label: t.viewPeriod },
            { value: 'cohort', label: t.viewCohort },
          ]}
        />
        <HintIcon label={t.view} text={t.viewHint} focusable />
        <label className="an-bar__toggle">
          <input
            type="checkbox"
            checked={query.compare}
            onChange={(event) => setQuery({ compare: event.target.checked })}
          />
          {t.compare}
        </label>
        <label className="an-bar__toggle" title={t.strictHint}>
          <input
            type="checkbox"
            checked={query.strict}
            onChange={(event) => setQuery({ strict: event.target.checked })}
          />
          {t.strict}
        </label>
        {report.data && (
          <span className="an-bar__meta">
            {t.zone(report.data.zone)} · {t.builtAt(fmt.moment(report.data.generated_at))}
          </span>
        )}
      </div>
      <div className="an-tabs" role="tablist" aria-label={t.sectionsLabel}>
        {SECTIONS.map((section) => (
          <button
            key={section}
            type="button"
            role="tab"
            aria-selected={section === query.section}
            onClick={() => setQuery({ section, group: null })}
          >
            {t.sections[section]}
          </button>
        ))}
      </div>
      <p className="an-question">{t.questions[query.section]}</p>
      {!core ? (
        <Empty>{t.noCore}</Empty>
      ) : query.group ? (
        <ErrorGroupDetail params={params} group={query.group} onBack={() => setQuery({ group: null })} />
      ) : report.error ? (
        <Unavailable error={report.error} onRetry={() => void report.refetch()} />
      ) : !report.data ? (
        <Skeleton rows={6} />
      ) : (
        <SectionBody report={report.data} section={query.section} onGroup={(group) => setQuery({ group })} />
      )}
      <p className="an-note">{t.geoCredit}</p>
    </div>
  );
}

/** Служба аналитики не ответила: это не «нет данных», а «спросить не у кого» — сказано прямо. */
function Unavailable({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const off =
    error instanceof FleetError && (error.status === 503 || error.status === 502 || error.status === 404);
  return (
    <>
      <ErrorLine error={error} onRetry={onRetry} />
      {off && <p className="an-note">{t.unavailableHint}</p>}
    </>
  );
}

function SectionBody({
  report,
  section,
  onGroup,
}: {
  report: Report<Reports[Section]>;
  section: Section;
  onGroup: (key: string) => void;
}) {
  // Отчёт на экране мог остаться от прежнего запроса: рисуем то, что пришло, а не то, что выбрано.
  const shown = (report.section.split('/')[0] ?? section) as Section;
  switch (shown) {
    case 'pulse':
      return <PulseSection report={report as Report<Reports['pulse']>} />;
    case 'audience':
      return <AudienceSection report={report as Report<Reports['audience']>} />;
    case 'acquisition':
      return <AcquisitionSection report={report as Report<Reports['acquisition']>} />;
    case 'activation':
      return <ActivationSection report={report as Report<Reports['activation']>} />;
    case 'retention':
      return <RetentionSection report={report as Report<Reports['retention']>} />;
    case 'engagement':
      return <EngagementSection report={report as Report<Reports['engagement']>} />;
    case 'integrations':
      return <IntegrationsSection report={report as Report<Reports['integrations']>} />;
    case 'quality':
      return <QualitySection report={report as Report<Reports['quality']>} />;
    case 'errors':
      return <ErrorsSection report={report as Report<Reports['errors']>} onGroup={onGroup} />;
    case 'traffic':
      return <TrafficSection report={report as Report<Reports['traffic']>} />;
  }
}

const slices = (group: string | null, rows: Slice[]) =>
  rows.map((row) => ({
    key: row.key,
    label: group ? word(group, row.key) : row.key || t.unknown,
    value: row.events,
    note: t.sessionsOf(fmt.count(row.sessions)),
  }));

/** Одна группа ошибок: когда, у кого, на каком шаге и последние случаи — чтобы понять причину, а не только счёт. */
function ErrorGroupDetail({
  params,
  group,
  onBack,
}: {
  params: Record<string, unknown>;
  group: string;
  onBack: () => void;
}) {
  const detail = useQuery({
    queryKey: ['insight', 'errors', group, params],
    queryFn: () => fleet.get<Report<ErrorDetail>>(`/insight/errors/${encodeURIComponent(group)}`, params),
  });
  const back = (
    <button type="button" className="an-switch" onClick={onBack}>
      <ArrowLeft size={16} aria-hidden="true" /> {t.back}
    </button>
  );
  if (detail.error)
    return (
      <>
        {back}
        <ErrorLine error={detail.error} onRetry={() => void detail.refetch()} />
      </>
    );
  if (!detail.data)
    return (
      <>
        {back}
        <Skeleton rows={5} />
      </>
    );
  const data = detail.data.data;
  const steps = Object.keys(t.words.step ?? {});
  const sampleColumns: Column<ErrorDetail['samples'][number]>[] = [
    { key: 'at', label: t.columns.when!, cell: (row) => fmt.moment(row.at) },
    {
      key: 'detail',
      label: t.columns.detail!,
      cell: (row) => (
        <>
          {row.detail ?? '—'}
          {row.fatal && <span className="an-badge">{t.fatal}</span>}
        </>
      ),
    },
    { key: 'screen', label: t.columns.screen!, cell: (row) => row.screen ?? '—' },
    {
      key: 'step',
      label: t.blocks.steps!,
      cell: (row) => (row.step ? word('step', steps[row.step - 1] ?? '') : '—'),
    },
    {
      key: 'client',
      label: t.columns.client!,
      cell: (row) =>
        [row.client && word('client', row.client), row.version, row.os && word('os', row.os), row.browser]
          .filter(Boolean)
          .join(' · ') || '—',
    },
  ];
  return (
    <>
      {back}
      <div className="an-detail__head">
        <h3>{data.group.code}</h3>
        <span>
          {data.group.scope} · {word('cause', data.group.cause)} · {word('source', data.group.version)}
        </span>
        <span>
          {t.columns.first}: {fmt.moment(data.group.first_at)} · {t.columns.last}:{' '}
          {fmt.moment(data.group.last_at)}
        </span>
        <span>{t.allTime(fmt.count(data.group.events_total), fmt.count(data.group.people_total))}</span>
      </div>
      <Kpis>
        <Kpi label={t.kpi.events!} value={fmt.count(data.period.events)} />
        <Kpi
          label={t.kpi.sessions_affected!}
          value={fmt.count(data.period.sessions)}
          note={fmt.share(data.period.sessions_share)}
        />
        <Kpi
          label={t.kpi.people_affected!}
          value={fmt.count(data.period.people)}
          note={fmt.share(data.period.people_share)}
        />
      </Kpis>
      <div className="an-grid2">
        <Block title={t.blocks.errorsByDay!} wide>
          <TimeSeries
            title={t.blocks.errorsByDay!}
            days={data.series.map((day) => day.day)}
            series={[
              { key: 'events', label: t.kpi.events!, values: data.series.map((day) => day.events) },
              {
                key: 'sessions',
                label: t.kpi.sessions_affected!,
                values: data.series.map((day) => day.sessions),
              },
              { key: 'people', label: t.kpi.people_affected!, values: data.series.map((day) => day.people) },
            ]}
          />
        </Block>
        <Block title={t.blocks.versions!}>
          <BarList rows={slices(null, data.versions)} />
        </Block>
        <Block title={t.blocks.steps!}>
          <BarList
            ordered
            rows={data.steps.map((row) => ({
              key: String(row.step),
              label: word('step', steps[row.step - 1] ?? ''),
              value: row.events,
            }))}
          />
        </Block>
        <Block title={t.blocks.byOs!}>
          <BarList rows={slices('os', data.os)} />
        </Block>
        <Block title={t.blocks.byBrowser!}>
          <BarList rows={slices('browser', data.browsers)} />
        </Block>
        <Block title={t.blocks.byClient!}>
          <BarList rows={slices('client', data.clients)} />
        </Block>
        <Block title={t.blocks.nodes!}>
          <BarList rows={slices(null, data.nodes)} />
        </Block>
        <Block title={t.blocks.samples!} wide>
          <DataTable
            columns={sampleColumns}
            rows={data.samples}
            rowKey={(row, index) => `${index}:${row.at}`}
          />
        </Block>
      </div>
    </>
  );
}
