import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Flag, Switch } from '../../ui/kit';
import { text } from '../../i18n/admin/ru';
import { fleet, type Live as LiveData, type LiveHistory, type LiveMachine, type LiveRoom } from '../api';
import { Meter, Sparkline } from '../charts';
import {
  Dot,
  Empty,
  ErrorLine,
  Panel,
  Pill,
  Skeleton,
  Stat,
  Stats,
  duration,
  gigabytes,
  percent,
} from '../parts';
import { NODE_TONE, useProductNodes, type NodeState } from '../nodes';
import type { Console } from '../AdminApp';

const t = text.live;

/**
 * «Флот — live» (R209): весь флот одним экраном раз в 5 с — железо и нагрузка каждой машины, ядро Cord, SFU,
 * шлюз, контейнеры, встречи и кто нагружает сеть; ряды за 30 минут — раз в 30 с. Источник упал — данные
 * прошлого обновления остаются с пометкой времени (§7 admin-panel.md).
 */
export function Live({ console }: { console: Console }) {
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
  // Ядро продукта — по `/machines` (учётные данные пульта); `core` у машины в `/live` — это метрики ядра.
  const { core: productMachine, states } = useProductNodes(console.machines);
  const productLive = data?.machines.find((m) => m.id === productMachine?.id) ?? null;
  const busiest = data?.totals.busiest
    ? data.machines.find((m) => m.id === data.totals.busiest!.machine)
    : null;
  // Переход с обзора по машине (`/live#machine-meet`) — карточка этой машины в окне, когда данные пришли.
  const ready = !!data;
  useEffect(() => {
    if (!ready || !location.hash.startsWith('#machine-')) return;
    document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'start' });
  }, [ready]);
  return (
    <div className="admin-stack">
      <Panel
        title={t.totals}
        actions={
          <div className="admin-live-bar">
            <span className="admin-hint" aria-live="polite">
              {paused ? t.paused : t.every}
              {data && ` · ${t.stale} ${new Date(data.serverTime * 1000).toLocaleTimeString('ru-RU')}`}
            </span>
            <Switch checked={paused} onCheckedChange={setPaused} label={t.pause} />
          </div>
        }
      >
        <ErrorLine
          error={live.error}
          onRetry={() => void live.refetch()}
          updatedAt={data ? live.dataUpdatedAt : undefined}
        />
        {data?.error && <p className="admin-warning">{data.error}</p>}
        {live.isPending && <Skeleton rows={2} />}
        {data && (
          <Stats>
            <Stat value={count(data.totals.meetings)} label={t.meetings} />
            <Stat value={count(data.totals.waiting)} label={t.waiting} />
            <Stat value={count(data.totals.humans)} label={t.humans} />
            <Stat value={count(data.totals.screens)} label={t.screens} />
            <Stat value={count(data.totals.integrations)} label={t.integrations} />
            <Stat value={mbps(data.totals.netInMbps)} label={t.netIn} />
            <Stat value={mbps(data.totals.netOutMbps)} label={t.netOut} />
            <Stat
              value={busiest ? busiest.title : '—'}
              label={t.busiest}
              note={data.totals.busiest ? `${t.cpu} ${percent(data.totals.busiest.cpu)}` : undefined}
              tone={data.totals.busiest && data.totals.busiest.cpu >= 0.8 ? 'bad' : undefined}
              compact
            />
          </Stats>
        )}
      </Panel>
      {data && data.machines.length === 0 && <Empty>{t.noMachines}</Empty>}
      {data && data.machines.length > 1 && (
        <Panel title={t.whereLoad} description={t.whereLoadHint}>
          <div className="admin-compare">
            {[...data.machines]
              .sort((a, b) => (b.load.cpu ?? -1) - (a.load.cpu ?? -1))
              .map((m) => (
                <Meter
                  key={m.id}
                  label={m.title}
                  value={m.load.cpu}
                  suffix={` · ${mbps(m.load.netOutMbps)} ${text.units.mbps} ${t.out}`}
                />
              ))}
          </div>
        </Panel>
      )}
      <div className="admin-live-grid">
        {data?.machines.map((machine) => (
          <MachineCard
            key={machine.id}
            machine={machine}
            history={history.data?.machines[machine.id]}
            states={states}
            product={productLive}
          />
        ))}
      </div>
    </div>
  );
}

function MachineCard({
  machine: m,
  history,
  states,
  product,
}: {
  machine: LiveMachine;
  history?: LiveHistory['machines'][string];
  /** Узлы ядра продукта по реестру и ступеням. */
  states: Map<string, NodeState>;
  /** Машина ядра продукта — у медиаузла связь с ней, а не своё ядро. */
  product: LiveMachine | null;
}) {
  const mediaNode = m.role === 'media-node' && !m.core;
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
  const sources = Object.values(m.sources);
  const state = sources.some((v) => v === false) ? (m.sources.node === false ? 'bad' : 'warn') : 'ok';
  return (
    <section className="admin-panel admin-live-card" aria-label={m.title} id={`machine-${m.id}`}>
      <header className="admin-panel__head">
        <div className="admin-panel__titles">
          <h2>
            <Dot state={state} />
            {m.title}
            {m.product && <span className="admin-hint">{m.product}</span>}
          </h2>
          <p className="admin-panel__description">
            {[m.host, hw.hostname, uptime !== null && `${t.uptime} ${days(uptime)}`]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <div className="admin-panel__actions">
          <Pill>{text.overview.role[m.role] ?? m.role}</Pill>
          {m.core?.version && (
            <Pill>
              {t.version} {m.core.version}
            </Pill>
          )}
        </div>
      </header>
      <div className="admin-panel__body">
        <p className="admin-specs">{specs.join(' · ') || '—'}</p>
        <ul className="admin-sources" aria-label={t.sourcesTitle}>
          {(Object.keys(m.sources) as (keyof LiveMachine['sources'])[])
            .filter((source) => !(mediaNode && source === 'core'))
            .map((source) => {
              const value = m.sources[source];
              const word = value === null ? t.sourceNone : value ? t.sourceUp : t.sourceDown;
              return (
                <li key={source} title={word}>
                  <Dot state={value === null ? 'unknown' : value ? 'ok' : 'bad'} />
                  {t.sources[source]}
                  <span className="sr-only">: {word}</span>
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
        {mediaNode && <NodeLink machine={m} states={states} product={product} />}
        {m.core && <CoreBlock core={m.core} states={states} />}
        {(m.sfu || m.gateway) && (
          <dl className="admin-dl admin-dl--compact admin-block">
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
      </div>
    </section>
  );
}

/** Магистраль до узла по ядру: `cord_node_up` — 1, связь есть; 0 — нет; не пришло — нет данных. */
function Backbone({ up }: { up: number | null | undefined }) {
  const known = up !== null && up !== undefined;
  return (
    <Pill tone={!known ? 'neutral' : up > 0 ? 'ok' : 'bad'} dot>
      {t.backbone}: {!known ? t.backboneUnknown : up > 0 ? t.backboneUp : t.backboneDown}
    </Pill>
  );
}

function RegistryState({ state }: { state: NodeState | undefined }) {
  if (!state) return <Pill tone="warn">{t.notInRegistry}</Pill>;
  return (
    <Pill tone={state.state ? (NODE_TONE[state.state] ?? 'neutral') : 'neutral'} dot>
      {t.registry}: {state.state ? (text.nodes.states[state.state] ?? state.state) : text.nodes.enabled}
    </Pill>
  );
}

/**
 * Медиаузел и ядро продукта (R220): своего ядра у узла нет — показываем, чей он узел, его состояние в реестре ядра,
 * магистраль по ядру и сколько на нём комнат и людей.
 */
function NodeLink({
  machine: m,
  states,
  product,
}: {
  machine: LiveMachine;
  states: Map<string, NodeState>;
  product: LiveMachine | null;
}) {
  const id = m.nodeId ?? m.id;
  const state = states.get(id);
  const seen = product?.core?.nodes.find((n) => n.node === id);
  return (
    <div className="admin-block">
      <h3>{t.linkTitle}</h3>
      <p className="admin-row">
        {state?.country && <Flag country={state.country} />}
        <strong>{id}</strong>
        {state?.title && <span>{state.title}</span>}
        {product && (
          <span className="admin-hint">
            → {t.linkCore} {product.title}
            {product.product ? ` · ${product.product}` : ''}
          </span>
        )}
      </p>
      <div className="admin-row">
        <RegistryState state={state} />
        <Backbone up={seen?.up} />
      </div>
      {seen && (
        <p className="admin-hint">
          {count(seen.rooms)} {t.sfuRooms} · {count(seen.participants)} {t.people}
        </p>
      )}
      <p className="admin-hint">{t.linkHint}</p>
    </div>
  );
}

function CoreBlock({
  core,
  states,
}: {
  core: NonNullable<LiveMachine['core']>;
  states: Map<string, NodeState>;
}) {
  const open = Object.entries(core.integrations).filter(([, n]) => (n ?? 0) > 0);
  const shares = Object.entries(core.loadShare);
  return (
    <div className="admin-block">
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
            <Pill key={kind}>
              {t.integrationKinds[kind] ?? kind} · {count(n)}
            </Pill>
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
        <div className="admin-table-wrap">
          <table className="admin-table" data-stack>
            <caption className="admin-caption">{t.nodes}</caption>
            <thead>
              <tr>
                <th>{t.nodeCol}</th>
                <th>{t.stateCol}</th>
                <th>{t.backboneCol}</th>
                <th data-num>{t.roomsCol}</th>
                <th data-num>{t.participantsCol}</th>
              </tr>
            </thead>
            <tbody>
              {core.nodes.map((n) => {
                const state = states.get(n.node);
                return (
                  <tr key={n.node}>
                    <td data-primary>
                      <span className="admin-row">
                        {state?.country && <Flag country={state.country} />}
                        <strong>{n.node}</strong>
                        {state?.title && <span className="admin-hint">{state.title}</span>}
                      </span>
                    </td>
                    <td data-label={t.stateCol}>
                      {state?.state ? (
                        <Pill tone={NODE_TONE[state.state] ?? 'neutral'} dot>
                          {text.nodes.states[state.state] ?? state.state}
                        </Pill>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td data-label={t.backboneCol}>
                      {n.up === null ? (
                        '—'
                      ) : n.up > 0 ? (
                        t.backboneUp
                      ) : (
                        <span data-tone="bad">{t.backboneDown}</span>
                      )}
                    </td>
                    <td data-num data-label={t.roomsCol}>
                      {count(n.rooms)}
                    </td>
                    <td data-num data-label={t.participantsCol}>
                      {count(n.participants)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Containers({ machine: m }: { machine: LiveMachine }) {
  if (m.containers.length === 0)
    return (
      <p className="admin-hint admin-block">
        {t.containers}: {m.sources.containers === null ? t.containersNone : t.containersEmpty}
      </p>
    );
  return (
    <div className="admin-table-wrap admin-block">
      <table className="admin-table" data-stack>
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
              <td data-primary>
                <code>{c.name}</code>
              </td>
              <td data-label={t.cpu}>{percent(c.cpu)}</td>
              <td data-label={t.memory}>{gigabytes(c.memBytes)}</td>
              <td data-label={`${t.in} / ${t.out}, ${text.units.mbps}`}>
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
        <Pill tone="bad" title={m.now.error.detail}>
          {m.now.error.code}
        </Pill>
      </p>
    );
  const now = m.now.data!;
  if (now.rooms.length === 0) return <p className="admin-hint admin-block">{t.noNow}</p>;
  const rooms = [...now.rooms].sort((a, b) => streams(b) - streams(a));
  return (
    <div className="admin-table-wrap admin-block">
      <table className="admin-table" data-stack>
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
              <td data-primary>
                <code>{room.code}</code>
                {room.integrations.map((kind) => (
                  <span key={kind} className="admin-hint">
                    {' '}
                    · {t.integrationKinds[kind] ?? kind}
                  </span>
                ))}
              </td>
              <td data-label={text.meetings.humans}>
                {room.connected}/{room.humans}
              </td>
              <td data-label={text.meetings.screens}>{room.screens}</td>
              <td data-label={t.streams}>{streams(room)}</td>
              <td data-label={text.nav.nodes}>{room.mediaNode ?? '—'}</td>
              <td data-label={text.meetings.since}>
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
