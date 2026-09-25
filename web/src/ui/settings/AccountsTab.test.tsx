import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readPreferences } from '../../core/preferences';
import { AccountsTab } from './AccountsTab';

beforeEach(() => localStorage.clear());
afterEach(cleanup);

it('shows the Yandex Music token field and saves typed values to the same preference key', () => {
  const change = vi.fn();
  const view = render(<AccountsTab preferences={readPreferences()} change={change} />);
  const field = view.getByLabelText('Токен Яндекс Музыки') as HTMLInputElement;
  expect(field).toHaveAttribute('type', 'password');
  expect(field).toHaveAttribute('maxlength', '1000');
  expect(field).toHaveAttribute('placeholder', 'Сохранить токен для автоподключения');
  expect(view.getByText(/подставляется, когда вы добавляете Яндекс Музыку/)).toBeInTheDocument();
  fireEvent.change(field, { target: { value: 'a-fresh-token' } });
  expect(change).toHaveBeenCalledWith({ yandexMusicToken: 'a-fresh-token' });
});

it('reflects the currently saved token back into the field', () => {
  const view = render(
    <AccountsTab
      preferences={{ ...readPreferences(), yandexMusicToken: 'already-saved' }}
      change={vi.fn()}
    />,
  );
  expect(view.getByLabelText('Токен Яндекс Музыки')).toHaveValue('already-saved');
});
