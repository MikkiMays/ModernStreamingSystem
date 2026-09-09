import { afterEach, expect, it, vi } from 'vitest';
import type { RoomApi } from '../api/client';
import { ControlChannel } from './control';
class Socket {
  static OPEN = 1;
  static CONNECTING = 0;
  static all: Socket[] = [];
  readyState = 1;
  send = vi.fn();
  close = vi.fn();
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (event: { data: string }) => void;
  constructor() {
    Socket.all.push(this);
  }
  receive(packet: object) {
    this.onmessage?.({ data: JSON.stringify(packet) });
  }
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Socket.all = [];
});
it('correlates PING and suppresses notifications from replay after reconnect', () => {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', Socket);
  const events = vi.fn();
  const channel = new ControlChannel(
    { admission: { roomId: 'room' }, credential: 'credential' } as RoomApi,
    vi.fn(),
    events,
    vi.fn(),
  );
  channel.start();
  const first = Socket.all[0]!;
  first.onopen?.();
  first.receive({ type: 'authenticated', liveAfter: 5 });
  first.receive({ type: 'snapshot', snapshot: { sequence: 5 } });
  const request = JSON.parse(first.send.mock.calls.at(-1)![0] as string) as { requestId: string };
  expect(request.requestId).toBeTruthy();
  first.receive({ type: 'pong', requestId: request.requestId });
  expect(channel.ping.get()).not.toBeNull();
  first.receive({ type: 'event', event: { version: 1, sequence: 6, type: 'screen.started' } });
  expect(events).toHaveBeenLastCalledWith(expect.any(Object), true);
  first.onclose?.();
  expect(channel.ping.get()).toBeNull();
  vi.advanceTimersByTime(1);
  const next = Socket.all[1]!;
  next.onopen?.();
  next.receive({ type: 'authenticated', liveAfter: 8 });
  events.mockClear();
  for (const sequence of [7, 8, 8, 9])
    next.receive({ type: 'event', event: { version: 1, sequence, type: 'screen.first_viewer' } });
  expect(events.mock.calls.map(([, live]) => live)).toEqual([false, false, true]);
  channel.dispose();
});
