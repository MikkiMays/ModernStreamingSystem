import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { Snapshot } from '../../api/types';
import { Presence } from '../../core/presence';
import { PresenceAsk } from './Presence';

const snapshot = (you: Record<string, unknown> | null) => ({ serverTime: 1_000, you }) as unknown as Snapshot;

it('плашка «Вы ещё здесь?» — только когда ядро спросило, и ответ уходит одной кнопкой', () => {
  const send = vi.fn(() => Promise.resolve());
  const presence = new Presence(send, () => 1_000);
  const { rerender } = render(<PresenceAsk snapshot={snapshot({ can: [] })} presence={presence} />);
  expect(screen.queryByRole('alertdialog')).toBeNull();
  rerender(
    <PresenceAsk snapshot={snapshot({ can: [], presenceBy: 1_000 + 5 * 60_000 })} presence={presence} />,
  );
  const dialog = screen.getByRole('alertdialog', { name: 'Вы ещё здесь?' });
  expect(dialog.textContent).toMatch(/Без ответа вы выйдете из встречи в \d{2}:\d{2}/);
  fireEvent.click(screen.getByRole('button', { name: 'Я здесь' }));
  expect(send).toHaveBeenCalledTimes(1);
});
