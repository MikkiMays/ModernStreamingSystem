import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Meeting } from './meeting';
import type { Admission, Snapshot } from '../api/types';
vi.mock('../media/session', async () => {
  const { Store } = await import('./store');
  const { readPreferences } = await import('./preferences');
  return {
    MediaSession: class {
      state = new Store({ status: 'idle' });
      preferences = new Store(readPreferences());
      constructor(
        _api: unknown,
        public onEnd: (reason: string) => void,
      ) {}
      start = vi.fn(async () => {
        this.state.set({ status: 'connected' });
      });
      setServiceParticipants = vi.fn();
      rememberPeople = vi.fn();
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
        public onEvent: (event: unknown, live: boolean) => void,
        public onRevoked: () => void,
      ) {}
      start() {}
      dispose() {}
    },
  };
});
const { cues } = vi.hoisted(() => ({ cues: [] as string[] }));
vi.mock('./sounds', () => ({
  NotificationSounds: class {
    start() {}
    play(cue: string) {
      cues.push(cue);
    }
    settled() {
      return Promise.resolve();
    }
    dispose() {}
  },
  unlockNotificationAudio() {},
  ensureNotificationAudio() {},
}));
vi.mock('./uploader', () => ({
  Uploader: class {
    async congestion() {}
    async pause() {}
  },
}));
type Person = Snapshot['participants'][number];
const person = (id: string, status: Person['status']): Person => ({
  id,
  name: id,
  avatar: '',
  status,
  owner: false,
  generation: 0,
  recoveryDeadline: null,
  screen: false,
  service: null,
});
let meeting: Meeting;
let snapshot: Snapshot;
const fetchMock = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', fetchMock);
  sessionStorage.clear();
  cues.length = 0;
  snapshot = {
    id: 'room',
    title: 'Admission',
    code: '123456789',
    sequence: 1,
    createdAt: 0,
    closedAt: null,
    approvalRequired: true,
    integrationsAllowed: true,
    participants: [person('guest', 'WAITING')],
    messages: [],
    serverTime: 0,
    watch: null,
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

it('sounds your own entrance, then a knock, an arrival and a departure, then your exit', async () => {
  meeting.start();
  expect(cues).toEqual(['self-join']);

  snapshot = { ...snapshot, sequence: 2, participants: [person('guest', 'JOINING')] };
  await vi.advanceTimersByTimeAsync(2000);
  expect(cues, 'your own arrival is announced once, not again by the roster').toEqual(['self-join']);

  snapshot = {
    ...snapshot,
    sequence: 3,
    participants: [person('guest', 'JOINING'), person('other', 'WAITING')],
  };
  await vi.advanceTimersByTimeAsync(2000);
  expect(cues.at(-1)).toBe('knock');

  snapshot = {
    ...snapshot,
    sequence: 4,
    participants: [person('guest', 'JOINING'), person('other', 'CONNECTED')],
  };
  await vi.advanceTimersByTimeAsync(2000);
  expect(cues.at(-1)).toBe('join');

  snapshot = {
    ...snapshot,
    sequence: 5,
    participants: [person('guest', 'JOINING'), person('other', 'LEFT')],
  };
  await vi.advanceTimersByTimeAsync(2000);
  expect(cues.at(-1)).toBe('leave');

  await meeting.leave();
  expect(cues).toEqual(['self-join', 'knock', 'join', 'leave', 'self-leave']);
});

it('stays quiet when this device asked for no notification sounds', async () => {
  meeting.media.preferences.set({ ...meeting.media.preferences.get(), notificationSounds: false });
  meeting.start();
  snapshot = {
    ...snapshot,
    sequence: 2,
    participants: [person('guest', 'JOINING'), person('other', 'JOINING')],
  };
  await vi.advanceTimersByTimeAsync(2000);
  await meeting.leave();
  expect(cues).toEqual([]);
});

/**
 * A screen start is news for the room; the first person arriving to watch is news for the one
 * sharing. Telling everybody about a stranger joining a stream they are not running would be
 * noise about somebody else's business.
 */
it('tells only the person sharing that somebody came to watch', async () => {
  meeting.start();
  const control = meeting.control as unknown as { onEvent: (event: unknown, live: boolean) => void };
  const viewer = (participantId: string, eventId: string) => ({
    version: 1,
    type: 'screen.first_viewer',
    eventId,
    sequence: 9,
    occurredAt: 0,
    payload: { message: null, screenId: 's', participantId },
  });
  control.onEvent(viewer('other', 'theirs'), true);
  await vi.advanceTimersByTimeAsync(0);
  expect(cues).not.toContain('viewer');
  control.onEvent(viewer('guest', 'mine'), true);
  await vi.advanceTimersByTimeAsync(0);
  expect(cues).toContain('viewer');
  // A screen starting is for everybody in the room, whoever started it.
  control.onEvent({ ...viewer('other', 'start'), type: 'screen.started' }, true);
  await vi.advanceTimersByTimeAsync(0);
  expect(cues).toContain('screen');
});

it('звучит на чужое сообщение в чате и молчит на своё', async () => {
  meeting.start();
  const control = meeting.control as unknown as { onEvent: (event: unknown, live: boolean) => void };
  const written = (participantId: string, eventId: string) => ({
    version: 1,
    type: 'message.created',
    eventId,
    sequence: 11,
    occurredAt: 0,
    payload: { message: { id: 'm', participantId, name: 'Кто-то', text: 'привет' } },
  });
  control.onEvent(written('guest', 'mine'), true);
  await vi.advanceTimersByTimeAsync(0);
  expect(cues).not.toContain('message');
  control.onEvent(written('other', 'theirs'), true);
  await vi.advanceTimersByTimeAsync(0);
  expect(cues).toContain('message');
});

it('resolves a room deletion when the SFU disconnect arrives before its control event', async () => {
  meeting.start();
  snapshot = { ...snapshot, sequence: 3, closedAt: Date.now(), participants: [] };
  (meeting.media as unknown as { onEnd: (reason: string) => void }).onEnd('Доступ к встрече завершён');
  await vi.advanceTimersByTimeAsync(0);
  expect(meeting.ended.get()).toBe('Встреча завершена');
  expect(meeting.snapshot.get().closedAt).toBeTruthy();
});
