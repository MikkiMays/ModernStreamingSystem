import { describe, expect, it, vi } from 'vitest';
import { BoardFiles, dataUrlToBlob } from './files';

/** Картинки доски (R159): байты — после проверки, соседу — с повторами, одна картинка — один раз. */
describe('картинки доски', () => {
  it('своя картинка уходит один раз, и элемент можно рассылать', async () => {
    const put = vi.fn(async () => {});
    const files = new BoardFiles(
      { put, get: async () => new Blob() },
      {
        get: () => ({ dataURL: 'data:image/png;base64,iVBORw0KGgo=', mimeType: 'image/png' }),
        add: () => {},
      },
    );
    expect(files.ready('f')).toBe(false);
    await Promise.all([files.upload('f'), files.upload('f')]);
    expect(put).toHaveBeenCalledTimes(1);
    const blob = (put.mock.calls[0] as unknown as [string, Blob])[1];
    expect(blob.type).toBe('image/png');
    expect(new Uint8Array(await blob.arrayBuffer()).slice(0, 4)).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    );
    expect(files.ready('f')).toBe(true);
  });

  it('чужая картинка достаётся с повторами — она могла ещё догружаться', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const added: string[] = [];
    const files = new BoardFiles(
      {
        put: async () => {},
        get: async () => {
          calls++;
          if (calls < 3) throw new Error('404');
          return new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
        },
      },
      { get: () => undefined, add: (list) => added.push(...list.map((file) => file.id)) },
      [10, 10, 10],
    );
    files.need('g');
    files.need('g');
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(20);
    }
    vi.useRealTimers();
    await vi.waitFor(() => expect(added).toEqual(['g']));
    expect(calls).toBe(3);
    expect(files.ready('g')).toBe(true);
  });

  it('data:-ссылка — в байты без fetch (CSP connect-src её не пускает)', async () => {
    const blob = dataUrlToBlob('data:image/gif;base64,R0lGODlh');
    expect(blob.type).toBe('image/gif');
    expect(new TextDecoder().decode(await blob.arrayBuffer())).toBe('GIF89a');
  });
});
