import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Favorite } from '../core/favorites';
import { FavoriteReorder, moveFavorite } from './favorite-reorder';

const rooms = ['a', 'b', 'c'].map((roomId) => ({ roomId, title: roomId }) as Favorite);

describe('favorite reorder controls', () => {
  it('moves a room by keyboard or drag destination without changing the others', () => {
    expect(moveFavorite(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b']);
    expect(moveFavorite(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'c', 'a']);
  });

  it('does not manufacture a move for an unknown room or its current slot', () => {
    const rooms = ['a', 'b'];
    expect(moveFavorite(rooms, 'missing', 0)).toBe(rooms);
    expect(moveFavorite(rooms, 'b', 1)).toBe(rooms);
    expect(moveFavorite(rooms, 'b', 2)).toBe(rooms);
  });

  it('uses a pointer insertion boundary, so dragging before a later room does not jump past it', () => {
    const reorder = vi.fn();
    const view = render(
      <FavoriteReorder rooms={rooms} pending={false} reorder={reorder}>
        {(room) => <span>{room.title}</span>}
      </FavoriteReorder>,
    );
    view.getAllByRole('listitem').forEach((item, index) =>
      vi.spyOn(item, 'getBoundingClientRect').mockReturnValue({
        bottom: (index + 1) * 40,
        height: 40,
        left: 0,
        right: 100,
        top: index * 40,
        width: 100,
        x: 0,
        y: index * 40,
        toJSON: () => ({}),
      }),
    );
    const handle = view.getByLabelText(/Переместить «a»/);
    Object.assign(handle, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() });
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientY: 10 });
    fireEvent.pointerUp(handle, { button: 0, pointerId: 1, clientY: 85 });

    expect(reorder).toHaveBeenCalledWith(['b', 'a', 'c']);
  });
});
