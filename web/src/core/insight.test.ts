import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  PROBE_KEY,
  flush,
  insightHooks,
  landingOf,
  noteFeature,
  noteScreen,
  referrerHost,
  resetInsightForTest,
  startInsight,
  track,
} from './insight';
import { profileSecret } from './identity';

/**
 * Аналитика продукта, вторая версия (R239): события уходят пачками на `/api/v1/t`; начало сессии — один
 * раз на сессию вкладки; «человеком» сессию делает настоящее действие, а не загрузка страницы.
 */
const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
  String(url).endsWith('/proof') ? new Response(null, { status: 204 }) : new Response(null, { status: 204 }),
);
const beacon = vi.fn(() => true);

interface Batch {
  v: number;
  sid: string;
  profile: string;
  client: { kind: string; version: string };
  probe?: string;
  events: { n: string; at: number; p: Record<string, unknown> }[];
}
const batches = (): Batch[] =>
  fetchMock.mock.calls
    .filter(([url]) => url === '/api/v1/t')
    .map(([, init]) => JSON.parse(String(init?.body)) as Batch);
const sent = () => batches().flatMap((batch) => batch.events);

beforeEach(() => {
  sessionStorage.clear();
  resetInsightForTest();
  fetchMock.mockClear();
  beacon.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  insightHooks.trusted = (event) => event.isTrusted;
  history.replaceState(null, '', '/');
});

it('начало сессии уходит один раз на сессию вкладки — с профилем, клиентом и тем, откуда вошёл', async () => {
  history.replaceState(null, '', '/join/7d4f?utm_source=tg&utm_campaign=friends');
  startInsight();
  await vi.advanceTimersByTimeAsync(1_000);
  const [first] = batches();
  expect(first).toBeDefined();
  expect(first!.v).toBe(1);
  expect(first!.sid).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(first!.profile).toBe(profileSecret());
  expect(first!.client.kind).toBe('web');
  const start = first!.events[0]!;
  expect(start.n).toBe('session_start');
  expect(start.p.landing).toBe('invite');
  expect(start.p.utm).toEqual({ source: 'tg', campaign: 'friends' });
  const init = fetchMock.mock.calls[0]![1]!;
  expect(init.keepalive).toBe(true);
  expect(init.headers).toMatchObject({ 'X-Cord-Profile': profileSecret(), 'X-Cord-Client': 'web' });
  // Перезагрузка вкладки — та же сессия: второго начала нет, номер сессии прежний.
  resetInsightForTest();
  fetchMock.mockClear();
  startInsight();
  track('screen', { name: 'home' });
  await flush();
  expect(sent().map((event) => event.n)).toEqual(['screen']);
  expect(batches()[0]!.sid).toBe(first!.sid);
});

it('полчаса тишины — новая сессия с новым номером', async () => {
  startInsight();
  await vi.advanceTimersByTimeAsync(1_000);
  const before = batches()[0]!.sid;
  vi.setSystemTime(Date.now() + 31 * 60_000);
  resetInsightForTest();
  fetchMock.mockClear();
  startInsight();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(sent()[0]!.n).toBe('session_start');
  expect(batches()[0]!.sid).not.toBe(before);
});

it('«человек действовал» — только настоящее действие и три секунды видимой страницы', async () => {
  startInsight();
  await vi.advanceTimersByTimeAsync(1_000);
  fetchMock.mockClear();
  // Событие, созданное скриптом (так «нажимают» роботы), человеком сессию не делает.
  window.dispatchEvent(new Event('pointerdown'));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(sent().some((event) => event.n === 'engaged')).toBe(false);
  // Настоящее действие — но страница видна меньше трёх секунд с начала: ждём остаток.
  insightHooks.trusted = () => true;
  resetInsightForTest();
  sessionStorage.clear();
  fetchMock.mockClear();
  startInsight();
  window.dispatchEvent(new Event('keydown'));
  await vi.advanceTimersByTimeAsync(1_000);
  expect(sent().some((event) => event.n === 'engaged')).toBe(false);
  await vi.advanceTimersByTimeAsync(3_000);
  const engaged = sent().filter((event) => event.n === 'engaged');
  expect(engaged).toHaveLength(1);
  expect(fetchMock.mock.calls.some(([url]) => url === '/api/v1/t/proof')).toBe(true);
  // Служба засчитывает `engaged` не раньше чем через три секунды после `session_start` — и шлётся оно один раз.
  const start = sent().find((event) => event.n === 'session_start')!;
  expect(engaged[0]!.at - start.at).toBeGreaterThanOrEqual(3_000);
  // Второе действие в той же сессии ничего не добавляет.
  window.dispatchEvent(new Event('keydown'));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(sent().filter((event) => event.n === 'engaged')).toHaveLength(1);
});

it('метка «своя проверка» из хранилища страницы уходит в каждой пачке; без неё поля нет', async () => {
  track('screen', { name: 'home' });
  await flush();
  expect('probe' in batches()[0]!).toBe(false);
  localStorage.setItem(PROBE_KEY, '20261112.abc');
  fetchMock.mockClear();
  track('screen', { name: 'room' });
  await flush();
  expect(batches()[0]!.probe).toBe('20261112.abc');
  localStorage.removeItem(PROBE_KEY);
});

it('события копятся и уходят пачкой раз в пять секунд; пустые поля не уходят', async () => {
  track('permission', { device: 'mic', result: 'granted', error: undefined });
  track('invite', { how: 'copy' });
  expect(batches()).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(batches()).toHaveLength(1);
  expect(sent()).toMatchObject([
    { n: 'permission', p: { device: 'mic', result: 'granted' } },
    { n: 'invite', p: { how: 'copy' } },
  ]);
  expect('error' in sent()[0]!.p).toBe(false);
});

it('сбой сети — одна повторная попытка, затем события выбрасываются; встрече это не мешает', async () => {
  fetchMock.mockRejectedValueOnce(new TypeError('offline')).mockRejectedValueOnce(new TypeError('offline'));
  track('invite', { how: 'share' });
  await expect(flush()).resolves.toBeUndefined();
  await vi.advanceTimersByTimeAsync(5_000);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  fetchMock.mockClear();
  await flush();
  expect(fetchMock).not.toHaveBeenCalled();
});

it('при уходе со страницы остаток уходит одним sendBeacon', async () => {
  track('leave', { reason: 'closed', seconds: 12 });
  await flush(true);
  expect(beacon).toHaveBeenCalledTimes(1);
  expect(batches()).toHaveLength(0);
});

it('тот же экран подряд не повторяется; частые возможности уходят счётчиком', async () => {
  noteScreen('settings', 'audio');
  noteScreen('settings', 'audio');
  noteScreen('settings', 'video');
  noteFeature('reaction');
  noteFeature('reaction');
  noteFeature('hand');
  await vi.advanceTimersByTimeAsync(15_000);
  expect(
    sent()
      .filter((event) => event.n === 'screen')
      .map((event) => event.p.tab),
  ).toEqual(['audio', 'video']);
  expect(
    sent()
      .filter((event) => event.n === 'feature')
      .map((event) => event.p),
  ).toEqual([
    { name: 'reaction', count: 2 },
    { name: 'hand', count: 1 },
  ]);
});

it('откуда вошёл и откуда пришёл — словами, без адреса страницы', () => {
  expect(landingOf('/', false, false, false)).toBe('home');
  expect(landingOf('/join/abc', false, false, false)).toBe('invite');
  expect(landingOf('/room/7d4f6f0e-0000-4000-8000-000000000000', false, false, false)).toBe('room');
  expect(landingOf('/download', false, false, false)).toBe('download');
  expect(landingOf('/', true, false, false)).toBe('app');
  expect(landingOf('/', false, true, false)).toBe('app');
  expect(landingOf('/tg', false, false, false)).toBe('tg');
  expect(landingOf('/join/abc', false, false, true)).toBe('tg');
  expect(landingOf('/whatever', false, false, false)).toBe('other');
  expect(referrerHost('https://t.me/somechat', 'cord.online')).toBe('t.me');
  expect(referrerHost('https://cord.online/room/1', 'cord.online')).toBeUndefined();
  expect(referrerHost('', 'cord.online')).toBeUndefined();
  expect(referrerHost('not a url', 'cord.online')).toBeUndefined();
});
