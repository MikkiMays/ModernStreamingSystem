import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CinemaItem } from '../../../core/cinema';
import type { Meeting } from '../../../core/meeting';
import { Store } from '../../../core/store';
import { useTogether } from './useTogether';

const VIDEO = { provider: 'youtube', kind: 'video', id: 'dQw4w9WgXcQ', title: 'Ролик' } as CinemaItem;
const LIVE = { provider: 'twitch', kind: 'channel', id: 'pesh', title: 'Эфир' } as CinemaItem;

function meeting(command: (...args: unknown[]) => Promise<unknown>, owner = true) {
  return {
    admission: { participantId: 'me' },
    snapshot: new Store({ participants: [{ id: 'me', owner }], integrationsAllowed: false }),
    command: vi.fn(command),
    openCinema: vi.fn(),
  } as unknown as Meeting & { command: ReturnType<typeof vi.fn>; openCinema: ReturnType<typeof vi.fn> };
}

describe('useTogether: «Смотреть вместе»', () => {
  it('открывает комнате ролик как видео, а эфир как канал, и закрывает каталог', async () => {
    const room = meeting(() => Promise.resolve());
    const { result } = renderHook(() => useTogether(room));
    await act(() => result.current.open(VIDEO));
    await act(() => result.current.open(LIVE));
    expect(room.command.mock.calls).toEqual([
      ['watch.open', 'Ролик', undefined, { provider: 'youtube', kind: 'video', contentId: 'dQw4w9WgXcQ' }],
      ['watch.open', 'Эфир', undefined, { provider: 'twitch', kind: 'channel', contentId: 'pesh' }],
    ]);
    expect(room.openCinema).toHaveBeenCalledWith(null);
    expect(result.current.busy).toBe('');
    expect(result.current.error).toBe('');
  });

  it('пока команда идёт, занята именно эта карточка; после отказа — текст отказа и снова свободно', async () => {
    let fail: (error: Error) => void = () => {};
    const room = meeting(() => new Promise((_, reject) => (fail = reject)));
    const { result } = renderHook(() => useTogether(room));
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.open(VIDEO);
    });
    expect(result.current.busy).toBe('dQw4w9WgXcQ');
    await act(async () => {
      fail(new Error('Во встрече открыт покерный стол'));
      await pending;
    });
    expect(result.current.busy).toBe('');
    expect(result.current.error).toBe('Во встрече открыт покерный стол');
    expect(room.openCinema).not.toHaveBeenCalled();
  });

  it('без права включать не шлёт ничего', async () => {
    const room = meeting(() => Promise.resolve(), false);
    const { result } = renderHook(() => useTogether(room));
    expect(result.current.canUse).toBe(false);
    await act(() => result.current.open(VIDEO));
    expect(room.command).not.toHaveBeenCalled();
  });

  it('`open` не пересоздаётся на каждом рендере: сетки плиток не строятся заново впустую', () => {
    const room = meeting(() => Promise.resolve());
    const { result, rerender } = renderHook(() => useTogether(room));
    const first = result.current.open;
    rerender();
    rerender();
    expect(result.current.open).toBe(first);
  });
});
