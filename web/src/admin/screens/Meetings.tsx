import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Field, Input, Switch, Tab, TabList, TabPanel, Tabs } from '../../ui/kit';
import { text } from '../../i18n/admin/ru';
import { fleet, type LiveRoom, type Now, type Summary } from '../api';
import type { Console } from '../AdminApp';
import { Confirm, Empty, ErrorLine, Panel, Skeleton, Tile, duration } from '../parts';

/** Встречи ядра выбранной машины (§8.4): сейчас (с завершением) и сводка за период. */
export function Meetings({ console }: { console: Console }) {
  const machine = console.machine;
  if (!machine) return <Empty>{text.overview.noCore}</Empty>;
  return (
    <Tabs defaultValue="now" variant="line" className="admin-tabs">
      <TabList>
        <Tab value="now">{text.meetings.now}</Tab>
        <Tab value="period">{text.meetings.period}</Tab>
      </TabList>
      <TabPanel value="now">
        <LiveMeetings id={machine.id} />
      </TabPanel>
      <TabPanel value="period">
        <Period id={machine.id} />
      </TabPanel>
    </Tabs>
  );
}

function LiveMeetings({ id }: { id: string }) {
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
  return (
    <Panel title={text.meetings.now}>
      <ErrorLine error={now.error} onRetry={() => void now.refetch()} />
      {now.isPending && <Skeleton />}
      {data && (
        <div className="admin-tiles">
          <Tile value={data.live} label={text.overview.meetings} />
          <Tile value={data.humans} label={text.overview.humans} />
          <Tile value={data.bots} label={text.overview.bots} />
          <Tile value={data.screens} label={text.overview.screens} />
        </div>
      )}
      {data && data.rooms.length === 0 && <Empty>{text.meetings.empty}</Empty>}
      {data && data.rooms.length > 0 && (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>{text.meetings.code}</th>
                <th>{text.meetings.humans}</th>
                <th>{text.meetings.screens}</th>
                <th>{text.meetings.bots}</th>
                <th>{text.meetings.node}</th>
                <th>{text.meetings.since}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.rooms.map((room) => (
                <tr key={room.id}>
                  <td>
                    <code>{room.code}</code>
                  </td>
                  <td>{room.humans}</td>
                  <td>{room.screens}</td>
                  <td>{room.bots}</td>
                  <td>{room.mediaNode ?? '—'}</td>
                  <td>
                    {room.startedAt ? duration(Math.max(0, (data.serverTime - room.startedAt) / 1000)) : '—'}
                  </td>
                  <td>
                    <Button variant="danger" size="sm" onClick={() => setClosing(room)}>
                      {text.meetings.close}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
    </Panel>
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
        <div className="admin-tiles">
          <Tile value={data.meetings} label={text.meetings.meetingsCount} />
          <Tile value={(data.humanSeconds / 3600).toFixed(1)} label={text.meetings.humanHours} />
          <Tile value={Math.round(data.medianSeconds / 60)} label={text.meetings.median} />
          <Tile value={Math.round(data.longestSeconds / 60)} label={text.meetings.longest} />
          <Tile value={data.peakHumans} label={text.meetings.peak} />
          <Tile value={data.uniqueDevices} label={text.meetings.devices} />
          <Tile value={data.joins} label={text.meetings.joins} />
          <Tile
            value={data.joinFailures}
            label={text.meetings.joinFailures}
            tone={data.joinFailures ? 'warn' : undefined}
          />
        </div>
      )}
    </Panel>
  );
}
