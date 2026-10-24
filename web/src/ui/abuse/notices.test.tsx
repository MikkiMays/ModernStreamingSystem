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
  // В шапке — коротко (R27), полностью — в подсказке и для диктора.
  const status = screen.getByRole('status');
  expect(status.textContent).toMatch(/^до \d{2}:\d{2}$/);
  expect(status.getAttribute('title')).toMatch(/^Встреча завершится в \d{2}:\d{2}: у встреч/);
  expect(status).toHaveAccessibleName(status.getAttribute('title')!);
});

it('плашка о трафике кинозала: до порога её нет, на пороге — доля, на потолке — «остановлено»', () => {
  // Своим контейнером: плашка о конце встречи из теста выше остаётся в документе.
  const { container, rerender } = render(<CinemaTraffic snapshot={snapshot({})} />);
  const view = within(container);
  expect(view.queryByRole('status')).toBeNull();
  rerender(<CinemaTraffic snapshot={snapshot({ cinemaTraffic: 80 })} />);
  expect(view.getByRole('status').textContent).toBe('кинозал 80 %');
  expect(view.getByRole('status').getAttribute('title')).toBe(
    'Кинозал выбрал 80 % трафика этой встречи. Когда трафик кончится, кино остановится до конца встречи',
  );
  rerender(<CinemaTraffic snapshot={snapshot({ cinemaTraffic: 100 })} />);
  expect(view.getByRole('status').textContent).toBe('кино остановлено');
  expect(view.getByRole('status')).toHaveAccessibleName(
    'Трафик кинозала в этой встрече кончился — кино остановлено до конца встречи',
  );
});

it('у файла, который может запустить программу, — предупреждение, у остальных — ничего', () => {
  const { rerender } = render(<ExecutableNote file={file({ executable: true })} />);
  expect(screen.getByRole('note').textContent).toContain('Файл может запустить программу');
  rerender(<ExecutableNote file={file({ executable: false })} />);
  expect(screen.queryByRole('note')).toBeNull();
});
