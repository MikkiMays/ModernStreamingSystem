import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { publicApi } from '../api/client';
import { favoriteApi, type Favorite } from '../core/favorites';
import { Store } from '../core/store';
import type { Meeting } from '../core/meeting';
import { headerStatus, MeetingHeader } from './MeetingHeader';

const roomId = '00000000-0000-4000-8000-000000000001';
const saved = (n: number): Favorite[] =>
  Array.from({ length: n }, (_, i) => ({
    roomId: `00000000-0000-4000-8000-${String(i + 10).padStart(12, '0')}`,
    title: `Комната ${i}`,
    code: '333444555',
    savedAt: i,
    closed: false,
    canJoin: true,
  }));

function fakeMeeting(extra: Record<string, unknown> = {}, status = 'connected') {
  const now = 1_760_000_000_000;
  return {
    admission: { roomId, participantId: 'self' },
    snapshot: new Store({
      title: 'Планёрка',
      code: '333444555',
      participants: [{ id: 'self', status: 'CONNECTED', service: null }],
      ...extra,
    }),
    media: { state: new Store({ status }), report: vi.fn() },
    ended: new Store<string | null>(null),
    serverNow: () => now,
  } as unknown as Meeting;
}

const clients: QueryClient[] = [];
function show(meeting: Meeting) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <MeetingHeader meeting={meeting} canEdit={false} onInvite={() => {}} onSettings={() => {}} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(publicApi, 'capabilities').mockResolvedValue({} as never);
  vi.spyOn(favoriteApi, 'list').mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
});

it('keeps a working meeting silent: no «В эфире», no theme switch in the header', () => {
  show(fakeMeeting());
  expect(screen.queryByText('В эфире')).not.toBeInTheDocument();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Тема/ })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Код встречи' })).toHaveTextContent('333-444-555');
});

it('says what is wrong next to the title, and only then', () => {
  expect(headerStatus(null, { status: 'CONNECTED' }, { status: 'connected' })).toBeNull();
  expect(headerStatus(null, { status: 'CONNECTED' }, { status: 'connecting' })?.label).toBe('Подключаемся…');
  expect(headerStatus(null, { status: 'CONNECTED' }, { status: 'recovering' })?.label).toBe(
    'Связь восстанавливается…',
  );
  expect(headerStatus(null, { status: 'WAITING' }, { status: 'idle' })?.label).toBe('Ожидание входа');
  expect(headerStatus('Встреча завершена', undefined, { status: 'ended' })?.label).toBe('Завершено');
  show(fakeMeeting({}, 'recovering'));
  expect(screen.getByRole('status')).toHaveTextContent('Связь восстанавливается…');
});

it('counts the meeting from the core’s start, by the server clock', () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  try {
    show(fakeMeeting({ startedAt: 1_760_000_000_000 - 65_000 }));
    expect(screen.getByRole('timer')).toHaveTextContent('01:05');
    expect(screen.getByRole('timer')).toHaveAccessibleName('Время встречи: 1 мин');
  } finally {
    vi.useRealTimers();
  }
});

it('shows no clock until the core reports a start', () => {
  show(fakeMeeting());
  expect(screen.queryByRole('timer')).not.toBeInTheDocument();
});

it('explains a full favourites list instead of offering a star that cannot work', async () => {
  vi.mocked(favoriteApi.list).mockResolvedValue(saved(10));
  show(fakeMeeting());
  const star = await screen.findByRole('button', { name: /Уберите одну, чтобы добавить эту/ });
  expect(star).toHaveAttribute('aria-disabled', 'true');
  await act(async () => star.click());
  await waitFor(() => expect(favoriteApi.list).toHaveBeenCalled());
  expect(screen.getByRole('button', { name: /В избранном уже 10 комнат/ })).toBeInTheDocument();
});
