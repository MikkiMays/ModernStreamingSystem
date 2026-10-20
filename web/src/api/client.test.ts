import { afterEach, expect, it, vi } from 'vitest';
import { ApiError, publicApi, request, RoomApi } from './client';
import { profileSecret } from '../core/identity';
import { i18next } from '../i18n';

/*
  Отказ сервера — словами для человека.

  FastAPI на неверный ввод отвечает 422 со списком ошибок проверки в `detail`, и интерфейс
  показывал «[object Object]»: например, на поиск в каталоге длиннее 120 знаков — а таких полей
  поиска теперь пять, по одному на сцену.
*/

afterEach(() => vi.unstubAllGlobals());

function answer(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(body === undefined ? '' : JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    ),
  );
}

async function refusal() {
  const error = await request('/anything').catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

it('список ошибок проверки FastAPI (422) — одной фразой, а не «[object Object]»', async () => {
  answer(422, {
    detail: [
      {
        type: 'string_too_long',
        loc: ['query', 'query'],
        msg: 'String should have at most 120 characters',
        input: 'x'.repeat(121),
        ctx: { max_length: 120 },
      },
    ],
  });
  const error = await refusal();
  expect(error.message).toBe('Проверьте данные запроса');
  expect(error.status).toBe(422);
  expect(error.code).toBe('REQUEST_FAILED');
});

it('любой другой не строковый `detail` — та же фраза', async () => {
  answer(400, { detail: { reason: 'x' } });
  expect((await refusal()).message).toBe('Проверьте данные запроса');
  answer(400, { detail: 42 });
  expect((await refusal()).message).toBe('Проверьте данные запроса');
});

it('отказ словами сервера остаётся его словами, а без слов — «Не удалось выполнить запрос»', async () => {
  answer(400, { code: 'WATCH_INVALID', detail: 'Эта площадка выключена на этом сервере' });
  const error = await refusal();
  expect(error.message).toBe('Эта площадка выключена на этом сервере');
  expect(error.code).toBe('WATCH_INVALID');
  answer(502, undefined);
  expect((await refusal()).message).toBe('Не удалось выполнить запрос');
  answer(500, { detail: null });
  expect((await refusal()).message).toBe('Не удалось выполнить запрос');
});

it('на другом языке отказ говорит переводом по коду, а без перевода — словами сервера (E14)', async () => {
  await i18next.changeLanguage('en');
  try {
    i18next.addResourceBundle('en', 'translation', { errors: { ROOM_FULL: 'The meeting is full' } }, true);
    answer(409, { code: 'ROOM_FULL', detail: 'Во встрече уже 20 участников' });
    const error = await refusal();
    expect(error.message).toBe('The meeting is full');
    expect(error.code).toBe('ROOM_FULL');
    answer(400, { code: 'WATCH_INVALID', detail: 'Эта площадка выключена на этом сервере' });
    expect((await refusal()).message).toBe('Эта площадка выключена на этом сервере');
  } finally {
    await i18next.changeLanguage('ru');
  }
});

/*
  Профиль устройства во входах (T52).

  Ядро держит одну активную встречу на профиль и узнаёт его по `X-Cord-Profile` — во всех дверях во
  встречу. «Выйти оттуда и войти сюда» — тот же запрос с `X-Cord-Leave`. Остальные запросы профиль
  не несут: ему незачем ходить туда, где он ничего не решает.
*/

const sent = () => {
  const call = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls.at(-1)!;
  return { path: call[0], headers: call[1].headers as Record<string, string> };
};

it('каждый вход во встречу несёт профиль, повтор после отказа — ещё и встречу, которую покидают', async () => {
  const profile = profileSecret();
  const admission = { roomId: 'room-2', credential: 'member.secret' } as never;
  const room = { commandId: 'c', title: 'Т', name: 'И', approvalRequired: false };
  const entries: [string, () => Promise<unknown>, () => Promise<unknown>][] = [
    ['/api/v1/rooms', () => publicApi.create(room), () => publicApi.create(room, 'room-1')],
    [
      '/api/v1/rooms/room-2/join',
      () => publicApi.join('room-2', { commandId: 'c', invite: 'i', name: 'И' }),
      () => publicApi.join('room-2', { commandId: 'c', invite: 'i', name: 'И' }, 'room-1'),
    ],
    [
      '/api/v1/rooms/join-by-code',
      () => publicApi.joinCode({ commandId: 'c', code: '123456789', name: 'И' }),
      () => publicApi.joinCode({ commandId: 'c', code: '123456789', name: 'И' }, 'room-1'),
    ],
    [
      '/api/v1/rooms/room-2/rejoin',
      () => new RoomApi(admission).rejoin('И', 'c'),
      () => new RoomApi(admission).rejoin('И', 'c', 'room-1'),
    ],
  ];
  for (const [path, plain, leaving] of entries) {
    answer(200, {});
    await plain();
    expect(sent().path).toBe(path);
    expect(sent().headers['X-Cord-Profile']).toBe(profile);
    expect(sent().headers['X-Cord-Leave']).toBeUndefined();
    await leaving();
    expect(sent().headers['X-Cord-Profile']).toBe(profile);
    expect(sent().headers['X-Cord-Leave']).toBe('room-1');
  }
  // Снимок, команды и прочее профиль не несут.
  await new RoomApi(admission).snapshot();
  expect(sent().headers['X-Cord-Profile']).toBeUndefined();
});

it('подробности отказа ядра (RFC 7807) доходят до интерфейса значениями', async () => {
  answer(409, {
    code: 'ALREADY_IN_MEETING',
    detail: 'Вы уже во встрече «Вечер»',
    roomId: 'room-1',
    title: 'Вечер',
  });
  const error = await refusal();
  expect(error.code).toBe('ALREADY_IN_MEETING');
  expect(error.problem).toMatchObject({ roomId: 'room-1', title: 'Вечер' });
});
