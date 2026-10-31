import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { beginInviteCopy, copyWhenReady, inviteLink, takeInviteCopy } from './invite-copy';

const written: string[] = [];

function clipboard({ items = true, text = true } = {}) {
  written.length = 0;
  vi.stubGlobal('navigator', {
    clipboard: {
      write: items
        ? vi.fn(async (list: ClipboardItem[]) => {
            const blob = await list[0].getType('text/plain');
            written.push(await blob.text());
          })
        : undefined,
      writeText: text
        ? vi.fn(async (value: string) => {
            written.push(value);
          })
        : vi.fn(async () => {
            throw new Error('denied');
          }),
    },
  });
}

class FakeItem {
  constructor(private readonly data: Record<string, Promise<Blob>>) {}
  getType(type: string) {
    return this.data[type];
  }
}

beforeEach(() => {
  vi.stubGlobal('ClipboardItem', FakeItem);
  takeInviteCopy();
});
afterEach(() => vi.unstubAllGlobals());

describe('ссылка новой встречи — в буфер сразу (R142)', () => {
  it('запись начинается до ответа сервера, а ссылка подставляется, когда встреча создана', async () => {
    clipboard();
    const settle = beginInviteCopy();
    expect(navigator.clipboard.write).toHaveBeenCalledTimes(1);
    settle('https://cord.example/r/abc?invite=1');
    const copy = takeInviteCopy()!;
    await expect(copy.copied).resolves.toBe(true);
    expect(written).toEqual(['https://cord.example/r/abc?invite=1']);
  });

  it('без обещаний в ClipboardItem — тем же текстом через writeText', async () => {
    clipboard({ items: false });
    await expect(copyWhenReady(Promise.resolve('https://cord.example/x'))).resolves.toBe(true);
    expect(written).toEqual(['https://cord.example/x']);
  });

  it('встречу создать не вышло — в буфер ничего, итог «не скопировано»', async () => {
    clipboard();
    const settle = beginInviteCopy();
    settle(null);
    await expect(takeInviteCopy()!.copied).resolves.toBe(false);
    expect(written).toEqual([]);
  });

  it('буфер не дался — «не скопировано», а не исключение', async () => {
    clipboard({ items: false, text: false });
    await expect(copyWhenReady(Promise.resolve('https://cord.example/x'))).resolves.toBe(false);
  });

  it('итог забирает одна встреча и не позже минуты', () => {
    clipboard();
    beginInviteCopy()('https://cord.example/x');
    expect(takeInviteCopy(Date.now() + 61_000)).toBeNull();
    beginInviteCopy()('https://cord.example/x');
    expect(takeInviteCopy()).not.toBeNull();
    expect(takeInviteCopy()).toBeNull();
  });

  it('ссылка — своя у встречи, иначе вход по коду', () => {
    expect(
      inviteLink({ inviteUrl: 'https://cord.example/r/1', snapshot: { code: '123456789' } } as never),
    ).toBe('https://cord.example/r/1');
    expect(inviteLink({ inviteUrl: null, snapshot: { code: '123456789' } } as never)).toBe(
      `${location.origin}/join/123456789`,
    );
  });
});
