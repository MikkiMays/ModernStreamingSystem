import { expect, it, vi } from 'vitest';
import { ApiError, type RoomApi } from '../api/client';
import type { Attachment } from '../api/types';
import { Uploader } from './uploader';

const spies = vi.hoisted(() => ({
  start: vi.fn(),
  abort: vi.fn(async () => {}),
  uploads: [] as { onSuccess?: () => void; onError?: (error: Error) => void }[],
}));
vi.mock('tus-js-client', () => ({
  Upload: class {
    start = spies.start;
    abort = spies.abort;
    constructor(_file: unknown, options: { onSuccess?: () => void; onError?: (error: Error) => void }) {
      spies.uploads.push(options);
    }
  },
}));

it('keeps an upload paused when reservation finishes after congestion was detected', async () => {
  spies.start.mockClear();
  let finish!: (value: Attachment) => void;
  const api = {
    reserve: vi.fn(
      () =>
        new Promise<Attachment>((resolve) => {
          finish = resolve;
        }),
    ),
    files: vi.fn(async () => []),
  } as unknown as RoomApi;
  const uploader = new Uploader(api, vi.fn());
  const pending = uploader.start(new File(['abc'], 'a.txt'));
  await uploader.congestion(true);
  finish({ id: 'file', uploadId: null } as Attachment);
  await pending;
  expect(uploader.state.get().status).toBe('paused');
  expect(spies.start).not.toHaveBeenCalled();
  await uploader.congestion(false);
  expect(spies.start).toHaveBeenCalledOnce();
});

it('cancels a late reservation without restarting a cancelled upload', async () => {
  spies.start.mockClear();
  let finish!: (value: Attachment) => void;
  const api = {
    reserve: vi.fn(
      () =>
        new Promise<Attachment>((resolve) => {
          finish = resolve;
        }),
    ),
    cancel: vi.fn(async () => {}),
  } as unknown as RoomApi;
  const uploader = new Uploader(api, vi.fn());
  const pending = uploader.start(new File(['abc'], 'a.txt'));
  await uploader.cancel();
  finish({ id: 'file', uploadId: null } as Attachment);
  await pending;
  expect(api.cancel).toHaveBeenCalledWith('file');
  expect(spies.start).not.toHaveBeenCalled();
  expect(uploader.state.get().status).toBe('idle');
});

it('send waits for the running upload, then for its own (R94)', async () => {
  spies.start.mockClear();
  spies.uploads.length = 0;
  const api = {
    reserve: vi.fn(async (name: string) => ({ id: name, uploadId: null }) as Attachment),
  } as unknown as RoomApi;
  const uploader = new Uploader(api, vi.fn());
  const first = uploader.send(new File(['a'], 'first.png'));
  const second = uploader.send(new File(['b'], 'second.png'));
  await vi.waitFor(() => expect(spies.uploads).toHaveLength(1));
  // Второй ждёт: загрузчик везёт один файл за раз.
  expect(api.reserve).toHaveBeenCalledTimes(1);
  spies.uploads[0]!.onSuccess!();
  expect(await first).toBe(true);
  await vi.waitFor(() => expect(spies.uploads).toHaveLength(2));
  expect(api.reserve).toHaveBeenLastCalledWith('second.png', 1, expect.any(String));
  spies.uploads[1]!.onError!(new Error('сеть'));
  expect(await second).toBe(false);
});

it('второй файл подряд ждёт, пока ядро отметит первый готовым (UPLOAD_BUSY — гонка с крюком tusd, R154)', async () => {
  vi.useFakeTimers();
  try {
    spies.start.mockClear();
    spies.uploads.length = 0;
    let busy = 2;
    const api = {
      reserve: vi.fn(async (name: string) => {
        if (name === 'board.cord-board' && busy-- > 0)
          throw new ApiError(409, 'UPLOAD_BUSY', 'Дождитесь завершения текущей загрузки');
        return { id: name, uploadId: null } as Attachment;
      }),
    } as unknown as RoomApi;
    const uploader = new Uploader(api, vi.fn());
    const png = uploader.send(new File(['a'], 'board.png'));
    const doc = uploader.send(new File(['b'], 'board.cord-board'));
    await vi.waitFor(() => expect(spies.uploads).toHaveLength(1));
    spies.uploads[0]!.onSuccess!();
    expect(await png).toBe(true);
    // Два отказа «ещё идёт» — и резерв с тем же идентификатором команды проходит.
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(spies.uploads).toHaveLength(2));
    const calls = vi.mocked(api.reserve).mock.calls.filter(([name]) => name === 'board.cord-board');
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map(([, , id]) => id)).size).toBe(1);
    spies.uploads[1]!.onSuccess!();
    expect(await doc).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it('настоящая занятость — ошибка после повторов, без вечного ожидания', async () => {
  vi.useFakeTimers();
  try {
    spies.uploads.length = 0;
    const api = {
      reserve: vi.fn(async () => {
        throw new ApiError(409, 'UPLOAD_BUSY', 'Дождитесь завершения текущей загрузки');
      }),
    } as unknown as RoomApi;
    const uploader = new Uploader(api, vi.fn());
    const sent = uploader.send(new File(['a'], 'file.txt'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await sent).toBe(false);
    expect(api.reserve).toHaveBeenCalledTimes(6);
    expect(uploader.state.get().status).toBe('error');
    expect(spies.uploads).toHaveLength(0);
  } finally {
    vi.useRealTimers();
  }
});
