import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readPreferences } from '../core/preferences';
import { Settings } from './Settings';

// Вне встречи и без темы поднимаются только «Профиль», «Аккаунты» и соседние текстовые
// вкладки: «Звук»/«Видео» без `meeting` тянут проверку устройств, которой здесь не место.
beforeEach(() => localStorage.clear());
afterEach(cleanup);

it('moves the Yandex Music token out of «Профиль» and into «Аккаунты», saving under the same key', () => {
  render(<Settings open section="profile" onOpenChange={vi.fn()} />);
  // «Профиль» открывается первой — токена в ней больше нет.
  expect(screen.queryByLabelText('Токен Яндекс Музыки')).not.toBeInTheDocument();
  expect(screen.queryByText(/Токен Яндекс Музыки/)).not.toBeInTheDocument();
  expect(screen.getByLabelText('Имя по умолчанию')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('tab', { name: 'Аккаунты' }));
  const field = screen.getByLabelText('Токен Яндекс Музыки');
  expect(field).toHaveValue('');
  fireEvent.change(field, { target: { value: 'moved-token' } });
  expect(readPreferences().yandexMusicToken).toBe('moved-token');

  // Значение сохранилось на устройстве — переоткрытая вкладка видит его же.
  fireEvent.click(screen.getByRole('tab', { name: 'Профиль' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Аккаунты' }));
  expect(screen.getByLabelText('Токен Яндекс Музыки')).toHaveValue('moved-token');
});
