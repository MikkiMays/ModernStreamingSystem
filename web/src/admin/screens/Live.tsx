import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Switch } from '../../ui/kit';
import { text } from '../../i18n/admin/ru';
import { fleet, type Live as LiveData, type LiveHistory, type LiveMachine, type LiveRoom } from '../api';
import { Meter, Sparkline } from '../charts';
import { Empty, ErrorLine, Panel, Skeleton, Tile, duration, gigabytes, percent } from '../parts';

const t = text.live;

/**
 * «Флот — live» (R209): весь флот одним экраном раз в 5 с — железо и нагрузка каждой машины, ядро Cord, SFU,
 * шлюз, контейнеры, встречи и кто нагружает сеть; ряды за 30 минут — раз в 30 с. Источник упал — данные
 * прошлого обновления остаются с пометкой времени (§7 admin-panel.md).
 */
export function Live() {
  const [paused, setPaused] = useState(false);
  const live = useQuery({
    queryKey: ['live'],
    queryFn: () => fleet.get<LiveData>('/live'),
    refetchInterval: paused ? false : 5_000,
    staleTime: 0,
  });
  const history = useQuery({
    queryKey: ['live-history'],
    queryFn: () => fleet.get<LiveHistory>('/live/history', { minutes: 30 }),
    refetchInterval: paused ? false : 30_000,
  });
  const data = live.data;
  const busiest = data?.totals.busiest
    ? data.machines.find((m) => m.id === data.totals.busiest!.machine)
    : null;
  return (
    <div className="admin-stack">
      <Panel
        title={t.totals}
        actions={
          <>
            <span className="admin-hint" aria-live="polite">
              {paused ? t.paused : t.every}
              {data && ` · ${t.stale} ${new Date(data.serverTime * 1000).toLocaleTimeString('ru-RU')}`}
            </span>
            <Switch checked={paused} onCheckedChange={setPaused} label={t.pause} />
          </>
        }
      >
        <ErrorLine error={live.error} onRetry={() => void live.refetch()} />
        {data?.error && <p className="admin-warning">{data.error}</p>}
        {live.isPending && <Skeleton rows={2} />}
        {data && (
          <div className="admin-tiles">
            <Tile value={count(data.totals.meetings)} label={t.meetings} />
            <Tile value={count(data.totals.waiting)} label={t.waiting} />
            <Tile value={count(data.totals.humans)} label={t.humans} />
            <Tile value={count(data.totals.screens)} label={t.screens} />
            <Tile value={count(data.totals.integrations)} label={t.integrations} />
            <Tile value={mbps(data.totals.netInMbps)} label={t.netIn} />
            <Tile value={mbps(data.totals.netOutMbps)} label={t.netOut} />
            <Tile
              value={busiest ? busiest.title : '—'}
              label={`${t.busiest}${data.totals.busiest ? ` · ${t.cpu} ${percent(data.totals.busiest.cpu)}` : ''}`}
              tone={data.totals.busiest && data.totals.busiest.cpu >= 0.8 ? 'bad' : undefined}
              compact
            />
          </div>
        )}
      </Panel>
      {data && data.machines.length === 0 && <Empty>{t.noMachines}</Empty>}
      {data && data.machines.length > 1 && (
        <Panel title={t.whereLoad}>
          <div className="admin-compare">
            {[...data.machines]
              .sort((a, b) => (b.load.cpu ?? -1) - (a.load.cpu ?? -1))
              .map((m) => (
                <Meter
                  key={m.id}
                  label={m.title}
                  value={m.load.cpu}
                  suffix={` · ${mbps(m.load.netOutMbps)} ↑`}
                />
              ))}
          </div>
        </Panel>
      )}
      <div className="admin-live-grid">
        {data?.machines.map((machine) => (
          <MachineCard key={machine.id} machine={machine} history={history.data?.machines[machine.id]} />
        ))}
      </div>
    </div>
  );
}

function MachineCard({
  machine: m,
  history,
}: {
  machine: LiveMachine;
  history?: LiveHistory['machines'][string];
}) {
  const hw = m.hardware;
  const load = m.load;
  const uptime = hw.bootTime ? Date.now() / 1000 - hw.bootTime : null;
  const specs = [
    hw.cores !== null && `${hw.cores} ${t.cores}`,
    hw.memTotalBytes !== null && `${t.ram} ${gigabytes(hw.memTotalBytes)}`,
    hw.diskTotalBytes !== null && `${t.disk} ${gigabytes(hw.diskTotalBytes)}`,
    hw.os,
    hw.kernel && `${t.kernel} ${hw.kernel}`,
    hw.arch,
    hw.virtualization,
  ].filter(Boolean);
  return (
    <section className="admin-panel admin-live-card" aria-label={m.title}>
      <header className="admin-panel__head">
        <h2>
          {m.title}
          {m.product && <span className="admin-hint"> · {m.product}</span>}
        </h2>
        <div className="admin-panel__actions">
          <Badge variant="neutral">{text.overview.role[m.role] ?? m.role}</Badge>
          {m.core?.version && (
            <span className="admin-hint">
              {t.version} {m.core.version}
            </span>
          )}
        </div>
      </header>
      <p className="admin-hint">
        {[m.host, hw.hostname, uptime !== null && `${t.uptime} ${days(uptime)}`].filter(Boolean).join(' · ')}
      </p>
      <p className="admin-specs">{specs.join(' · ') || '—'}</p>
      <ul className="admin-sources" aria-label={text.live.sources.node}>
        {(Object.keys(m.sources) as (keyof LiveMachine['sources'])[]).map((source) => {
          const state = m.sources[source];
          return (
            <li key={source} title={state === null ? t.sourceNone : state ? t.sourceUp : t.sourceDown}>
              <span
                className="admin-dot"
                data-state={state === null ? 'unknown' : state ? 'ok' : 'bad'}
                aria-hidden="true"
              />
              {t.sources[source]}
              <span className="sr-only">
                : {state === null ? t.sourceNone : state ? t.sourceUp : t.sourceDown}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="admin-meters">
        <Meter label={t.cpu} value={load.cpu} />
        <Meter label={t.steal} value={load.steal} warn={0.1} bad={0.3} hint={t.stealHint} />
        <Meter label={t.mem} value={load.memUsed} warn={0.8} bad={0.92} />
        <Meter label={t.diskUsed} value={load.diskUsed} warn={0.8} bad={0.9} />
        <Meter label={t.load1} value={load.load1} warn={0.8} bad={1.2} />
        <Meter label={t.psi} value={load.psiCpu} warn={0.1} bad={0.25} hint={t.psiHint} />
      </div>
      <dl className="admin-dl admin-dl--compact">
        <dt>{t.network}</dt>
        <dd>
          {t.in} {mbps(load.netInMbps)} · {t.out} {mbps(load.netOutMbps)} {text.units.mbps}
        </dd>
        <dt>{t.tcp}</dt>
        <dd>{count(load.tcpEstablished)}</dd>
        <dt>{t.netErrors}</dt>
        <dd data-tone={load.netErrorsPerSec ? 'bad' : undefined}>{fixed(load.netErrorsPerSec, 2)}</dd>
        <dt>{t.diskIo}</dt>
        <dd>
          {fixed(load.diskReadMBps, 1)} / {fixed(load.diskWriteMBps, 1)} {text.units.mbs}
        </dd>
        <dt>
          {t.swap} · {t.iowait}
        </dt>
        <dd>
          {gigabytes(load.swapUsedBytes)} · {percent(load.iowait)}
        </dd>
      </dl>
      {history && (
        <div className="admin-sparks">
          <Sparkline points={history.cpu} label={t.historyCpu} format={(v) => percent(v)} max={1} />
          <Sparkline points={history.netOutMbps} label={t.historyOut} format={(v) => mbps(v)} />
          {m.core && (
            <Sparkline points={history.connected} label={t.historyPeople} format={(v) => count(v)} />
          )}
        </div>
      )}
      {m.core && <CoreBlock core={m.core} />}
      {(m.sfu || m.gateway) && (
        <dl className="admin-dl admin-dl--compact">
          {m.sfu && (
            <>
              <dt>{t.sfu}</dt>
              <dd>
                {count(m.sfu.rooms)} {t.sfuRooms} · {count(m.sfu.participants)} {t.sfuParticipants} · {t.in}{' '}
                {mbps(m.sfu.inMbps)} · {t.out} {mbps(m.sfu.outMbps)} {text.units.mbps}
                {m.sfu.lossPercent !== null && ` · ${t.loss} ${fixed(m.sfu.lossPercent, 1)} %`}
                {m.sfu.rttMs !== null && ` · ${t.rtt} ${Math.round(m.sfu.rttMs)} ${text.units.ms}`}
              </dd>
            </>
          )}
          {m.gateway && (
            <>
              <dt>{t.gateway}</dt>
              <dd>
                {fixed(m.gateway.rps, 1)} {t.rps} · {count(m.gateway.inFlight)} {t.inFlight}
                {m.gateway.errorsPerSec !== null &&
                  ` · ${fixed(m.gateway.errorsPerSec, 2)} ${t.gatewayErrors}`}
              </dd>
            </>
          )}
        </dl>
      )}
      <Containers machine={m} />
      <MeetingsNow machine={m} />
    </section>
  );
}

function CoreBlock({ core }: { core: NonNullable<LiveMachine['core']> }) {
  const open = Object.entries(core.integrations).filter(([, n]) => (n ?? 0) > 0);
  const shares = Object.entries(core.loadShare);
  return (
    <div className="admin-live-core">
      <h3>{t.core}</h3>
      <p>
        <strong>{count(core.live)}</strong> {t.live} · {count(core.waiting)} {t.waitingShort} ·{' '}
        <strong>{count(core.connected)}</strong> {t.people} · {count(core.screens)} {text.overview.screens} ·{' '}
        {count(core.bots)} {t.bots}
      </p>
      <p className="admin-chips">
        {open.length === 0 ? (
          <span className="admin-hint">{t.noIntegrations}</span>
        ) : (
          open.map(([kind, n]) => (
            <Badge key={kind} variant="accent">
              {t.integrationKinds[kind] ?? kind} · {count(n)}
            </Badge>
          ))
        )}
      </p>
      <p className="admin-hint">
        {fixed(core.joinsPerMin, 1)} {t.joins}
        {text.units.perMin} · {fixed(core.failuresPerMin, 1)} {t.failures}
        {text.units.perMin} · {fixed(core.clientErrorsPerMin, 1)} {t.clientErrors}
        {text.units.perMin}
      </p>
      {core.loadLevel !== null && (
        <p className="admin-hint">
          {t.loadLevel}: <strong>{core.loadLevel}</strong>
          {shares.length > 0 && ' · '}
          {shares.map(([kind, share]) => `${t.loadShare[kind] ?? kind} ${percent(share)}`).join(' · ')}
        </p>
      )}
      {core.nodes.length > 0 && (
        <p className="admin-hint">
          {t.nodes}:{' '}
          {core.nodes
            .map(
              (n) =>
                `${n.node} ${n.up === 0 ? `(${t.nodeDown})` : ''} ${count(n.rooms)} ${t.sfuRooms} / ${count(n.participants)} ${t.people}`,
            )
            .join(' · ')}
        </p>
      )}
    </div>
  );
}

function Containers({ machine: m }: { machine: LiveMachine }) {
  if (m.containers.length === 0)
    return (
      <p className="admin-hint">
        {t.containers}: {m.sources.containers === null ? t.containersNone : t.containersEmpty}
      </p>
    );
  return (
    <div className="admin-table-wrap">
      <table className="admin-table">
        <caption className="admin-caption">{t.containers}</caption>
        <thead>
          <tr>
            <th>{t.container}</th>
            <th>{t.cpu}</th>
            <th>{t.memory}</th>
            <th>
              {t.in} / {t.out}, {text.units.mbps}
            </th>
          </tr>
        </thead>
        <tbody>
          {m.containers.map((c) => (
            <tr key={c.name}>
              <td>
                <code>{c.name}</code>
              </td>
              <td>{percent(c.cpu)}</td>
              <td>{gigabytes(c.memBytes)}</td>
              <td>
                {mbps(c.inMbps)} / {mbps(c.outMbps)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Исходящих потоков SFU у встречи: каждый на связи получает звук и видео остальных и каждый показ. */
export function streams(room: Pick<LiveRoom, 'connected' | 'screens'>): number {
  const people = Math.max(0, room.connected);
  return people * Math.max(0, people - 1) + room.screens * Math.max(0, people - 1);
}

function MeetingsNow({ machine: m }: { machine: LiveMachine }) {
  if (!m.core) return null;
  if (!m.now) return <p className="admin-hint">{t.noCore}</p>;
  if (m.now.error)
    return (
      <p className="admin-hint">
        <Badge variant="danger" title={m.now.error.detail}>
          {m.now.error.code}
        </Badge>
      </p>
    );
  const now = m.now.data!;
  if (now.rooms.length === 0) return <p className="admin-hint">{t.noNow}</p>;
  const rooms = [...now.rooms].sort((a, b) => streams(b) - streams(a));
  return (
    <div className="admin-table-wrap">
      <table className="admin-table">
        <caption className="admin-caption" title={t.nowHint}>
          {t.nowTitle}
        </caption>
        <thead>
          <tr>
            <th>{text.meetings.code}</th>
            <th>{text.meetings.humans}</th>
            <th>{text.meetings.screens}</th>
            <th title={t.nowHint}>{t.streams}</th>
            <th>{text.nav.nodes}</th>
            <th>{text.meetings.since}</th>
          </tr>
        </thead>
        <tbody>
          {rooms.map((room) => (
            <tr key={room.id}>
              <td>
                <code>{room.code}</code>
                {room.integrations.map((kind) => (
                  <span key={kind} className="admin-hint">
                    {' '}
                    · {t.integrationKinds[kind] ?? kind}
                  </span>
                ))}
              </td>
              <td>
                {room.connected}/{room.humans}
              </td>
              <td>{room.screens}</td>
              <td>{streams(room)}</td>
              <td>{room.mediaNode ?? '—'}</td>
              <td>
                {room.startedAt ? duration(Math.max(0, (now.serverTime - room.startedAt) / 1000)) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function count(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : String(Math.round(value));
}

function fixed(value: number | null | undefined, digits: number): string {
  return value === null || value === undefined ? '—' : value.toFixed(digits);
}

export function mbps(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
}

function days(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  return d >= 1 ? `${d} ${text.units.days}` : duration(seconds);
}
