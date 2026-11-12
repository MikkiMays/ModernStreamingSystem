import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Snapshot } from '../api/types';
import { resetInsightForTest } from './insight';
import {
  IntegrationViews,
  activeIntegrations,
  noteCinemaStall,
  resetIntegrationViewsForTest,
} from './insight-views';

/**
 * Просмотр интеграций (R239): что идёт во встрече — по снимку; секунды — пока страница видна (музыка — всегда);
 * событие — раз в полминуты и при уходе, застои кино — вместе с просмотром кино.
 */
const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 }));
const events = () =>
  fetchMock.mock.calls
    .filter(([url]) => url === '/api/v1/t')
    .flatMap(
      ([, init]) =>
        (JSON.parse(String(init?.body)) as { events: { n: string; p: Record<string, unknown> }[] }).events,
    )
    .filter((event) => event.n === 'integration_view')
    .map((event) => event.p);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockClear();
  sessionStorage.clear();
  resetInsightForTest();
  resetIntegrationViewsForTest();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const snapshot = (patch: Partial<Snapshot>): Snapshot =>
  ({ participants: [], watch: null, poker: null, durak: null, ...patch }) as Snapshot;

it('что идёт во встрече: кино с площадкой, игры по именам, доска и музыка — по боту во встрече', () => {
  expect(activeIntegrations(snapshot({}))).toEqual([]);
  expect(
    activeIntegrations(
      snapshot({
        watch: { provider: 'youtube' } as Snapshot['watch'],
        durak: {} as Snapshot['durak'],
        board: {} as Snapshot['board'],
        participants: [
          { service: 'music', status: 'CONNECTED' },
          { service: null, status: 'CONNECTED' },
        ] as Snapshot['participants'],
      }),
    ),
  ).toEqual([
    { kind: 'cinema', variant: 'youtube' },
    { kind: 'game', variant: 'durak' },
    { kind: 'board' },
    { kind: 'music' },
  ]);
  // Бот музыки ещё входит — музыка не идёт.
  expect(
    activeIntegrations(
      snapshot({ participants: [{ service: 'music', status: 'JOINING' }] as Snapshot['participants'] }),
    ),
  ).toEqual([]);
});

it('секунды копятся по замерам; скрытая страница — только музыка; сон вкладки не в счёт; застои — с кино', async () => {
  const views = new IntegrationViews('room-1');
  const cinema = { kind: 'cinema', variant: 'ivi' } as const;
  const music = { kind: 'music' } as const;
  views.tick([cinema, music], true, 0);
  views.tick([cinema, music], true, 5_000);
  views.tick([cinema, music], false, 10_000); // страница скрыта: кино не смотрят, музыку слушают
  views.tick([cinema, music], true, 70_000); // вкладка спала минуту — не просмотр
  views.tick([cinema, music], true, 75_000);
  noteCinemaStall(1_400);
  noteCinemaStall(600);
  views.flush();
  await vi.advanceTimersByTimeAsync(6_000);
  expect(events()).toEqual([
    { room: 'room-1', kind: 'cinema', variant: 'ivi', seconds: 10, stalls: 2, stall_ms: 2000 },
    { room: 'room-1', kind: 'music', seconds: 15 },
  ]);
  // Отправленное не повторяется; застои не переходят на следующий просмотр.
  fetchMock.mockClear();
  views.tick([cinema], true, 80_000);
  views.tick([cinema], true, 80_400); // меньше секунды — ждёт следующего раза
  views.flush();
  await vi.advanceTimersByTimeAsync(6_000);
  expect(events()).toEqual([{ room: 'room-1', kind: 'cinema', variant: 'ivi', seconds: 5 }]);
});
