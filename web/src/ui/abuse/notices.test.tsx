import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { Attachment, Snapshot } from '../../api/types';
import { ExecutableNote, MeetingEnds } from './Notices';

const snapshot = (extra: Record<string, unknown>) => ({ serverTime: 1_000, ...extra }) as unknown as Snapshot;
const file = (extra: Record<string, unknown>) =>
  ({ id: 'f', name: 'a.exe', ...extra }) as unknown as Attachment;

it('плашка о конце встречи появляется только с `endsAt` от ядра', () => {
  const { rerender } = render(<MeetingEnds snapshot={snapshot({})} />);
  expect(screen.queryByRole('status')).toBeNull();
  rerender(<MeetingEnds snapshot={snapshot({ endsAt: 1_000 + 15 * 60_000 })} />);
  expect(screen.getByRole('status').textContent).toMatch(/^Встреча завершится в \d{2}:\d{2}/);
});

it('у файла, который может запустить программу, — предупреждение, у остальных — ничего', () => {
  const { rerender } = render(<ExecutableNote file={file({ executable: true })} />);
  expect(screen.getByRole('note').textContent).toContain('Файл может запустить программу');
  rerender(<ExecutableNote file={file({ executable: false })} />);
  expect(screen.queryByRole('note')).toBeNull();
});
