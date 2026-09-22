import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Meeting } from '../core/meeting';
import type { DurakTable } from '../api/types';
import { DurakReactions } from './DurakReactions';
import { DURAK_STICKERS } from '../core/durak-stickers';
let now = 10000;
const command = vi.fn().mockResolvedValue(undefined);
const meeting = { serverNow: () => now, command } as unknown as Meeting;
const table = { seats: [{ index: 3, name: 'Маша' }], reactions: [] } as unknown as DurakTable;
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  command.mockClear();
  now = 10000;
});
describe('Durak reactions', () => {
  it('keeps all protocol IDs but deduplicates the artwork', () => {
    expect(DURAK_STICKERS).toHaveLength(54);
    expect(new Set(DURAK_STICKERS.map((s) => s.asset)).size).toBe(29);
    expect(DURAK_STICKERS.every((s) => s.label.length > 3)).toBe(true);
  });
  it('expires at server time and stops its timer', () => {
    vi.useFakeTimers();
    const active = {
      ...table,
      reactions: [{ id: 1, at: 10000, expiresAt: 12500, seat: 3, stickerId: 'durak-online-27' }],
    };
    render(
      <DurakReactions meeting={meeting} table={active} seat={3}>
        <span>Маша</span>
      </DurakReactions>,
    );
    expect(screen.getByRole('img', { name: 'Маша: Привет' })).toBeVisible();
    expect(screen.getByRole('img', { name: 'Маша: Привет' }).querySelector('img')).toHaveAttribute(
      'src',
      '/games/durak-online-19.webp',
    );
    now = 12501;
    act(() => vi.advanceTimersByTime(300));
    expect(screen.queryByRole('img')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('opens the unique labeled picker, supports arrows, and sends the selected ID', async () => {
    render(
      <DurakReactions meeting={meeting} table={table} seat={3} mine>
        <span>Маша</span>
      </DurakReactions>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Отправить реакцию' }));
    const first = await screen.findByRole('button', { name: 'Смех до слёз' });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(screen.getByRole('button', { name: 'Закрыть лицо рукой' })).toHaveFocus();
    await act(async () => fireEvent.click(first));
    expect(command).toHaveBeenCalledWith('durak.react', undefined, undefined, { option: 'durak-online-01' });
  });
  it('keeps a text fallback when an image fails', () => {
    render(
      <DurakReactions
        meeting={meeting}
        table={{
          ...table,
          reactions: [{ id: 1, at: 10000, expiresAt: 12500, seat: 3, stickerId: 'durak-online-01' }],
        }}
        seat={3}
      >
        <span>Маша</span>
      </DurakReactions>,
    );
    const reaction = screen.getByRole('img');
    fireEvent.error(reaction.querySelector('img')!);
    expect(reaction).toHaveTextContent('Смех до слёз');
  });
});

it('does not offer reactions when an older server omits the capability field', () => {
  render(
    <DurakReactions meeting={meeting} table={{ ...table, reactions: undefined }} seat={3} mine>
      <span>Маша</span>
    </DurakReactions>,
  );
  expect(screen.queryByRole('button', { name: 'Отправить реакцию' })).toBeNull();
  expect(screen.getByText('Маша')).toBeVisible();
});
