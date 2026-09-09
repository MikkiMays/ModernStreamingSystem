import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Meeting } from './meeting';
import type { Admission, Snapshot } from '../api/types';
vi.mock('../media/session', async () => {
  const { Store } = await import('./store');
  return {
    MediaSession: class {
      state = new Store({ status: 'idle' });
      constructor(
        _api: unknown,
        public onEnd: (reason: string) => void,
      ) {}
      start = vi.fn(async () => {
        this.state.set({ status: 'connected' });
      });
      dispose = vi.fn();
    },
  };
});
vi.mock('./control', async () => {
  const { Store } = await import('./store');
  return {
    ControlChannel: class {
      state = new Store('connecting');
      constructor(
        _api: unknown,
        public onSnapshot: (snapshot: Snapshot) => void,
        _event: unknown,
        public onRevoked: () => void,
      ) {}
      start() {}
      dispose() {}
    },
  };
});
vi.mock('./uploader', () => ({
  Uploader: class {
    async congestion() {}
    async pause() {}
  },
}));
let meeting: Meeting;
let snapshot: Snapshot;
const fetchMock = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', fetchMock);
  sessionStorage.clear();
  snapshot = {
    id: 'room',
    title: 'Admission',
    code: '123456789',
    sequence: 1,
    createdAt: 0,
    closedAt: null,
    approvalRequired: true,
    integrationsAllowed: true,
    participants: [
      {
        id: 'guest',
        name: 'Guest',
        status: 'WAITING',
        owner: false,
        generation: 0,
        recoveryDeadline: null,
        screen: false,
        service: null,
      },
    ],
    messages: [],
    serverTime: 0,
  };
  const admission = {
    roomId: 'room',
    participantId: 'guest',
    credential: 'guest.secret',
    snapshot,
  } as Admission;
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(snapshot), { status: 200 }));
  meeting = new Meeting(admission);
});
afterEach(() => {
  meeting.dispose();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  fetchMock.mockReset();
});
it('admits a waiting guest through REST when the control socket never authenticates', async () => {
  meeting.start();
  await vi.advanceTimersByTimeAsync(10000);
  expect(meeting.media.start).not.toHaveBeenCalled();
  snapshot = {
    ...snapshot,
    sequence: 2,
    participants: snapshot.participants.map((p) => ({ ...p, status: 'JOINING' })),
  };
  await vi.advanceTimersByTimeAsync(2000);
  expect(meeting.media.start).toHaveBeenCalledTimes(1);
  expect(meeting.snapshot.get().participants[0]?.status).toBe('JOINING');
  await vi.advanceTimersByTimeAsync(6000);
  expect(meeting.media.start).toHaveBeenCalledTimes(1);
});
it('leaves the waiting screen when approval expires and stops background polling on disposal', async () => {
  meeting.start();
  snapshot = { ...snapshot, sequence: 2, participants: [] };
  await vi.advanceTimersByTimeAsync(2000);
  expect(meeting.ended.get()).toBeTruthy();
  expect(meeting.media.start).not.toHaveBeenCalled();
  const count = fetchMock.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10000);
  expect(fetchMock).toHaveBeenCalledTimes(count);
});
it('refreshes admission immediately on return to the tab and ignores a late result after disposal', async () => {
  meeting.start();
  let resolve!: (value: Response) => void;
  fetchMock.mockImplementation(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  window.dispatchEvent(new Event('online'));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  meeting.dispose();
  resolve(
    new Response(
      JSON.stringify({
        ...snapshot,
        sequence: 3,
        participants: snapshot.participants.map((p) => ({ ...p, status: 'JOINING' })),
      }),
    ),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(meeting.media.start).not.toHaveBeenCalled();
});

it('keeps the authoritative room-closed reason when revocation races with the final snapshot', async () => {
  meeting.start();
  snapshot = { ...snapshot, sequence: 2, closedAt: Date.now(), participants: [] };
  const control = meeting.control as unknown as {
    onRevoked: () => void;
    onSnapshot: (snapshot: Snapshot) => void;
  };
  control.onRevoked();
  await vi.advanceTimersByTimeAsync(0);
  expect(meeting.ended.get()).toBe('Встреча завершена');
  control.onSnapshot(snapshot);
  control.onRevoked();
  expect(meeting.ended.get()).toBe('Встреча завершена');
});

it('resolves a room deletion when the SFU disconnect arrives before its control event', async () => {
  meeting.start();
  snapshot = { ...snapshot, sequence: 3, closedAt: Date.now(), participants: [] };
  (meeting.media as unknown as { onEnd: (reason: string) => void }).onEnd('Доступ к встрече завершён');
  await vi.advanceTimersByTimeAsync(0);
  expect(meeting.ended.get()).toBe('Встреча завершена');
  expect(meeting.snapshot.get().closedAt).toBeTruthy();
});
