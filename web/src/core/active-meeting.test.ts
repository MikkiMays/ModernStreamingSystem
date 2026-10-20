import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Admission } from '../api/types';
import {
  ANSWER_MS,
  announceMeeting,
  findActiveMeeting,
  requestHandover,
  setChannelFactory,
  thisTab,
  watchActiveMeetings,
  type ActiveMeeting,
  type Channel,
} from './active-meeting';

/** Шина «вкладок» в одном процессе: как `BroadcastChannel`, без доставки самому себе. */
function bus() {
  const channels = new Set<FakeChannel>();
  class FakeChannel implements Channel {
    private listeners = new Set<(event: MessageEvent) => void>();
    constructor() {
      channels.add(this);
    }
    postMessage(data: unknown) {
      const copy = structuredClone(data);
      for (const channel of channels)
        if (channel !== this)
          for (const listener of channel.listeners) listener({ data: copy } as MessageEvent);
    }
    addEventListener(_: 'message', listener: (event: MessageEvent) => void) {
      this.listeners.add(listener);
    }
    removeEventListener(_: 'message', listener: (event: MessageEvent) => void) {
      this.listeners.delete(listener);
    }
    close() {
      channels.delete(this);
    }
  }
  return () => new FakeChannel();
}

const admission = { roomId: 'room-1', participantId: 'p-1', credential: 'secret' } as Admission;
const info = { roomId: 'room-1', title: 'Планёрка', code: '333444555' };

beforeEach(() => {
  vi.useFakeTimers();
  setChannelFactory(bus());
});
afterEach(() => {
  vi.useRealTimers();
});

it('shows a meeting running in another tab and forgets it when that tab leaves', () => {
  const seen: ActiveMeeting[][] = [];
  const watcher = watchActiveMeetings((list) => seen.push(list));
  const other = announceMeeting(info, { admission: () => admission, onHandedOver: () => {} }, 'tab-b');
  expect(seen.at(-1)).toEqual([{ ...info, tab: 'tab-b' }]);
  other.update({ ...info, title: 'Ретро' });
  expect(seen.at(-1)?.[0]?.title).toBe('Ретро');
  other.stop();
  expect(seen.at(-1)).toEqual([]);
  watcher.close();
});

it('finds meetings that were already running when the page opened', () => {
  announceMeeting(info, { admission: () => admission, onHandedOver: () => {} }, 'tab-b');
  const seen: ActiveMeeting[][] = [];
  watchActiveMeetings((list) => seen.push(list));
  expect(seen.at(-1)?.map((m) => m.tab)).toEqual(['tab-b']);
});

it('drops a tab that stopped answering instead of keeping it forever', () => {
  const factory = bus();
  setChannelFactory(factory);
  const seen: ActiveMeeting[][] = [];
  const watcher = watchActiveMeetings((list) => seen.push(list));
  // Вкладка, которая объявилась и «упала»: не попрощалась и на вопрос больше не отвечает.
  factory().postMessage({ type: 'here', meeting: { ...info, tab: 'ghost' } });
  expect(seen.at(-1)?.map((m) => m.tab)).toEqual(['ghost']);
  watcher.refresh();
  vi.advanceTimersByTime(ANSWER_MS + 1);
  expect(seen.at(-1)).toEqual([]);
});

it('does not list the meeting of this very tab as running elsewhere', () => {
  const seen: ActiveMeeting[][] = [];
  watchActiveMeetings((list) => seen.push(list));
  announceMeeting(info, { admission: () => admission, onHandedOver: () => {} });
  expect(seen.at(-1) ?? []).toEqual([]);
});

it('moves the meeting here: the other tab hands over its admission and closes its call', async () => {
  const handedOver = vi.fn();
  announceMeeting(info, { admission: () => admission, onHandedOver: handedOver }, 'tab-b');
  const moved = requestHandover({ ...info, tab: 'tab-b' });
  await expect(moved).resolves.toEqual(admission);
  expect(handedOver).toHaveBeenCalledOnce();
});

it('gives up with an explanation when the meeting tab does not answer', async () => {
  const moved = requestHandover({ ...info, tab: 'gone-tab' }, 100);
  vi.advanceTimersByTime(101);
  await expect(moved).rejects.toThrow(/не ответила/);
});

it('finds the tab that holds a given meeting, or answers null after the usual wait (WP1)', async () => {
  const meeting = announceMeeting(info, { admission: () => admission, onHandedOver: () => {} }, 'tab-b');
  await expect(findActiveMeeting('room-1')).resolves.toEqual({ ...info, tab: 'tab-b' });
  const missing = findActiveMeeting('room-2');
  vi.advanceTimersByTime(ANSWER_MS);
  await expect(missing).resolves.toBeNull();
  meeting.stop();
});

it('ignores handover requests meant for another tab or room', () => {
  const handedOver = vi.fn();
  announceMeeting(info, { admission: () => admission, onHandedOver: handedOver }, 'tab-b');
  void requestHandover({ ...info, roomId: 'room-2', tab: 'tab-b' }, 50).catch(() => {});
  void requestHandover({ ...info, tab: 'tab-c' }, 50).catch(() => {});
  vi.advanceTimersByTime(51);
  expect(handedOver).not.toHaveBeenCalled();
  expect(thisTab).not.toBe('tab-b');
});

it('survives the back-forward cache: says goodbye on pagehide and comes back on pageshow (E12)', () => {
  const seen: ActiveMeeting[][] = [];
  const watcher = watchActiveMeetings((list) => seen.push(list));
  const other = announceMeeting(info, { admission: () => admission, onHandedOver: () => {} }, 'tab-b');
  const transition = (type: 'pagehide' | 'pageshow', persisted: boolean) =>
    window.dispatchEvent(Object.assign(new Event(type), { persisted }));
  transition('pagehide', true);
  expect(seen.at(-1)).toEqual([]);
  other.update({ ...info, title: 'Ретро' });
  transition('pageshow', true);
  expect(seen.at(-1)).toEqual([{ ...info, title: 'Ретро', tab: 'tab-b' }]);
  // Настоящая выгрузка — конец: обратно вкладка уже не объявится.
  transition('pagehide', false);
  expect(seen.at(-1)).toEqual([]);
  transition('pageshow', true);
  expect(seen.at(-1)).toEqual([]);
  other.stop();
  watcher.close();
});
