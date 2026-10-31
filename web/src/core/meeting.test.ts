import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Meeting } from './meeting';
import type { Admission, Snapshot } from '../api/types';
vi.mock('../media/session', async () => {
  const { Store } = await import('./store');
  const { readPreferences } = await import('./preferences');
  return {
    MediaSession: class {
      state = new Store({ status: 'idle' });
      preferences = new Store(readPreferences());
      screenGone = new Store<{ identity: string; seq: number } | null>(null);
      acceptPreview = vi.fn();
      constructor(
        _api: unknown,
        public onEnd: (reason: string) => void,
      ) {}
      start = vi.fn(async () => {
        this.state.set({ status: 'connected' });
      });
      holdMicrophone = vi.fn(async () => {});
      setServiceParticipants = vi.fn();
      setViewerDecodes = vi.fn();
      rememberPeople = vi.fn();
      watchScreen = vi.fn();
      callReport = vi.fn(() => callReport.value);
      dispose = vi.fn();
    },
  };
});
const { callReport } = vi.hoisted(() => ({ callReport: { value: null as unknown } }));
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
    poker: null,
    durak: null,
    pokerGamesAt: 0,
    durakGamesAt: 0,
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

it('итог звонка уходит владельцу один раз, уходя и с keepalive, а короткий заход итога не даёт', async () => {
  const sent = () =>
    fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/rooms/room/client-report'));
  callReport.value = null;
  window.dispatchEvent(new Event('pagehide'));
  expect(sent()).toHaveLength(0);
  callReport.value = { seconds: 600, rttMs: 40, path: 'direct-udp' };
  await meeting.leave();
  window.dispatchEvent(new Event('pagehide'));
  meeting.dispose();
  expect(sent()).toHaveLength(1);
  const [, init] = sent()[0]! as [string, RequestInit];
  expect(init.keepalive).toBe(true);
  expect(init.method).toBe('POST');
  expect(JSON.parse(String(init.body))).toEqual({ seconds: 600, rttMs: 40, path: 'direct-udp' });
  expect((init.headers as Record<string, string>).Authorization).toBe('Bearer guest.secret');
  callReport.value = null;
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

it('кинозал по ссылке: страница меняется раньше площадки, а без страницы и при закрытии её нет', () => {
  const order: string[] = [];
  meeting.cinemaAt.subscribe(() => order.push(`at:${JSON.stringify(meeting.cinemaAt.get())}`));
  meeting.cinema.subscribe(() => order.push(`cinema:${meeting.cinema.get()}`));
  const page = { page: 'item', kind: 'video', id: 'dQw4w9WgXcQ' } as const;
  meeting.openCinema('youtube', page);
  // Сцена, которую откроет смена площадки, видит свою страницу с первого же кадра.
  expect(order).toEqual([`at:${JSON.stringify(page)}`, 'cinema:youtube']);
  expect(meeting.cinemaAt.get()).toBe(page);
  // Та же страница ещё раз — новый объект: вставить ту же ссылку снова — тоже просьба её открыть.
  meeting.openCinema('youtube', { ...page });
  expect(meeting.cinemaAt.get()).not.toBe(page);
  meeting.openCinema('twitch');
  expect(meeting.cinemaAt.get()).toBeNull();
  meeting.openCinema('rutube', { page: 'series', kind: 'series', id: '356362' });
  meeting.openCinema(null, page);
  expect([meeting.cinema.get(), meeting.cinemaAt.get()]).toEqual([null, null]);
});

/**
 * Часы сервера на пять секунд впереди своих. Ответ идёт `up` мс туда и `down` мс обратно;
 * `serverTime` сервер ставит в момент, когда запрос до него дошёл, — как настоящий.
 */
const SKEW = 5000;
async function answer(up: number, down: number, skew = SKEW) {
  fetchMock.mockImplementationOnce(() => {
    const serverTime = Date.now() + up + skew;
    return new Promise((resolve) =>
      setTimeout(
        () => resolve(new Response(JSON.stringify({ ...snapshot, serverTime }), { status: 200 })),
        up + down,
      ),
    );
  });
  const pending = meeting.refresh();
  await vi.advanceTimersByTimeAsync(up + down);
  await pending;
  return meeting.serverNow() - Date.now();
}

it('часы — по самому быстрому из недавних ответов: один застрявший ответ комнату не сдвигает', async () => {
  expect(await answer(20, 20)).toBe(SKEW);
  // Снимок спрашивают в момент нажатия, когда плеер тянет кусочки видео: ответ простоял в очереди
  // полторы секунды, и вся задержка — на обратном пути. Половина времени ответа ошиблась бы здесь
  // на 780 мс, и этот зритель встал бы от остальных на три четверти секунды.
  expect(await answer(20, 1580)).toBe(SKEW);
  // Ответ не хуже прежнего лучшего — берётся он: он свежее.
  expect(await answer(15, 25)).toBe(SKEW - 5);
});

it('часы устройства прыгнули (сон, синхронизация времени) — прежние замеры забыты, верен следующий', async () => {
  expect(await answer(20, 20)).toBe(SKEW);
  // Время устройства перевели на три секунды вперёд: Date прыгнул, монотонные часы — нет.
  vi.setSystemTime(Date.now() + 3000);
  expect(await answer(150, 150, SKEW - 3000)).toBe(SKEW - 3000);
  // Быстрый замер старше десяти минут уже не лучший: часы за это время могли уйти.
  expect(await answer(20, 20, SKEW - 3000)).toBe(SKEW - 3000);
  await vi.advanceTimersByTimeAsync(11 * 60_000);
  expect(await answer(100, 100, SKEW - 3100)).toBe(SKEW - 3100);
});

it('закрепление камеры (R83): своей и чужой, «Открепить» снимает, ушедший — открепляется сам', async () => {
  snapshot = {
    ...snapshot,
    sequence: 2,
    participants: [person('guest', 'CONNECTED'), person('ann', 'CONNECTED')],
  };
  meeting.start();
  await vi.advanceTimersByTimeAsync(0);
  meeting.pinCamera('ann');
  expect(meeting.pinnedCamera.get()).toBe('ann');
  meeting.unpinCamera();
  expect(meeting.pinnedCamera.get()).toBeNull();
  // Свою камеру тоже закрепляют — крупно у себя, как в Discord.
  meeting.pinCamera('guest');
  expect(meeting.pinnedCamera.get()).toBe('guest');
  meeting.pinCamera('ann');
  expect(meeting.pinnedCamera.get()).toBe('ann');
  snapshot = { ...snapshot, sequence: 3, participants: [person('guest', 'CONNECTED')] };
  await meeting.refresh();
  expect(meeting.pinnedCamera.get()).toBeNull();
});

const written = (participantId: string, eventId: string, text = 'привет') => ({
  version: 1,
  type: 'message.created',
  eventId,
  sequence: 11,
  occurredAt: 0,
  payload: { message: { id: eventId, participantId, name: 'Аня', text } },
});

it('непрочитанные в чате (R87): чужие при закрытом чате или без фокуса, своё — нет, открыл с фокусом — ноль', async () => {
  meeting.start();
  const control = meeting.control as unknown as { onEvent: (event: unknown, live: boolean) => void };
  meeting.windowState.set({ focused: true, visible: true });
  control.onEvent(written('other', 'a'), true);
  control.onEvent(written('other', 'b'), true);
  control.onEvent(written('guest', 'mine'), true);
  // История при входе — не новость.
  control.onEvent(written('other', 'old'), false);
  expect(meeting.unread.get()).toBe(2);
  meeting.chatOpen.set(true);
  expect(meeting.unread.get()).toBe(0);
  control.onEvent(written('other', 'c'), true);
  expect(meeting.unread.get()).toBe(0);
  // Чат открыт, но окно свёрнуто или в трее — сообщение не прочитано.
  meeting.windowState.set({ focused: false, visible: true });
  control.onEvent(written('other', 'd'), true);
  expect(meeting.unread.get()).toBe(1);
  meeting.windowState.set({ focused: true, visible: true });
  expect(meeting.unread.get()).toBe(0);
});

it('уведомления Windows (R59): сообщение без фокуса и без значка на иконке (R138), просьба войти с «Впустить»', async () => {
  const send = vi.fn();
  vi.stubGlobal('cordDesktop', {
    protocol: { major: 2, minor: 0 },
    features: ['notify', 'badge', 'attention'],
    app: { version: '1.0.4', arch: 'x64' },
    bootstrap: {},
    send,
    invoke: vi.fn(),
    on: () => () => {},
  });
  snapshot = {
    ...snapshot,
    sequence: 2,
    participants: [person('guest', 'CONNECTED')],
    you: { can: ['participant.approve', 'participant.remove'] },
  } as Snapshot;
  meeting.start();
  await meeting.refresh();
  meeting.windowState.set({ focused: false, visible: true });
  const control = meeting.control as unknown as { onEvent: (event: unknown, live: boolean) => void };
  control.onEvent(written('other', 'a', 'Глянь экран'), true);
  expect(send).toHaveBeenCalledWith('notify', {
    title: 'Аня',
    body: 'Глянь экран',
    tag: 'room:room:message',
    silent: true,
  });
  snapshot = {
    ...snapshot,
    sequence: 3,
    participants: [person('guest', 'CONNECTED'), person('knocker', 'WAITING')],
  };
  // Сообщение само спросило снимок; следующий запрос встаёт за ним.
  await meeting.refresh();
  await vi.advanceTimersByTimeAsync(0);
  expect(send).toHaveBeenCalledWith(
    'notify',
    expect.objectContaining({ title: 'knocker просится во встречу', tag: 'room:room:knock' }),
  );
  expect(send).toHaveBeenCalledWith('attention', {});
  const command = vi
    .spyOn(meeting, 'command')
    .mockResolvedValue({} as Awaited<ReturnType<Meeting['command']>>);
  expect(meeting.handleNotificationAction('admit', 'room:room:knock')).toBe('people');
  expect(command).toHaveBeenCalledWith('participant.approve', undefined, 'knocker');
  expect(meeting.handleNotificationAction('deny', 'room:room:knock')).toBe('people');
  expect(command).toHaveBeenLastCalledWith('participant.remove', undefined, 'knocker');
  expect(meeting.handleNotificationAction('open', 'room:room:message')).toBe('chat');
  expect(meeting.handleNotificationAction('open', 'room:other-room:message')).toBeNull();
  meeting.windowState.set({ focused: true, visible: true });
  expect(send.mock.calls.map(([type]) => type)).not.toContain('badge');
});

/** Команды ядру идут каналом управления; здесь он подменён — что ушло, видно по вызовам. */
const sent = vi.fn(async (_command: { type: string }) => ({}));
const commandsSent = () => sent.mock.calls.map(([command]) => command.type);

describe('выход из интеграции к участникам (R121)', () => {
  const sharing = { ...person('ann', 'CONNECTED'), screen: true, screenId: 's1', screenStarted: true };
  async function room(extra: Partial<Snapshot>) {
    snapshot = {
      ...snapshot,
      sequence: 2,
      participants: [person('guest', 'CONNECTED'), sharing],
      ...extra,
    };
    sent.mockClear();
    (meeting.control as unknown as { command: typeof sent }).command = sent;
    meeting.start();
    await meeting.refresh();
  }

  it('уйти можно только от того, что на сцене, — и уход личный: ядру не уходит ничего', async () => {
    await room({});
    meeting.leaveStage();
    expect(meeting.stageAway.get()).toBeNull();
    snapshot = { ...snapshot, sequence: 3, poker: { seats: [] } as unknown as Snapshot['poker'] };
    await meeting.refresh();
    const before = commandsSent().length;
    meeting.leaveStage();
    expect(meeting.stageAway.get()).toBe('poker');
    expect(commandsSent().length).toBe(before);
  });

  it('интеграция кончилась — уход забыт, и следующая открывается у ушедшего, как у всех', async () => {
    await room({ poker: { seats: [] } as unknown as Snapshot['poker'] });
    meeting.leaveStage();
    snapshot = { ...snapshot, sequence: 3, poker: null };
    await meeting.refresh();
    expect(meeting.stageAway.get()).toBeNull();
  });

  it('вернуться — закрыть чужой экран, но не снимать закрепление', async () => {
    await room({ watch: { provider: 'youtube' } as unknown as Snapshot['watch'] });
    meeting.pinCamera('ann');
    expect(meeting.stageAway.get()).toBe('cinema');
    meeting.openStream('ann');
    expect(meeting.viewing.get()).not.toBeNull();
    meeting.returnToStage();
    await vi.advanceTimersByTimeAsync(0);
    expect(meeting.stageAway.get()).toBeNull();
    expect(meeting.viewing.get()).toBeNull();
    expect(commandsSent()).toContain('view.close');
    meeting.pinCamera('ann');
    meeting.returnToStage();
    expect(meeting.pinnedCamera.get()).toBe('ann');
  });

  it('смотреть чужой экран поверх кинозала — это вид участников; каталог из панели возвращает в кинозал', async () => {
    await room({ watch: { provider: 'youtube' } as unknown as Snapshot['watch'] });
    meeting.openStream('ann');
    expect(meeting.stageAway.get()).toBe('cinema');
    meeting.openCinema('youtube');
    expect(meeting.stageAway.get()).toBeNull();
    expect(meeting.viewing.get()).toBeNull();
  });

  it('ушёл из своего каталога, а комната включила фильм — фильм открывается и у него', async () => {
    await room({});
    meeting.openCinema('youtube');
    meeting.leaveStage();
    expect(meeting.stageAway.get()).toBe('cinema');
    snapshot = { ...snapshot, sequence: 3, watch: { provider: 'youtube' } as unknown as Snapshot['watch'] };
    await meeting.refresh();
    expect(meeting.stageAway.get()).toBeNull();
  });
});
