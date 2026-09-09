import { expect, it, vi } from 'vitest';
import type { RoomApi } from '../api/client';
import type { Attachment } from '../api/types';
import { Uploader } from './uploader';

const spies = vi.hoisted(() => ({ start: vi.fn(), abort: vi.fn(async () => {}) }));
vi.mock('tus-js-client', () => ({
  Upload: class {
    start = spies.start;
    abort = spies.abort;
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
