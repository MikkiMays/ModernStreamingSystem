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

it('«Автоподключение» — переключатель набора без пояснения под ним, а не самодельная галочка (X4, R70)', () => {
  render(<FavoriteSettings room={room} initiallyOpen removing={false} remove={vi.fn()} />);
  const dialog = screen.getByRole('dialog', { name: 'Вечерний разговор' });
  expect(within(dialog).queryByRole('checkbox')).toBeNull();
  const automatic = within(dialog).getByRole('switch', { name: 'Автоподключение' });
  expect(automatic).toHaveClass('ui-switch');
  // Что делает автоподключение — не строкой под ним, а значком «?» (R173); диктору — описанием.
  expect(automatic).toHaveAccessibleDescription(/микрофон всегда включается сразу/);
  expect(dialog.querySelector('.ui-switch-row__hint')).toBeNull();
  expect(dialog).not.toHaveTextContent(/без предпросмотра/);
  expect(automatic).not.toBeChecked();
  fireEvent.click(automatic);
  expect(automatic).toBeChecked();
  expect(autoJoinEnabled(room.roomId)).toBe(true);
});

it('«?» у автоподключения подсказывает про микрофон и не переключает его (R173)', async () => {
  render(<FavoriteSettings room={room} initiallyOpen removing={false} remove={vi.fn()} />);
  const dialog = screen.getByRole('dialog', { name: 'Вечерний разговор' });
  const hint = within(dialog).getByRole('button', { name: 'Что делает автоподключение' });
  fireEvent.click(hint);
  expect(
    await screen.findByText(/микрофон всегда включается сразу/, { selector: '.ui-hint__popup' }),
  ).toBeVisible();
  expect(within(dialog).getByRole('switch', { name: 'Автоподключение' })).not.toBeChecked();
  expect(autoJoinEnabled(room.roomId)).toBe(false);
});
