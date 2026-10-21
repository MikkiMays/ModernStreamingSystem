import { render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { Attachment, Snapshot } from '../../api/types';
import { CinemaTraffic, ExecutableNote, MeetingEnds } from './Notices';

const snapshot = (extra: Record<string, unknown>) => ({ serverTime: 1_000, ...extra }) as unknown as Snapshot;
const file = (extra: Record<string, unknown>) =>
  ({ id: 'f', name: 'a.exe', ...extra }) as unknown as Attachment;

it('плашка о конце встречи появляется только с `endsAt` от ядра', () => {
  const { rerender } = render(<MeetingEnds snapshot={snapshot({})} />);
  expect(screen.queryByRole('status')).toBeNull();
  rerender(<MeetingEnds snapshot={snapshot({ endsAt: 1_000 + 15 * 60_000 })} />);
  expect(screen.getByRole('status').textContent).toMatch(/^Встреча завершится в \d{2}:\d{2}/);
});

it('плашка о трафике кинозала: до порога её нет, на пороге — доля, на потолке — «остановлено»', () => {
  // Своим контейнером: плашка о конце встречи из теста выше остаётся в документе.
  const { container, rerender } = render(<CinemaTraffic snapshot={snapshot({})} />);
  const view = within(container);
  expect(view.queryByRole('status')).toBeNull();
  rerender(<CinemaTraffic snapshot={snapshot({ cinemaTraffic: 80 })} />);
  expect(view.getByRole('status').textContent).toBe(
    'Кинозал выбрал 80 % трафика этой встречи. Когда трафик кончится, кино остановится до конца встречи',
  );
  rerender(<CinemaTraffic snapshot={snapshot({ cinemaTraffic: 100 })} />);
  expect(view.getByRole('status').textContent).toBe(
    'Трафик кинозала в этой встрече кончился — кино остановлено до конца встречи',
  );
});

it('у файла, который может запустить программу, — предупреждение, у остальных — ничего', () => {
  const { rerender } = render(<ExecutableNote file={file({ executable: true })} />);
  expect(screen.getByRole('note').textContent).toContain('Файл может запустить программу');
  rerender(<ExecutableNote file={file({ executable: false })} />);
  expect(screen.queryByRole('note')).toBeNull();
});
