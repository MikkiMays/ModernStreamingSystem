import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { UserRound, Users } from 'lucide-react';
import { Button, Field, Input, Switch, Tab, TabList, TabPanel, Tabs } from '../../ui/kit';
import { text } from '../../i18n/admin/ru';
import {
  fleet,
  type LiveRoom,
  type MeetingParticipant,
  type Now,
  type ParticipantsPage,
  type Summary,
} from '../api';
import type { Console } from '../AdminApp';
import { Confirm, Empty, ErrorLine, Panel, Pill, Skeleton, Stat, Stats, duration, when } from '../parts';
import { streams } from './Live';

/**
 * Встречи ядра выбранной машины (§8.4): сейчас (с завершением), сводка за период и журнал участников (Р-134) —
 * кто входил, откуда и когда. Из идущей встречи — сразу к её участникам.
 */
export function Meetings({ console }: { console: Console }) {
  const machine = console.machine;
  const [tab, setTab] = useState('now');
  const [code, setCode] = useState('');
  if (!machine) return <Empty>{text.overview.noCore}</Empty>;
  return (
    <Tabs value={tab} onValueChange={(value) => setTab(String(value))} variant="line" className="admin-tabs">
      <TabList>
        <Tab value="now">{text.meetings.now}</Tab>
        <Tab value="period">{text.meetings.period}</Tab>
        <Tab value="participants">{text.meetings.participants}</Tab>
      </TabList>
      <TabPanel value="now">
        <LiveMeetings
          id={machine.id}
          title={machine.product ?? machine.title}
          onPeople={(room) => {
            setCode(room);
            setTab('participants');
          }}
        />
      </TabPanel>
      <TabPanel value="period">
        <Period id={machine.id} />
      </TabPanel>
      <TabPanel value="participants">
        <Participants id={machine.id} code={code} onCode={setCode} />
      </TabPanel>
    </Tabs>
  );
}

function LiveMeetings({
  id,
  title,
  onPeople,
}: {
  id: string;
  title: string;
  onPeople: (code: string) => void;
}) {
  const client = useQueryClient();
  const now = useQuery({
    queryKey: ['now', id],
    queryFn: () => fleet.get<Now>(`/core/${id}/now`),
    refetchInterval: 5_000,
  });
  const [closing, setClosing] = useState<LiveRoom | null>(null);
  const [blockCreator, setBlockCreator] = useState(false);
  const [term, setTerm] = useState('');
  const close = useMutation({
    mutationFn: (room: LiveRoom) =>
      fleet.post(`/core/${id}/rooms/${room.id}/close`, { blockCreator, term: term || undefined }),
    onSuccess: () => {
      setClosing(null);
      void client.invalidateQueries({ queryKey: ['now', id] });
    },
  });
  const data = now.data;
  const rooms = data ? [...data.rooms].sort((a, b) => streams(b) - streams(a)) : [];
  return (
    <div className="admin-stack">
      <Panel title={`${text.meetings.now} — ${title}`} description={text.meetings.nowHint}>
        <ErrorLine
          error={now.error}
          onRetry={() => void now.refetch()}
          updatedAt={data ? now.dataUpdatedAt : undefined}
        />
        {now.isPending && <Skeleton rows={2} />}
        {data && (
          <Stats>
            <Stat value={data.live} label={text.live.meetings} />
            <Stat value={data.humans} label={text.live.humans} />
            <Stat value={data.screens} label={text.live.screens} />
            <Stat value={data.bots} label={text.overview.botsLabel} />
          </Stats>
        )}
      </Panel>
      <Panel title={text.meetings.list} flush>
        {now.isPending && <Skeleton />}
        {data && rooms.length === 0 && <Empty icon={<Users />}>{text.meetings.empty}</Empty>}
        {rooms.length > 0 && (
          <div className="admin-table-wrap">
            <table className="admin-table" data-stack>
              <thead>
                <tr>
                  <th>{text.meetings.code}</th>
                  <th data-num>{text.meetings.humans}</th>
                  <th data-num>{text.meetings.screens}</th>
                  <th data-num>{text.meetings.bots}</th>
                  <th>{text.meetings.node}</th>
                  <th>{text.meetings.since}</th>
                  <th>
                    <span className="sr-only">{text.nodes.actions}</span>
                  </th>
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
                          · {text.live.integrationKinds[kind] ?? kind}
                        </span>
                      ))}
                    </td>
                    <td data-num data-label={text.meetings.humans}>
                      {room.humans}
                    </td>
                    <td data-num data-label={text.meetings.screens}>
                      {room.screens}
                    </td>
                    <td data-num data-label={text.meetings.bots}>
                      {room.bots}
                    </td>
                    <td data-label={text.meetings.node}>{room.mediaNode ?? '—'}</td>
                    <td data-label={text.meetings.since}>
                      {room.startedAt
                        ? duration(Math.max(0, (data!.serverTime - room.startedAt) / 1000))
                        : '—'}
                    </td>
                    <td data-actions data-num>
                      <div className="admin-actions">
                        <Button
                          variant="quiet"
                          size="sm"
                          icon={<UserRound size={16} />}
                          aria-label={`${text.meetings.peopleOf} ${room.code}`}
                          onClick={() => onPeople(room.code)}
                        >
                          {text.meetings.participants}
                        </Button>
                        <Button variant="danger" size="sm" onClick={() => setClosing(room)}>
                          {text.meetings.close}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <Confirm
        open={closing !== null}
        onOpenChange={(open) => !open && setClosing(null)}
        title={`${text.meetings.closeTitle} ${closing?.code ?? ''}`}
        warning={`${text.meetings.closeWarning} ${text.meetings.humans}: ${closing?.humans ?? 0}.`}
        confirmLabel={text.meetings.close}
        busy={close.isPending}
        error={close.error}
        onConfirm={() => closing && close.mutate(closing)}
      >
        {closing?.createdHere && (
          <Switch
            checked={blockCreator}
            onCheckedChange={setBlockCreator}
            label={text.meetings.blockCreator}
          />
        )}
        {blockCreator && (
          <Field label={text.meetings.term}>
            <Input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="7 days" />
          </Field>
        )}
      </Confirm>
    </div>
  );
}

function day(offset: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
}

function Period({ id }: { id: string }) {
  const [from, setFrom] = useState(day(-7));
  const [to, setTo] = useState(day(0));
  const range = {
    from: Date.parse(from),
    to: Date.parse(to) + 86_400_000,
    tz: -new Date().getTimezoneOffset(),
  };
  const summary = useQuery({
    queryKey: ['meetings', id, range.from, range.to],
    queryFn: () => fleet.get<Summary>(`/core/${id}/meetings`, range),
    enabled: Number.isFinite(range.from) && Number.isFinite(range.to) && range.to > range.from,
  });
  const data = summary.data;
  return (
    <Panel title={text.meetings.period}>
      <div className="admin-filters">
        <Field label={text.meetings.from} inline>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label={text.meetings.to} inline>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </div>
      <ErrorLine error={summary.error} onRetry={() => void summary.refetch()} />
      {summary.isPending && <Skeleton />}
      {data && (
        <Stats>
          <Stat value={data.meetings} label={text.meetings.meetingsCount} />
          <Stat value={(data.humanSeconds / 3600).toFixed(1)} label={text.meetings.humanHours} />
          <Stat value={Math.round(data.medianSeconds / 60)} label={text.meetings.median} />
          <Stat value={Math.round(data.longestSeconds / 60)} label={text.meetings.longest} />
          <Stat value={data.peakHumans} label={text.meetings.peak} />
          <Stat value={data.uniqueDevices} label={text.meetings.devices} />
          <Stat value={data.joins} label={text.meetings.joins} />
          <Stat
            value={data.joinFailures}
            label={text.meetings.joinFailures}
            tone={data.joinFailures ? 'warn' : undefined}
          />
        </Stats>
      )}
    </Panel>
  );
}

/** Журнал участников (Р-134): встреча по коду, период входа и адрес; страницы — курсором ядра. */
function Participants({ id, code, onCode }: { id: string; code: string; onCode: (code: string) => void }) {
  const [from, setFrom] = useState(day(-7));
  const [to, setTo] = useState(day(0));
  const [ip, setIp] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const meeting = /^\d{9}$/.test(code.trim()) ? code.trim() : undefined;
  // Встреча по коду — за весь срок журнала, иначе — за период.
  const range = meeting ? {} : { from: Date.parse(from), to: Date.parse(to) + 86_400_000 };
  const params = {
    code: meeting,
    ip: ip.trim() || undefined,
    cursor: cursor ?? undefined,
    limit: 100,
    ...range,
  };
  const rows = useQuery({
    queryKey: ['participants', id, params],
    queryFn: () => fleet.get<ParticipantsPage>(`/core/${id}/participants`, params),
  });
  const reset = () => setCursor(null);
  const items = rows.data?.items ?? [];
  return (
    <Panel title={text.meetings.participants} description={text.meetings.participantsHint} flush>
      <div className="admin-filters">
        <Field label={text.meetings.codeFilter} inline>
          <Input
            value={code}
            inputMode="numeric"
            maxLength={9}
            placeholder="123456789"
            onChange={(e) => {
              onCode(e.target.value.replace(/\D/g, ''));
              reset();
            }}
          />
        </Field>
        {!meeting && (
          <>
            <Field label={text.meetings.from} inline>
              <Input
                type="date"
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value);
                  reset();
                }}
              />
            </Field>
            <Field label={text.meetings.to} inline>
              <Input
                type="date"
                value={to}
                onChange={(e) => {
                  setTo(e.target.value);
                  reset();
                }}
              />
            </Field>
          </>
        )}
        <Field label={text.meetings.ipFilter} inline>
          <Input
            value={ip}
            placeholder="203.0.113."
            onChange={(e) => {
              setIp(e.target.value);
              reset();
            }}
          />
        </Field>
      </div>
      <ErrorLine error={rows.error} onRetry={() => void rows.refetch()} />
      {rows.isPending && <Skeleton />}
      {rows.data && items.length === 0 && (
        <Empty icon={<UserRound />}>{text.meetings.participantsEmpty}</Empty>
      )}
      {items.length > 0 && (
        <div className="admin-table-wrap">
          <table className="admin-table" data-stack aria-label={text.meetings.participants}>
            <thead>
              <tr>
                <th>{text.meetings.person}</th>
                <th>{text.meetings.meeting}</th>
                <th>{text.meetings.ip}</th>
                <th>{text.meetings.client}</th>
                <th>{text.meetings.when}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <ParticipantRow key={row.id} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(cursor || rows.data?.next) && (
        <div className="admin-actions">
          {cursor && (
            <Button variant="quiet" size="sm" onClick={reset}>
              {text.meetings.first}
            </Button>
          )}
          {rows.data?.next && (
            <Button variant="quiet" size="sm" onClick={() => setCursor(rows.data!.next)}>
              {text.meetings.more}
            </Button>
          )}
        </div>
      )}
    </Panel>
  );
}

function ParticipantRow({ row }: { row: MeetingParticipant }) {
  const t = text.meetings;
  return (
    <tr>
      <td data-primary>
        {row.name ?? '—'} <span className="admin-hint">· {t.doors[row.door] ?? row.door}</span>
      </td>
      <td data-label={t.meeting} data-wrap>
        <code>{row.roomCode ?? '—'}</code>
        {row.title && <span> · {row.title}</span>}
        {row.mediaNode && (
          <span className="admin-hint">
            {' '}
            · {t.node} {row.mediaNode}
          </span>
        )}
      </td>
      <td data-label={t.ip}>
        {row.ip ? <code>{row.ip}</code> : <span className="admin-hint">{t.noIp}</span>}
      </td>
      <td data-label={t.client}>
        {t.clients[row.client] ?? row.client} · {t.systems[row.os] ?? row.os}
      </td>
      <td data-label={t.when}>
        {when(Math.round(row.joinedAt / 1000), true)}{' '}
        {row.leftAt ? (
          <span className="admin-hint">
            → {when(Math.round(row.leftAt / 1000))} ·{' '}
            {duration(Math.max(0, (row.leftAt - row.joinedAt) / 1000))}
          </span>
        ) : (
          <Pill tone="ok" dot>
            {t.inMeeting}
          </Pill>
        )}
      </td>
    </tr>
  );
}
