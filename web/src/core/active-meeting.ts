import type { Admission } from '../api/types';

/**
 * Какая встреча идёт в соседней вкладке этого браузера (T52, П13).
 *
 * У зрителя активна одна встреча. Решает это ядро — по профилю устройства, при входе (пакет WP1,
 * `409 ALREADY_IN_MEETING`), — а браузеру здесь нужно другое: показать на главной, что встреча
 * уже идёт («вы здесь») и вернуться в неё одним нажатием. Вкладки одного браузера делят профиль,
 * поэтому знают друг о друге через `BroadcastChannel` того же источника — без сервера и без опроса.
 *
 * Разговор такой. Вкладка со встречей объявляет её (`here`) и отвечает на вопрос «кто во встрече»
 * (`who`); уходя — прощается (`gone`). Вкладка, которая хочет вернуться во встречу, просит её
 * передать (`handover`): вкладка со встречей отдаёт свой допуск (`handed`), закрывает у себя
 * разговор **без выхода** из встречи, и встреча продолжается там, где попросили, — тем же
 * участником, как после перезагрузки страницы. Переносить разговор, а не «переключать фокус»,
 * приходится потому, что браузер не даёт одной вкладке вывести вперёд другую.
 *
 * Вкладка, которая упала, не прощается. Поэтому список не копится, а переспрашивается: при
 * каждом `refresh()` прежние записи живут, только если их вкладка ответила снова.
 */
export interface ActiveMeeting {
  tab: string;
  roomId: string;
  title: string;
  code: string;
}

type Message =
  | { type: 'who'; from: string }
  | { type: 'here'; meeting: ActiveMeeting }
  | { type: 'gone'; tab: string }
  | { type: 'handover'; from: string; to: string; roomId: string }
  | { type: 'handed'; to: string; roomId: string; admission: Admission };

export interface Channel {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  close(): void;
}

const NAME = 'cord:active-meeting';
/** Столько ждём ответа соседей, прежде чем забыть молчащих. */
export const ANSWER_MS = 400;
/** Столько ждём, пока вкладка со встречей отдаст её. */
export const HANDOVER_MS = 3000;

let makeChannel: () => Channel | null = () =>
  typeof BroadcastChannel === 'function' ? new BroadcastChannel(NAME) : null;
/** Для тестов: свой канал вместо `BroadcastChannel`. */
export function setChannelFactory(factory: () => Channel | null) {
  makeChannel = factory;
}

/** Эта вкладка. Новое имя на каждую загрузку страницы. */
export const thisTab =
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

const isMessage = (data: unknown): data is Message =>
  !!data && typeof data === 'object' && typeof (data as { type?: unknown }).type === 'string';

/**
 * Объявить встречу этой вкладки. `admission` спрашивается в момент передачи — у живой встречи он
 * свой на каждый переподключённый вход; `onHandedOver` закрывает разговор здесь, не выходя из него.
 */
export function announceMeeting(
  info: Omit<ActiveMeeting, 'tab'>,
  handover: { admission: () => Admission; onHandedOver: () => void },
  /** Имя вкладки — своё только в тестах, где «соседняя вкладка» живёт в том же процессе. */
  tab = thisTab,
) {
  const channel = makeChannel();
  let current: ActiveMeeting = { ...info, tab };
  let stopped = false;
  const say = (message: Message) => channel?.postMessage(message);
  const listener = (event: MessageEvent) => {
    const message = event.data;
    if (stopped || !isMessage(message)) return;
    if (message.type === 'who' && message.from !== tab) say({ type: 'here', meeting: current });
    if (message.type === 'handover' && message.to === tab && message.roomId === current.roomId) {
      say({ type: 'handed', to: message.from, roomId: current.roomId, admission: handover.admission() });
      stop();
      handover.onHandedOver();
    }
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    say({ type: 'gone', tab });
    channel?.removeEventListener('message', listener);
    channel?.close();
    window.removeEventListener('pagehide', stop);
  };
  channel?.addEventListener('message', listener);
  window.addEventListener('pagehide', stop);
  say({ type: 'here', meeting: current });
  return {
    update(next: Omit<ActiveMeeting, 'tab'>) {
      if (stopped) return;
      current = { ...next, tab };
      say({ type: 'here', meeting: current });
    },
    stop,
  };
}

/**
 * Следить за встречами соседних вкладок. Слушатель получает весь список при каждом изменении;
 * `refresh()` переспрашивает и забывает тех, кто не ответил за {@link ANSWER_MS}.
 */
export function watchActiveMeetings(listener: (meetings: ActiveMeeting[]) => void) {
  const channel = makeChannel();
  const known = new Map<string, ActiveMeeting>();
  let confirmed = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const publish = () => listener([...known.values()]);
  const onMessage = (event: MessageEvent) => {
    const message = event.data;
    if (closed || !isMessage(message)) return;
    if (message.type === 'here' && message.meeting.tab !== thisTab) {
      known.set(message.meeting.tab, message.meeting);
      confirmed.add(message.meeting.tab);
      publish();
    }
    if (message.type === 'gone' && known.delete(message.tab)) publish();
  };
  const refresh = () => {
    if (closed || !channel) return;
    confirmed = new Set();
    channel.postMessage({ type: 'who', from: thisTab } satisfies Message);
    clearTimeout(timer);
    timer = setTimeout(() => {
      let changed = false;
      for (const tab of known.keys()) if (!confirmed.has(tab)) changed = known.delete(tab) || changed;
      if (changed) publish();
    }, ANSWER_MS);
  };
  channel?.addEventListener('message', onMessage);
  refresh();
  return {
    refresh,
    close() {
      closed = true;
      clearTimeout(timer);
      channel?.removeEventListener('message', onMessage);
      channel?.close();
    },
  };
}

/**
 * Вкладка этого браузера, где идёт встреча `roomId`, — или `null`, если за {@link ANSWER_MS} никто не
 * ответил. Нужна окну «Вы уже во встрече…» (WP1): ядро назвало встречу, и «Перейти туда» сначала
 * ищет её здесь, в соседней вкладке.
 */
export function findActiveMeeting(roomId: string, waitMs = ANSWER_MS): Promise<ActiveMeeting | null> {
  return new Promise((resolve) => {
    let done = false;
    let watcher: ReturnType<typeof watchActiveMeetings> | undefined;
    const finish = (found: ActiveMeeting | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      watcher?.close();
      resolve(found);
    };
    const timer = setTimeout(() => finish(null), waitMs);
    watcher = watchActiveMeetings((list) => {
      const found = list.find((meeting) => meeting.roomId === roomId);
      if (found) finish(found);
    });
    // Соседи могли ответить ещё до того, как наблюдатель вернулся, — тогда закрыть его здесь.
    if (done) watcher.close();
  });
}

/** Попросить вкладку со встречей отдать её сюда. Ответ — допуск, с которым можно войти. */
export function requestHandover(meeting: ActiveMeeting, waitMs = HANDOVER_MS): Promise<Admission> {
  const channel = makeChannel();
  if (!channel) return Promise.reject(new Error('Браузер не умеет передавать встречу между вкладками'));
  return new Promise<Admission>((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      channel.removeEventListener('message', onMessage);
      channel.close();
    };
    const onMessage = (event: MessageEvent) => {
      const message = event.data;
      if (!isMessage(message) || message.type !== 'handed') return;
      if (message.to !== thisTab || message.roomId !== meeting.roomId) return;
      finish();
      resolve(message.admission);
    };
    const timer = setTimeout(() => {
      finish();
      reject(new Error('Вкладка со встречей не ответила. Перейдите в неё или закройте её'));
    }, waitMs);
    channel.addEventListener('message', onMessage);
    channel.postMessage({
      type: 'handover',
      from: thisTab,
      to: meeting.tab,
      roomId: meeting.roomId,
    } satisfies Message);
  });
}
