import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { autoJoinEnabled, type Favorite } from '../core/favorites';
import { FavoriteSettings } from './FavoriteSettings';

const room: Favorite = {
  roomId: '00000000-0000-4000-8000-000000000004',
  title: 'Вечерний разговор',
  code: '333444555',
  savedAt: 1,
  closed: false,
  canJoin: true,
  pinned: false,
};

beforeEach(() => localStorage.clear());
afterEach(cleanup);

it('«Автоподключение» — переключатель набора с пояснением, а не самодельная галочка (X4)', () => {
  render(<FavoriteSettings room={room} initiallyOpen removing={false} remove={vi.fn()} />);
  const dialog = screen.getByRole('dialog', { name: 'Вечерний разговор' });
  expect(within(dialog).queryByRole('checkbox')).toBeNull();
  const automatic = within(dialog).getByRole('switch', { name: /Автоподключение/ });
  expect(automatic).toHaveClass('ui-switch');
  expect(automatic).not.toBeChecked();
  fireEvent.click(automatic);
  expect(automatic).toBeChecked();
  expect(autoJoinEnabled(room.roomId)).toBe(true);
});
