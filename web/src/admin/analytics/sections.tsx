import { useState } from 'react';
import { Segmented } from '../../ui/kit';
import { text } from '../../i18n/admin/ru';
import {
  BarList,
  Block,
  CohortGrid,
  DataTable,
  Funnel,
  Kpi,
  Kpis,
  TimeSeries,
  fmt,
  type Column,
} from './charts';
import type {
  Acquisition,
  Activation,
  Audience,
  Breakdown,
  Engagement,
  ErrorGroup,
  Errors,
  IntegrationRow,
  Integrations,
  Kept,
  Media,
  Pulse,
  Quality,
  Report,
  Retention,
  Source,
  Timing,
  Traffic,
  Visits,
} from './types';

/**
 * Разделы аналитики (R239, `admin-console-v2.md` §6): каждый отвечает на один вопрос и рисуется из одного отчёта
 * службы `insight`. Сверху — величины с изменением к прошлому периоду, ниже — ряды, затем разрезы.
 */
const t = text.analytics;

/** Слово разреза по-русски; незнакомое показывается как есть (список роботов и кодов растёт). */
export function word(group: string, key: string): string {
  const known = t.words[group]?.[key];
  if (known) return known;
  if (key === '') return t.unknown;
  if (group === 'country' && regions) {
    try {
      return regions.of(key) ?? key;
    } catch {
      return key;
    }
  }
  return key;
}

const regions =
  typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames('ru', { type: 'region' }) : null;

/** Изменение величины к прошлому периоду — только когда отчёт пришёл со сравнением. */
function delta(now: number | null | undefined, before: number | null | undefined): number | null {
  if (now === null || now === undefined || before === null || before === undefined || before === 0)
    return null;
  return (now - before) / before;
}

/** `change` для плитки: `undefined` без сравнения — строка изменения не рисуется вовсе. */
function versus<T>(
  report: Report<T>,
  pick: (data: T) => number | null | undefined,
): number | null | undefined {
  return report.previous ? delta(pick(report.data), pick(report.previous.data)) : undefined;
}

const breakdown = (group: string, rows: Breakdown[]) =>
  rows.map((row) => ({
    key: row.key,
    label: word(group, row.key),
    value: row.people,
    note: t.sessionsOf(fmt.count(row.sessions)),
  }));

const sources = (group: string | null, rows: Source[]) =>
  rows.map((row) => ({
    key: row.key,
    label: group ? word(group, row.key) : row.key || t.direct,
    value: row.new_people,
    note: t.interlocutorsOf(fmt.count(row.interlocutors), fmt.share(row.share)),
  }));

// ── Пульс ────────────────────────────────────────────────────────────────────────────────────────
export function PulseSection({ report }: { report: Report<Pulse> }) {
  const { tiles, series } = report.data;
  const days = series.map((day) => day.day);
  // Изменение к прошлому периоду у плиток пульса служба считает всегда, и без `compare`.
  const change = (tile: keyof typeof tiles) => tiles[tile].change;
  return (
    <>
      <Kpis>
        <Kpi
          lead
          label={t.kpi.weekly_interlocutors!}
          hint={t.hints.weekly_interlocutors}
          value={fmt.count(tiles.weekly_interlocutors.value)}
          change={change('weekly_interlocutors')}
        />
        <Kpi
          label={t.kpi.people!}
          hint={t.hints.people}
          value={fmt.count(tiles.people.value)}
          change={change('people')}
        />
        <Kpi
          label={t.kpi.new_people!}
          hint={t.hints.new_people}
          value={fmt.count(tiles.new_people.value)}
          change={change('new_people')}
        />
        <Kpi
          label={t.kpi.returning!}
          hint={t.hints.returning}
          value={fmt.count(tiles.returning.value)}
          change={change('returning')}
        />
        <Kpi
          label={t.kpi.resurrected!}
          hint={t.hints.resurrected}
          value={fmt.count(tiles.resurrected.value)}
          change={change('resurrected')}
        />
        <Kpi
          label={t.kpi.interlocutors!}
          hint={t.hints.interlocutors}
          value={fmt.count(tiles.interlocutors.value)}
          change={change('interlocutors')}
        />
        <Kpi
          label={t.kpi.interlocutor_share!}
          hint={t.hints.interlocutor_share}
          value={fmt.share(tiles.interlocutor_share.value)}
          change={change('interlocutor_share')}
        />
        <Kpi
          label={t.kpi.talk_hours!}
          hint={t.hints.talk_hours}
          value={fmt.hours(tiles.talk_hours.value)}
          change={change('talk_hours')}
        />
        <Kpi
          label={t.kpi.stickiness!}
          hint={t.hints.stickiness}
          value={fmt.share(tiles.stickiness.value)}
          change={change('stickiness')}
        />
        <Kpi
          label={t.kpi.join_success!}
          hint={t.hints.join_success}
          value={fmt.share(tiles.join_success.value)}
          change={change('join_success')}
        />
        <Kpi
          inverse
          label={t.kpi.join_p50_ms!}
          hint={t.hints.join_p50_ms}
          value={fmt.seconds(tiles.join_p50_ms.value)}
          change={change('join_p50_ms')}
        />
        <Kpi
          label={t.kpi.error_free_sessions!}
          hint={t.hints.error_free_sessions}
          value={fmt.share(tiles.error_free_sessions.value)}
          change={change('error_free_sessions')}
        />
        <Kpi label={t.kpi.vpn_share!} hint={t.hints.vpn_share} value={fmt.share(tiles.vpn_share.value)} />
      </Kpis>
      <div className="an-grid2">
        <Block title={t.blocks.weekly!} hint={t.hints.weekly_interlocutors}>
          <TimeSeries
            title={t.kpi.weekly_interlocutors!}
            days={days}
            series={[
              {
                key: 'weekly',
                label: t.kpi.weekly_interlocutors!,
                values: series.map((day) => day.weekly_interlocutors),
              },
            ]}
            previous={report.previous?.data.series.map((day) => day.weekly_interlocutors)}
          />
        </Block>
        <Block title={t.blocks.daily!}>
          <TimeSeries
            title={t.blocks.daily!}
            days={days}
            series={[
              { key: 'people', label: t.kpi.people!, values: series.map((day) => day.people) },
              { key: 'new', label: t.kpi.new_people!, values: series.map((day) => day.new_people) },
              { key: 'talk', label: t.kpi.interlocutors!, values: series.map((day) => day.interlocutors) },
            ]}
          />
        </Block>
        <Block title={t.blocks.split!} hint={t.hints.people}>
          <BarList
            ordered
            rows={[
              {
                key: 'confirmed',
                label: t.kpi.confirmed!,
                value: tiles.confirmed.value,
                note: t.hints.confirmed,
              },
              {
                key: 'engaged',
                label: t.kpi.engaged_only!,
                value: tiles.engaged_only.value,
                note: t.hints.engaged_only,
              },
            ]}
          />
        </Block>
        <Block title={t.blocks.talkByDay!} hint={t.hints.talk_hours}>
          <TimeSeries
            title={t.kpi.talk_hours!}
            format={fmt.hours}
            days={days}
            series={[{ key: 'hours', label: t.kpi.talk_hours!, values: series.map((day) => day.talk_hours) }]}
            previous={report.previous?.data.series.map((day) => day.talk_hours)}
          />
        </Block>
      </div>
    </>
  );
}

// ── Аудитория ────────────────────────────────────────────────────────────────────────────────────
export function AudienceSection({ report }: { report: Report<Audience> }) {
  const { totals, series, frequency, recognised } = report.data;
  const days = series.map((day) => day.day);
  return (
    <>
      <Kpis>
        <Kpi
          label={t.kpi.people!}
          hint={t.hints.people}
          value={fmt.count(totals.people)}
          change={versus(report, (d) => d.totals.people)}
        />
        <Kpi
          label={t.kpi.new_people!}
          hint={t.hints.new_people}
          value={fmt.count(totals.new_people)}
          change={versus(report, (d) => d.totals.new_people)}
        />
        <Kpi
          label={t.kpi.returning!}
          hint={t.hints.returning}
          value={fmt.count(totals.returning)}
          change={versus(report, (d) => d.totals.returning)}
        />
        <Kpi
          label={t.kpi.resurrected!}
          hint={t.hints.resurrected}
          value={fmt.count(totals.resurrected)}
          change={versus(report, (d) => d.totals.resurrected)}
        />
        <Kpi
          label={t.kpi.recognised_by_fingerprint!}
          hint={t.hints.recognised_by_fingerprint}
          value={fmt.count(totals.recognised_by_fingerprint)}
        />
        <Kpi
          label={t.kpi.stickiness!}
          hint={t.hints.stickiness}
          value={fmt.share(totals.stickiness)}
          change={versus(report, (d) => d.totals.stickiness)}
        />
        <Kpi
          label={t.kpi.sessions!}
          value={fmt.count(totals.sessions)}
          change={versus(report, (d) => d.totals.sessions)}
          note={`${t.kpi.sessions_per_person}: ${fmt.count(totals.sessions_per_person)}`}
        />
        <Kpi label={t.kpi.vpn_share!} hint={t.hints.vpn_share} value={fmt.share(totals.vpn_share)} />
      </Kpis>
      <div className="an-grid2">
        <Block title={t.blocks.dauWauMau!}>
          <TimeSeries
            title={t.blocks.dauWauMau!}
            days={days}
            series={[
              { key: 'dau', label: 'За день', values: series.map((day) => day.dau) },
              { key: 'wau', label: 'За 7 дней', values: series.map((day) => day.wau) },
              { key: 'mau', label: 'За 30 дней', values: series.map((day) => day.mau) },
            ]}
          />
        </Block>
        <Block title={t.blocks.newReturning!}>
          <TimeSeries
            title={t.blocks.newReturning!}
            days={days}
            series={[
              { key: 'new', label: t.kpi.new_people!, values: series.map((day) => day.new_people) },
              { key: 'returning', label: t.kpi.returning!, values: series.map((day) => day.returning) },
              { key: 'resurrected', label: t.kpi.resurrected!, values: series.map((day) => day.resurrected) },
            ]}
          />
        </Block>
        <Block title={t.blocks.frequency!} hint={t.blocks.frequencyHint}>
          <BarList
            ordered
            rows={frequency.map((row) => ({
              key: String(row.active_days),
              label: t.activeDays(String(row.active_days)),
              value: row.people,
            }))}
          />
        </Block>
        <Block title={t.blocks.recognised!} hint={t.blocks.recognisedHint}>
          <BarList
            ordered
            rows={(['cookie', 'profile', 'fingerprint', 'new'] as const).map((key) => ({
              key,
              label: word('via', key),
              value: recognised[key],
            }))}
          />
        </Block>
      </div>
      <div className="an-grid3">
        <Block title={t.blocks.byClient!}>
          <BarList rows={breakdown('client', report.data.by_client)} />
        </Block>
        <Block title={t.blocks.byOs!}>
          <BarList rows={breakdown('os', report.data.by_os)} />
        </Block>
        <Block title={t.blocks.byBrowser!}>
          <BarList rows={breakdown('browser', report.data.by_browser)} />
        </Block>
        <Block title={t.blocks.byDevice!}>
          <BarList rows={breakdown('device', report.data.by_device)} />
        </Block>
        <Block title={t.blocks.byCountry!}>
          <BarList rows={breakdown('country', report.data.by_country)} />
        </Block>
        <Block title={t.blocks.byNetwork!}>
          <BarList rows={breakdown('net', report.data.by_network)} />
        </Block>
      </div>
    </>
  );
}

// ── Привлечение ──────────────────────────────────────────────────────────────────────────────────
export function AcquisitionSection({ report }: { report: Report<Acquisition> }) {
  const { totals, series } = report.data;
  return (
    <>
      <Kpis>
        <Kpi
          label={t.kpi.new_people!}
          hint={t.hints.new_people}
          value={fmt.count(totals.new_people)}
          change={versus(report, (d) => d.totals.new_people)}
        />
        <Kpi
          label={t.kpi.by_invite!}
          hint={t.hints.by_invite}
          value={fmt.count(totals.by_invite)}
          change={versus(report, (d) => d.totals.by_invite)}
          note={fmt.share(totals.invite_share)}
        />
        <Kpi
          label={t.columns.becameInterlocutors!}
          hint={t.hints.interlocutors}
          value={fmt.count(totals.interlocutors)}
          change={versus(report, (d) => d.totals.interlocutors)}
        />
        <Kpi
          label={t.kpi.invites_sent!}
          value={fmt.count(totals.invites_sent)}
          change={versus(report, (d) => d.totals.invites_sent)}
          note={`${t.kpi.inviters}: ${fmt.count(totals.inviters)}`}
        />
        <Kpi label={t.kpi.k_factor!} hint={t.hints.k_factor} value={fmt.count(totals.k_factor)} />
      </Kpis>
      <div className="an-grid2">
        <Block title={t.blocks.newByDay!} wide>
          <TimeSeries
            title={t.blocks.newByDay!}
            days={series.map((day) => day.day)}
            series={[
              { key: 'new', label: t.kpi.new_people!, values: series.map((day) => day.new_people) },
              { key: 'invite', label: t.kpi.by_invite!, values: series.map((day) => day.by_invite) },
            ]}
          />
        </Block>
        <Block title={t.blocks.byLanding!}>
          <BarList rows={sources('landing', report.data.by_landing)} />
        </Block>
        <Block title={t.blocks.bySource!}>
          <BarList rows={sources(null, report.data.by_source)} />
        </Block>
        <Block title={t.blocks.byCampaign!}>
          <BarList rows={sources(null, report.data.by_campaign)} />
        </Block>
        <Block title={t.blocks.invites!}>
          <BarList
            rows={report.data.invites.map((row) => ({
              key: row.how,
              label: word('how', row.how),
              value: row.count,
            }))}
          />
        </Block>
      </div>
      <div className="an-grid3">
        <Block title={t.blocks.byClient!}>
          <BarList rows={sources('client', report.data.by_client)} />
        </Block>
        <Block title={t.blocks.byOs!}>
          <BarList rows={sources('os', report.data.by_os)} />
        </Block>
        <Block title={t.blocks.byCountry!}>
          <BarList rows={sources('country', report.data.by_country)} />
        </Block>
      </div>
    </>
  );
}

// ── Активация ────────────────────────────────────────────────────────────────────────────────────
export function ActivationSection({ report }: { report: Report<Activation> }) {
  const data = report.data;
  const devices = ['mic', 'cam', 'screen'].filter((device) =>
    data.permissions.some((p) => p.device === device),
  );
  const permission = (device: string, result: string) =>
    data.permissions.find((p) => p.device === device && p.result === result)?.count ?? 0;
  const permissionColumns: Column<string>[] = [
    { key: 'device', label: t.columns.device!, cell: (device) => word('media', device) },
    ...(['granted', 'denied', 'dismissed', 'error'] as const).map((result) => ({
      key: result,
      label: t.columns[result]!,
      numeric: true,
      cell: (device: string) => fmt.count(permission(device, result)),
    })),
  ];
  return (
    <>
      <Kpis>
        <Kpi
          lead
          label={t.kpi.activation_24h!}
          hint={t.hints.activation_24h}
          value={fmt.share(data.share_24h)}
          change={versus(report, (d) => d.share_24h)}
          note={t.matureOf(fmt.count(data.mature_24h))}
        />
        <Kpi
          label={t.kpi.activation_7d!}
          hint={t.hints.activation_7d}
          value={fmt.share(data.share_7d)}
          change={versus(report, (d) => d.share_7d)}
          note={t.matureOf(fmt.count(data.mature_7d))}
        />
        <Kpi
          label={t.kpi.new_people!}
          hint={t.hints.new_people}
          value={fmt.count(data.new_people)}
          change={versus(report, (d) => d.new_people)}
        />
      </Kpis>
      <div className="an-grid2">
        <Block title={t.blocks.funnel!} hint={t.blocks.funnelHint} wide>
          <Funnel
            steps={data.funnel.map((step) => ({
              key: step.step,
              label: word('step', step.step),
              value: step.people,
            }))}
          />
        </Block>
        <Block title={t.blocks.timeToTalk!}>
          <BarList
            ordered
            rows={data.time_to_talk.map((row) => ({
              key: row.bucket,
              label: word('talk', row.bucket),
              value: row.people,
            }))}
          />
        </Block>
        <Block title={t.blocks.permissions!}>
          <DataTable columns={permissionColumns} rows={devices} rowKey={(device) => device} />
        </Block>
        <Block title={t.blocks.activationByDay!} wide>
          <TimeSeries
            title={t.blocks.activationByDay!}
            days={data.series.map((day) => day.day)}
            series={[
              { key: 'new', label: t.kpi.new_people!, values: data.series.map((day) => day.new_people) },
              {
                key: 'd1',
                label: t.kpi.activation_24h!,
                values: data.series.map((day) => day.activated_24h),
              },
              { key: 'd7', label: t.kpi.activation_7d!, values: data.series.map((day) => day.activated_7d) },
            ]}
          />
        </Block>
      </div>
    </>
  );
}

// ── Удержание ────────────────────────────────────────────────────────────────────────────────────
export function RetentionSection({ report }: { report: Report<Retention> }) {
  const data = report.data;
  const [talked, setTalked] = useState(false);
  const share = (kept: Kept) => (talked ? kept.talked_share : kept.share);
  const cells = (cohort: { d1: Kept; d7: Kept; d30: Kept }) => ({
    d1: share(cohort.d1),
    d7: share(cohort.d7),
    d30: share(cohort.d30),
  });
  const label = (cohort: string) =>
    data.bucket === 'month'
      ? new Date(`${cohort}T00:00:00`).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })
      : fmt.day(cohort);
  return (
    <>
      <Kpis>
        {(['d1', 'd7', 'd30'] as const).map((key) => (
          <Kpi
            key={key}
            label={t.kpi[key]!}
            hint={t.hints[key]}
            value={fmt.share(data.total[key].share)}
            change={versus(report, (d) => d.total[key].share)}
            note={`${t.returnedAndTalked}: ${fmt.share(data.total[key].talked_share)}`}
          />
        ))}
        <Kpi
          label={t.kpi.carried!}
          hint={t.hints.carried}
          value={fmt.share(data.carried.share)}
          note={`${fmt.count(data.carried.stayed)} из ${fmt.count(data.carried.previous_people)}`}
        />
      </Kpis>
      <Block
        title={t.blocks.cohorts!}
        hint={t.blocks.cohortsHint}
        actions={
          <Segmented
            size="sm"
            aria-label={t.keep}
            value={talked ? 'talked' : 'returned'}
            onValueChange={(value) => setTalked(value === 'talked')}
            options={[
              { value: 'returned', label: t.returned },
              { value: 'talked', label: t.returnedAndTalked },
            ]}
          />
        }
      >
        <CohortGrid
          columns={[
            { key: 'd1', label: 'D1' },
            { key: 'd7', label: 'D7' },
            { key: 'd30', label: 'D30' },
          ]}
          rows={data.cohorts.map((cohort) => ({
            key: cohort.cohort,
            label: label(cohort.cohort),
            size: cohort.size,
            cells: cells(cohort),
          }))}
          total={{ size: data.total.size, cells: cells(data.total) }}
        />
      </Block>
      <Block title={t.blocks.curve!}>
        <TimeSeries
          title={t.blocks.curve!}
          format={fmt.share}
          axis={t.chart.day}
          label={(age) => t.ageDay(age)}
          days={data.curve.filter((point) => point.age > 0).map((point) => String(point.age))}
          series={[
            {
              key: 'returned',
              label: t.returned,
              values: data.curve.filter((point) => point.age > 0).map((point) => point.share),
            },
            {
              key: 'talked',
              label: t.returnedAndTalked,
              values: data.curve.filter((point) => point.age > 0).map((point) => point.talked_share),
            },
          ]}
        />
      </Block>
    </>
  );
}

// ── Вовлечённость ────────────────────────────────────────────────────────────────────────────────
export function EngagementSection({ report }: { report: Report<Engagement> }) {
  const { totals, meetings, series } = report.data;
  const days = series.map((day) => day.day);
  return (
    <>
      <Kpis>
        <Kpi
          lead
          label={t.kpi.talk_hours!}
          hint={t.hints.talk_hours}
          value={fmt.hours(totals.talk_hours)}
          change={versus(report, (d) => d.totals.talk_hours)}
          note={`${t.kpi.together_hours}: ${fmt.hours(totals.together_hours)}`}
        />
        <Kpi
          label={t.kpi.minutes_per_interlocutor_day!}
          hint={t.hints.minutes_per_interlocutor_day}
          value={fmt.minutes(totals.minutes_per_interlocutor_day)}
          change={versus(report, (d) => d.totals.minutes_per_interlocutor_day)}
        />
        <Kpi
          label={t.kpi.meetings!}
          value={fmt.count(meetings.count)}
          change={versus(report, (d) => d.meetings.count)}
          note={`${t.kpi.with_peers}: ${fmt.count(meetings.with_peers)}`}
        />
        <Kpi
          label={t.kpi.median_minutes!}
          value={fmt.minutes(meetings.median_minutes)}
          change={versus(report, (d) => d.meetings.median_minutes)}
          note={`${t.kpi.p90_minutes}: ${fmt.minutes(meetings.p90_minutes)}`}
        />
        <Kpi
          label={t.kpi.peak_avg!}
          value={fmt.count(meetings.peak_avg)}
          change={versus(report, (d) => d.meetings.peak_avg)}
        />
        <Kpi
          label={t.kpi.joins!}
          value={fmt.count(totals.joins)}
          change={versus(report, (d) => d.totals.joins)}
          note={`${t.kpi.sessions_per_person}: ${fmt.count(totals.sessions_per_person)}`}
        />
      </Kpis>
      <div className="an-grid2">
        <Block title={t.blocks.talkByDay!}>
          <TimeSeries
            title={t.kpi.talk_hours!}
            format={fmt.hours}
            days={days}
            series={[{ key: 'hours', label: t.kpi.talk_hours!, values: series.map((day) => day.talk_hours) }]}
            previous={report.previous?.data.series.map((day) => day.talk_hours)}
          />
        </Block>
        <Block title={t.blocks.meetingsByDay!}>
          <TimeSeries
            title={t.blocks.meetingsByDay!}
            days={days}
            series={[
              { key: 'talk', label: t.kpi.interlocutors!, values: series.map((day) => day.interlocutors) },
              { key: 'meetings', label: t.kpi.meetings!, values: series.map((day) => day.meetings) },
            ]}
          />
        </Block>
        <Block title={t.blocks.meetingSizes!}>
          <BarList
            ordered
            rows={report.data.meeting_sizes.map((row) => ({
              key: row.bucket,
              label: word('size', row.bucket),
              value: row.meetings,
            }))}
          />
        </Block>
        <Block title={t.blocks.meetingLengths!}>
          <BarList
            ordered
            rows={report.data.meeting_lengths.map((row) => ({
              key: row.bucket,
              label: word('length', row.bucket),
              value: row.meetings,
            }))}
          />
        </Block>
        <Block title={t.blocks.mediaHours!}>
          <BarList
            format={fmt.hours}
            rows={[
              { key: 'mic', label: word('media', 'mic'), value: totals.mic_hours },
              { key: 'cam', label: word('media', 'cam'), value: totals.cam_hours },
              { key: 'screen', label: word('media', 'screen'), value: totals.screen_hours },
            ]}
          />
        </Block>
        <Block title={t.blocks.integrationHours!}>
          <BarList
            format={fmt.hours}
            rows={(['cinema', 'music', 'game', 'board'] as const).map((kind) => ({
              key: kind,
              label: word('kind', kind),
              value: totals.integration_hours[kind],
            }))}
          />
        </Block>
        <Block title={t.blocks.frequency!} hint={t.blocks.frequencyHint}>
          <BarList
            ordered
            rows={report.data.frequency.map((row) => ({
              key: String(row.active_days),
              label: t.activeDays(String(row.active_days)),
              value: row.people,
            }))}
          />
        </Block>
        <Block title={t.blocks.features!} hint={t.blocks.featuresHint}>
          <BarList
            rows={report.data.features.map((row) => ({
              key: row.name,
              label: row.name,
              value: row.count,
              note: t.sessionsOf(fmt.count(row.sessions)),
            }))}
          />
        </Block>
        <Block title={t.blocks.screens!}>
          <BarList
            rows={report.data.screens.map((row) => ({ key: row.name, label: row.name, value: row.count }))}
          />
        </Block>
        <Block title={t.blocks.leaveReasons!}>
          <BarList
            rows={report.data.leave_reasons.map((row) => ({
              key: row.reason,
              label: word('reason', row.reason),
              value: row.count,
            }))}
          />
        </Block>
        <Block title={t.blocks.dropReasons!}>
          <BarList
            rows={report.data.drop_reasons.map((row) => ({
              key: row.reason,
              label: word('reason', row.reason),
              value: row.count,
            }))}
          />
        </Block>
      </div>
    </>
  );
}

// ── Интеграции ───────────────────────────────────────────────────────────────────────────────────
type IntegrationMetric = 'runs' | 'people' | 'watch_hours' | 'bytes';
const integrationFormat = { runs: fmt.count, people: fmt.count, watch_hours: fmt.hours, bytes: fmt.bytes };

export function IntegrationsSection({ report }: { report: Report<Integrations> }) {
  const data = report.data;
  const [metric, setMetric] = useState<IntegrationMetric>('runs');
  const columns: Column<IntegrationRow & { kind: string; variant?: string }>[] = [
    {
      key: 'name',
      label: t.columns.name!,
      cell: (row) =>
        row.variant ? (
          <>
            {row.variant} <small>{word('kind', row.kind)}</small>
          </>
        ) : (
          word('kind', row.kind)
        ),
    },
    { key: 'runs', label: t.columns.runs!, numeric: true, cell: (row) => fmt.count(row.runs) },
    { key: 'people', label: t.columns.people!, numeric: true, cell: (row) => fmt.count(row.people) },
    {
      key: 'share',
      label: t.columns.meetingShare!,
      numeric: true,
      cell: (row) => fmt.share(row.meeting_share),
    },
    { key: 'hours', label: t.columns.watchHours!, numeric: true, cell: (row) => fmt.hours(row.watch_hours) },
    { key: 'avg', label: t.columns.avgMinutes!, numeric: true, cell: (row) => fmt.minutes(row.avg_minutes) },
    { key: 'bytes', label: t.columns.bytes!, numeric: true, cell: (row) => fmt.bytes(row.bytes) },
    {
      key: 'perHour',
      label: t.columns.bytesPerHour!,
      numeric: true,
      cell: (row) => fmt.bytes(row.bytes_per_hour),
    },
    { key: 'errors', label: t.columns.errors!, numeric: true, cell: (row) => fmt.count(row.errors) },
    { key: 'stalls', label: t.columns.stalls!, numeric: true, cell: (row) => fmt.count(row.stalls) },
  ];
  return (
    <>
      <Kpis>
        <Kpi
          label={t.kpi.runs!}
          value={fmt.count(data.totals.runs)}
          change={versus(report, (d) => d.totals.runs)}
        />
        <Kpi
          label={t.kpi.integration_people!}
          value={fmt.count(data.totals.people)}
          change={versus(report, (d) => d.totals.people)}
        />
        <Kpi
          label={t.kpi.meeting_share!}
          hint={t.hints.meeting_share}
          value={fmt.share(data.totals.meeting_share)}
          change={versus(report, (d) => d.totals.meeting_share)}
        />
        <Kpi
          label={t.kpi.watch_hours!}
          hint={t.hints.watch_hours}
          value={fmt.hours(data.totals.watch_hours)}
          change={versus(report, (d) => d.totals.watch_hours)}
        />
        <Kpi
          label={t.kpi.bytes!}
          hint={t.hints.bytes}
          value={fmt.bytes(data.totals.bytes)}
          change={versus(report, (d) => d.totals.bytes)}
          note={`${t.kpi.bytes_per_hour}: ${fmt.bytes(data.totals.bytes_per_hour)}`}
        />
        <Kpi
          inverse
          label={t.kpi.integration_errors!}
          value={fmt.count(data.totals.errors)}
          change={versus(report, (d) => d.totals.errors)}
          note={`${t.kpi.stalls}: ${fmt.count(data.totals.stalls)}`}
        />
      </Kpis>
      <div className="an-grid2">
        <Block
          title={t.blocks.byVariant!}
          actions={
            <Segmented
              size="sm"
              aria-label={t.metric}
              value={metric}
              onValueChange={(value) => setMetric(value as IntegrationMetric)}
              options={(['runs', 'people', 'watch_hours', 'bytes'] as const).map((value) => ({
                value,
                label: t.metrics[value]!,
              }))}
            />
          }
        >
          <BarList
            format={integrationFormat[metric]}
            limit={10}
            rows={data.by_variant.map((row) => ({
              key: `${row.kind}:${row.variant}`,
              // У доски площадок нет: строка — сам вид.
              label: row.variant || word('kind', row.kind),
              value: row[metric],
              note: row.variant ? word('kind', row.kind) : undefined,
            }))}
          />
        </Block>
        <Block title={t.blocks.runsByDay!}>
          <TimeSeries
            title={t.blocks.runsByDay!}
            days={data.series.map((day) => day.day)}
            series={(['cinema', 'music', 'game', 'board'] as const).map((kind) => ({
              key: kind,
              label: word('kind', kind),
              values: data.series.map((day) => day[kind]),
            }))}
          />
        </Block>
        <Block title={t.blocks.byKind!} wide>
          <DataTable columns={columns} rows={data.by_kind} rowKey={(row) => row.kind} />
        </Block>
        <Block title={t.blocks.byVariant!} wide>
          <DataTable
            columns={columns}
            rows={data.by_variant}
            rowKey={(row) => `${row.kind}:${row.variant}`}
          />
        </Block>
        <Block title={t.blocks.integrationErrors!}>
          <BarList
            rows={data.errors.map((row) => ({
              key: `${row.kind}:${row.variant}:${row.code}`,
              label: row.code,
              value: row.count,
              note: [word('kind', row.kind), row.variant].filter(Boolean).join(' · '),
            }))}
          />
        </Block>
        <Block title={t.blocks.closeReasons!}>
          <BarList
            rows={data.close_reasons.map((row) => ({
              key: `${row.kind}:${row.reason}`,
              label: word('reason', row.reason),
              value: row.runs,
              note: word('kind', row.kind),
            }))}
          />
        </Block>
      </div>
    </>
  );
}

// ── Качество ─────────────────────────────────────────────────────────────────────────────────────
export function QualitySection({ report }: { report: Report<Quality> }) {
  const data = report.data;
  const nodes = [
    ...new Set([...data.join_time.by_node.map((n) => n.node), ...data.media.by_node.map((n) => n.node)]),
  ].map((node) => ({
    node,
    joined: data.join.by_node.find((n) => n.node === node)?.joined ?? null,
    timing: data.join_time.by_node.find((n) => n.node === node) as Timing | undefined,
    media: data.media.by_node.find((n) => n.node === node) as Media | undefined,
  }));
  const nodeColumns: Column<(typeof nodes)[number]>[] = [
    { key: 'node', label: t.columns.node!, cell: (row) => row.node || t.unknown },
    { key: 'joined', label: t.columns.joined!, numeric: true, cell: (row) => fmt.count(row.joined) },
    { key: 'p50', label: t.columns.p50!, numeric: true, cell: (row) => fmt.seconds(row.timing?.p50_ms) },
    { key: 'p95', label: t.columns.p95!, numeric: true, cell: (row) => fmt.seconds(row.timing?.p95_ms) },
    { key: 'loss', label: t.columns.loss!, numeric: true, cell: (row) => fmt.share(row.media?.loss_avg) },
    { key: 'rtt', label: t.columns.rtt!, numeric: true, cell: (row) => fmt.ms(row.media?.rtt_avg_ms) },
    {
      key: 'relay',
      label: t.columns.relay!,
      numeric: true,
      cell: (row) => fmt.share(row.media?.relay_share),
    },
    {
      key: 'freezes',
      label: t.columns.freezes!,
      numeric: true,
      cell: (row) => fmt.count(row.media?.freezes_per_hour),
    },
    {
      key: 'reconnects',
      label: t.columns.reconnects!,
      numeric: true,
      cell: (row) => fmt.count(row.media?.reconnects_per_hour),
    },
  ];
  const netColumns: Column<Quality['networks'][number]>[] = [
    { key: 'net', label: t.columns.net!, cell: (row) => word('net', row.net) },
    { key: 'sessions', label: t.columns.sessions!, numeric: true, cell: (row) => fmt.count(row.sessions) },
    { key: 'people', label: t.columns.people!, numeric: true, cell: (row) => fmt.count(row.people) },
    { key: 'vpn', label: t.columns.vpn!, numeric: true, cell: (row) => fmt.share(row.vpn_share) },
    { key: 'ok', label: t.columns.errorFree!, numeric: true, cell: (row) => fmt.share(row.error_free_share) },
  ];
  const media = data.media.total;
  return (
    <>
      <Kpis>
        <Kpi
          lead
          label={t.kpi.join_success!}
          hint={t.hints.join_success}
          value={fmt.share(data.join.success)}
          change={versus(report, (d) => d.join.success)}
          note={`${fmt.count(data.join.joined)} из ${fmt.count(data.join.attempts)}`}
        />
        <Kpi
          inverse
          label={t.kpi.join_p50_ms!}
          hint={t.hints.join_p50_ms}
          value={fmt.seconds(data.join_time.total.p50_ms)}
          change={versus(report, (d) => d.join_time.total.p50_ms)}
          note={`${t.kpi.join_p95_ms}: ${fmt.seconds(data.join_time.total.p95_ms)}`}
        />
        <Kpi
          label={t.kpi.error_free_sessions!}
          hint={t.hints.error_free_sessions}
          value={fmt.share(data.sessions.error_free_share)}
          change={versus(report, (d) => d.sessions.error_free_share)}
        />
        <Kpi label={t.kpi.vpn_share!} hint={t.hints.vpn_share} value={fmt.share(data.sessions.vpn_share)} />
        <Kpi
          inverse
          label={t.kpi.loss!}
          hint={t.hints.loss}
          value={fmt.share(media.loss_avg)}
          change={versus(report, (d) => d.media.total.loss_avg)}
        />
        <Kpi
          inverse
          label={t.kpi.rtt!}
          hint={t.hints.rtt}
          value={fmt.ms(media.rtt_avg_ms)}
          change={versus(report, (d) => d.media.total.rtt_avg_ms)}
        />
        <Kpi
          inverse
          label={t.kpi.relay!}
          hint={t.hints.relay}
          value={fmt.share(media.relay_share)}
          change={versus(report, (d) => d.media.total.relay_share)}
        />
        <Kpi
          inverse
          label={t.kpi.freezes!}
          value={fmt.count(media.freezes_per_hour)}
          change={versus(report, (d) => d.media.total.freezes_per_hour)}
        />
        <Kpi
          inverse
          label={t.kpi.reconnects!}
          value={fmt.count(media.reconnects_per_hour)}
          change={versus(report, (d) => d.media.total.reconnects_per_hour)}
        />
      </Kpis>
      <div className="an-grid2">
        <Block title={t.blocks.successByDay!} wide>
          <TimeSeries
            title={t.blocks.successByDay!}
            format={fmt.share}
            days={data.series.map((day) => day.day)}
            series={[
              { key: 'success', label: t.kpi.join_success!, values: data.series.map((day) => day.success) },
              {
                key: 'clean',
                label: t.kpi.error_free_sessions!,
                values: data.series.map((day) => day.error_free_share),
              },
              { key: 'vpn', label: t.kpi.vpn_share!, values: data.series.map((day) => day.vpn_share) },
            ]}
          />
        </Block>
        <Block title={t.blocks.nodes!} wide>
          <DataTable columns={nodeColumns} rows={nodes} rowKey={(row) => row.node} />
        </Block>
        <Block title={t.blocks.failures!}>
          <BarList
            rows={data.join.failures.map((row) => ({
              key: row.code,
              label: row.code,
              value: row.count,
              note: fmt.share(row.share),
            }))}
          />
        </Block>
        <Block title={t.blocks.byHow!}>
          <BarList
            rows={data.join.by_how.map((row) => ({
              key: row.how,
              label: word('how', row.how),
              value: row.count,
            }))}
          />
        </Block>
        <Block title={t.blocks.networks!} wide>
          <DataTable columns={netColumns} rows={data.networks} rowKey={(row) => row.net} />
        </Block>
        <Block title={t.blocks.drops!}>
          <BarList
            rows={data.drops.map((row) => ({
              key: row.reason,
              label: word('reason', row.reason),
              value: row.count,
            }))}
          />
        </Block>
        <Block title={t.blocks.refusals!}>
          <BarList
            rows={data.refusals.map((row) => ({ key: row.code, label: row.code, value: row.count }))}
          />
        </Block>
      </div>
    </>
  );
}

// ── Ошибки ───────────────────────────────────────────────────────────────────────────────────────
export function ErrorsSection({
  report,
  onGroup,
}: {
  report: Report<Errors>;
  onGroup: (key: string) => void;
}) {
  const data = report.data;
  const columns: Column<ErrorGroup>[] = [
    {
      key: 'code',
      label: t.columns.code!,
      cell: (row) => (
        <>
          {row.code}
          {row.is_new && <span className="an-badge">{t.newBadge}</span>}
        </>
      ),
    },
    { key: 'scope', label: t.columns.scope!, cell: (row) => row.scope },
    { key: 'cause', label: t.columns.cause!, cell: (row) => word('cause', row.cause) },
    { key: 'version', label: t.columns.version!, cell: (row) => word('source', row.version) },
    { key: 'events', label: t.columns.events!, numeric: true, cell: (row) => fmt.count(row.events) },
    { key: 'sessions', label: t.columns.sessions!, numeric: true, cell: (row) => fmt.count(row.sessions) },
    { key: 'people', label: t.columns.people!, numeric: true, cell: (row) => fmt.count(row.people) },
    {
      key: 'share',
      label: t.columns.peopleShare!,
      numeric: true,
      cell: (row) => fmt.share(row.people_share),
    },
    { key: 'first', label: t.columns.first!, cell: (row) => fmt.moment(row.first_at) },
    { key: 'last', label: t.columns.last!, cell: (row) => fmt.moment(row.last_at) },
  ];
  return (
    <>
      <Kpis>
        <Kpi
          inverse
          label={t.kpi.events!}
          value={fmt.count(data.totals.events)}
          change={versus(report, (d) => d.totals.events)}
        />
        <Kpi
          inverse
          label={t.kpi.groups!}
          value={fmt.count(data.totals.groups)}
          change={versus(report, (d) => d.totals.groups)}
          note={`${t.kpi.new_groups}: ${fmt.count(data.totals.new_groups)}`}
        />
        <Kpi
          inverse
          label={t.kpi.sessions_affected!}
          value={fmt.count(data.totals.sessions_affected)}
          change={versus(report, (d) => d.totals.sessions_affected)}
          note={fmt.share(data.totals.sessions_share)}
        />
        <Kpi
          inverse
          label={t.kpi.people_affected!}
          value={fmt.count(data.totals.people_affected)}
          change={versus(report, (d) => d.totals.people_affected)}
          note={fmt.share(data.totals.people_share)}
        />
      </Kpis>
      <div className="an-grid2">
        <Block title={t.blocks.errorsByDay!}>
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
        <Block title={t.blocks.byCause!}>
          <BarList
            rows={data.by_cause.map((row) => ({
              key: row.cause,
              label: word('cause', row.cause),
              value: row.events,
              note: `${t.kpi.groups}: ${fmt.count(row.groups)} · ${t.columns.people}: ${fmt.count(row.people)}`,
            }))}
          />
        </Block>
        <Block title={t.blocks.groups!} hint={t.blocks.groupsHint} wide>
          <DataTable
            columns={columns}
            rows={data.groups}
            rowKey={(row) => row.key}
            onRow={(row) => onGroup(row.key)}
          />
        </Block>
      </div>
    </>
  );
}

// ── Трафик ───────────────────────────────────────────────────────────────────────────────────────
const CLASSES = ['human', 'unclear', 'bot', 'automation', 'own'] as const;

export function TrafficSection({ report }: { report: Report<Traffic> }) {
  const data = report.data;
  const columns = (group: string): Column<Visits & { key: string }>[] => [
    { key: 'key', label: t.columns.name!, cell: (row) => word(group, row.key) },
    ...CLASSES.map((name) => ({
      key: name,
      label: t.columns[name]!,
      numeric: true,
      cell: (row: Visits) => fmt.count(row[name]),
    })),
  ];
  return (
    <>
      <Kpis>
        <Kpi
          label={t.kpi.visits!}
          value={fmt.count(data.totals.visits)}
          change={versus(report, (d) => d.totals.visits)}
        />
        <Kpi
          lead
          label={t.kpi.human_share!}
          hint={t.hints.human_share}
          value={fmt.share(data.totals.human_share)}
          change={versus(report, (d) => d.totals.human_share)}
          note={`${t.columns.human}: ${fmt.count(data.totals.human)}`}
        />
        <Kpi label={t.kpi.unclear!} value={fmt.count(data.totals.unclear)} />
        <Kpi
          inverse
          label={t.kpi.bots!}
          value={fmt.count(data.totals.bot)}
          change={versus(report, (d) => d.totals.bot)}
        />
        <Kpi label={t.kpi.automation!} value={fmt.count(data.totals.automation)} />
        <Kpi label={t.kpi.own!} value={fmt.count(data.totals.own)} />
      </Kpis>
      <div className="an-grid2">
        <Block title={t.blocks.visitsByDay!} wide>
          <TimeSeries
            title={t.blocks.visitsByDay!}
            days={data.series.map((day) => day.day)}
            series={CLASSES.map((name) => ({
              key: name,
              label: word('class', name),
              values: data.series.map((day) => day[name]),
            }))}
          />
        </Block>
        <Block title={t.blocks.byClass!}>
          <BarList
            ordered
            rows={data.by_class.map((row) => ({
              key: row.class,
              label: word('class', row.class),
              value: row.visits,
              note: fmt.share(row.share),
            }))}
          />
        </Block>
        <Block title={t.blocks.botNames!}>
          <BarList
            limit={10}
            rows={data.bots.map((row) => ({ key: row.bot, label: row.bot, value: row.visits }))}
          />
        </Block>
        <Block title={t.blocks.byClient!}>
          <DataTable columns={columns('client')} rows={data.by_client} rowKey={(row) => row.key} />
        </Block>
        <Block title={t.blocks.byOs!}>
          <DataTable columns={columns('os')} rows={data.by_os} rowKey={(row) => row.key} />
        </Block>
        <Block title={t.blocks.byCountry!}>
          <DataTable columns={columns('country')} rows={data.by_country} rowKey={(row) => row.key} />
        </Block>
        <Block title={t.blocks.byNetwork!}>
          <DataTable columns={columns('net')} rows={data.by_network} rowKey={(row) => row.key} />
        </Block>
      </div>
    </>
  );
}
