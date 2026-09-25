import { afterEach, expect, it, vi } from 'vitest';
import { ApiError, request } from './client';

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
