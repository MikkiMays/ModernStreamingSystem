import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { Button, Segmented } from '../../ui/kit';
import { text } from '../../i18n/admin/ru';
import { fleet } from '../api';
import type { Console } from '../AdminApp';
import { BarList, Block, DataTable, Kpi, Kpis, fmt, type Column } from '../analytics/charts';
import { word } from '../analytics/sections';
import type { Quality, Report, Traffic } from '../analytics/types';
import { coreOf, useEnvironment } from '../environment';
import { Empty, ErrorLine, Skeleton, duration } from '../parts';
import { isoDay } from './Analytics';
import '../analytics/charts.css';
import './overview.css';

const t = text.security;

/** Ядро о своей защите (`GET /api/v1/admin/server`). */
type Server = {
  shield: boolean;
  blocksActive: number;
  autoBlockCount: number;
  autoBlockWindowMs: number;
  autoBlockTermMs: number;
  blockDefaultMs: number;
};

/** Блокировка ядра (`GET /api/v1/admin/blocks`): адрес или профиль, кто поставил и до какого времени. */
type BlockRow = {
  id: string;
  kind: string;
  subject: string;
  reason?: string;
  createdBy?: string;
  createdAt: number;
  expiresAt?: number;
  liftedAt?: number;
};

const DAYS = 7;

/**
 * «Безопасность» (R234): что делает защита прямо сейчас и за неделю. Сверху — включён ли щит и сколько
 * блокировок действует; ниже — сами блокировки (снять можно здесь же), отказы защиты по кодам и кто ходит
 * к нам помимо людей. Числа недели — из аналитики (`insight`), блокировки и щит — из ядра выбранной среды.
 */
export function Security({ console }: { console: Console }) {
  const [environment, setEnvironment] = useEnvironment();
  const client = useQueryClient();
  const core = coreOf(console.machines, environment);
  const to = new Date();
  const from = new Date(to.getTime() - (DAYS - 1) * 86_400_000);
  const period = { env: environment, from: isoDay(from), to: isoDay(to), compare: 1 };
  const server = useQuery({
    queryKey: ['security', 'server', core?.id],
    queryFn: () => fleet.get<Server>(`/core/${core!.id}/server`),
    enabled: !!core,
    refetchInterval: 30_000,
  });
  const blocks = useQuery({
    queryKey: ['security', 'blocks', core?.id],
    queryFn: () => fleet.get<BlockRow[]>(`/core/${core!.id}/blocks`),
    enabled: !!core,
    refetchInterval: 30_000,
  });
  const quality = useQuery({
    queryKey: ['insight', 'quality', period],
    queryFn: () => fleet.get<Report<Quality>>('/insight/quality', period),
    enabled: !!core,
    staleTime: 60_000,
  });
  const traffic = useQuery({
    queryKey: ['insight', 'traffic', period],
    queryFn: () => fleet.get<Report<Traffic>>('/insight/traffic', period),
    enabled: !!core,
    staleTime: 60_000,
  });
  const lift = useMutation({
    mutationFn: (id: string) => fleet.delete(`/core/${core!.id}/blocks/${id}`),
    onSettled: () => client.invalidateQueries({ queryKey: ['security'] }),
  });
  const environments = (
    <Segmented
      size="sm"
      aria-label={text.analytics.environment}
      value={environment}
      onValueChange={setEnvironment}
      options={[
        { value: 'product', label: text.pulse.environments.product },
        { value: 'dev', label: text.pulse.environments.dev },
      ]}
    />
  );
  if (!core)
    return (
      <div className="an">
        <div className="an-bar">{environments}</div>
        <Empty>{text.analytics.noCore}</Empty>
      </div>
    );
  const now = Date.now();
  const active = (blocks.data ?? []).filter(
    (row) => !row.liftedAt && (!row.expiresAt || row.expiresAt > now),
  );
  const refusals = quality.data?.data.refusals ?? [];
  const refused = refusals.reduce((sum, row) => sum + row.count, 0);
  const totals = traffic.data?.data.totals;
  const shield = server.data?.shield;
  const columns: Column<BlockRow>[] = [
    { key: 'subject', label: t.columns.subject, cell: (row) => <code>{row.subject}</code> },
    { key: 'kind', label: t.columns.kind, cell: (row) => t.kinds[row.kind] ?? row.kind },
    { key: 'reason', label: t.columns.reason, cell: (row) => row.reason || '—' },
    { key: 'by', label: t.columns.by, cell: (row) => t.by[row.createdBy ?? ''] ?? row.createdBy ?? '—' },
    {
      key: 'since',
      label: t.columns.since,
      cell: (row) => fmt.moment(new Date(row.createdAt).toISOString()),
    },
    {
      key: 'left',
      label: t.columns.left,
      cell: (row) => (row.expiresAt ? duration(Math.max(0, row.expiresAt - now) / 1000) : t.forever),
    },
    {
      key: 'lift',
      label: '',
      cell: (row) => (
        <Button
          size="sm"
          variant="secondary"
          disabled={lift.isPending}
          onClick={() => lift.mutate(row.id)}
          aria-label={t.liftOf(row.subject)}
        >
          {t.lift}
        </Button>
      ),
    },
  ];
  return (
    <div className="an">
      <div className="an-bar">
        {environments}
        <span className="an-bar__meta">{t.period(DAYS)}</span>
      </div>
      {server.error && <ErrorLine error={server.error} onRetry={() => void server.refetch()} />}
      <header className="pulse__head" data-level={shield ? 'warn' : 'ok'}>
        <span className="pulse__state">
          {shield ? <ShieldAlert aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}
          <strong>{server.data ? (shield ? t.shieldOn : t.shieldOff) : text.app.loading}</strong>
          {server.data && (
            <span>
              {shield ? t.shieldOnHint : t.shieldOffHint}{' '}
              {t.autoBlock(
                String(server.data.autoBlockCount),
                duration(server.data.autoBlockWindowMs / 1000),
                duration(server.data.autoBlockTermMs / 1000),
              )}
            </span>
          )}
        </span>
      </header>
      <Kpis>
        <Kpi label={t.kpi.blocks} value={fmt.count(server.data?.blocksActive ?? active.length)} />
        <Kpi
          inverse
          label={t.kpi.refusals}
          hint={t.hints.refusals}
          value={quality.data ? fmt.count(refused) : '—'}
          change={
            quality.data?.previous
              ? ratio(
                  refused,
                  quality.data.previous.data.refusals.reduce((sum, row) => sum + row.count, 0),
                )
              : undefined
          }
        />
        <Kpi
          inverse
          label={t.kpi.bots}
          hint={t.hints.bots}
          value={fmt.count(totals ? totals.bot + totals.automation : null)}
          change={
            traffic.data?.previous
              ? ratio(
                  totals!.bot + totals!.automation,
                  traffic.data.previous.data.totals.bot + traffic.data.previous.data.totals.automation,
                )
              : undefined
          }
        />
        <Kpi
          label={text.analytics.kpi.human_share!}
          hint={text.analytics.hints.human_share}
          value={fmt.share(totals?.human_share)}
        />
        <Kpi
          label={text.analytics.kpi.join_success!}
          hint={text.analytics.hints.join_success}
          value={fmt.share(quality.data?.data.join.success)}
        />
      </Kpis>
      <Block title={t.blocksTitle} hint={t.blocksHint} wide>
        {blocks.error ? (
          <ErrorLine error={blocks.error} onRetry={() => void blocks.refetch()} />
        ) : !blocks.data ? (
          <Skeleton rows={3} />
        ) : active.length ? (
          <DataTable columns={columns} rows={active} rowKey={(row) => row.id} />
        ) : (
          <p className="an-empty">{t.noBlocks}</p>
        )}
        {lift.error && <ErrorLine error={lift.error} />}
      </Block>
      {(quality.error || traffic.error) && (
        <ErrorLine
          error={quality.error ?? traffic.error}
          onRetry={() => {
            void quality.refetch();
            void traffic.refetch();
          }}
        />
      )}
      <div className="an-grid2">
        <Block title={text.analytics.blocks.refusals!} hint={t.hints.refusals}>
          <BarList rows={refusals.map((row) => ({ key: row.code, label: row.code, value: row.count }))} />
        </Block>
        <Block title={text.analytics.blocks.failures!}>
          <BarList
            rows={(quality.data?.data.join.failures ?? []).map((row) => ({
              key: row.code,
              label: row.code,
              value: row.count,
              note: fmt.share(row.share),
            }))}
          />
        </Block>
        <Block title={text.analytics.blocks.byClass!}>
          <BarList
            ordered
            rows={(traffic.data?.data.by_class ?? []).map((row) => ({
              key: row.class,
              label: word('class', row.class),
              value: row.visits,
              note: fmt.share(row.share),
            }))}
          />
        </Block>
        <Block title={text.analytics.blocks.botNames!}>
          <BarList
            limit={10}
            rows={(traffic.data?.data.bots ?? []).map((row) => ({
              key: row.bot,
              label: row.bot,
              value: row.visits,
            }))}
          />
        </Block>
      </div>
    </div>
  );
}

function ratio(now: number, before: number): number | null {
  return before > 0 ? (now - before) / before : null;
}
