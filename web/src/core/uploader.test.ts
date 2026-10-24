import { expect, it, vi } from 'vitest';
import type { RoomApi } from '../api/client';
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
