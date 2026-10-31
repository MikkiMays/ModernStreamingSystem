import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Admission } from '../../api/types';
import { readCreateTitle, recordVisit, type Presence } from '../../core/recent-meetings';
import { ToastProvider } from '../kit';
import { RecentMeetings } from './RecentMeetings';

const presence = vi.hoisted(() => ({ answers: [] as Presence[] }));
vi.mock('../../core/recent-meetings', async (original) => ({
  ...(await original<typeof import('../../core/recent-meetings')>()),
  fetchPresence: async () => new Map(presence.answers.map((answer) => [answer.roomId, answer])),
}));
vi.mock('../../api/client', async (original) => ({
  ...(await original<typeof import('../../api/client')>()),
  RoomApi: class {
    constructor(readonly admission: Admission) {}
    snapshot = async () => ({ ...this.admission.snapshot, id: this.admission.roomId, title: 'Снимок' });
  },
}));

const admission = (roomId: string, closedAt: number | null = null) =>
  ({
    roomId,
    credential: `${roomId}.secret`,
    participantId: `${roomId}-me`,
    inviteUrl: null,
    recoverySeconds: 30,
    snapshot: {
      id: roomId,
      title: `Встреча ${roomId}`,
      code: '123456789',
      closedAt,
      participants: [{ id: `${roomId}-me`, name: 'Я', owner: true }],
    },
  }) as unknown as Admission;

function show(onJoin = vi.fn(), onCreate = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ToastProvider>
        <RecentMeetings onJoin={onJoin} onCreate={onCreate} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { onJoin, onCreate };
}

describe('«Недавние» на главной (R148)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    presence.answers = [];
  });
  afterEach(cleanup);

  it('пустой список — блока нет вовсе', () => {
    show();
    expect(screen.queryByRole('region', { name: 'Недавние' })).toBeNull();
    expect(screen.queryByText('Недавние')).toBeNull();
  });

  it('идущая встреча: сколько людей и «Вернуться» тем же участником', async () => {
    recordVisit(admission('live'));
    presence.answers = [{ roomId: 'live', state: 'live', people: 3, title: 'Дейли', code: '123456789' }];
    const { onJoin } = show();
    const row = (await screen.findByText('Дейли')).closest('li')!;
    expect(within(row).getByText('3 человека')).toBeInTheDocument();
    expect(within(row).getByText(/123-456-789 · сегодня/)).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: 'Вернуться' }));
    await waitFor(() => expect(onJoin).toHaveBeenCalled());
    expect(onJoin.mock.calls[0]![0]).toMatchObject({
      kind: 'recent',
      admission: {
        roomId: 'live',
        credential: 'live.secret',
        participantId: 'live-me',
        snapshot: { title: 'Снимок' },
      },
    });
  });

  it('завершённая — «Создать снова» с тем же названием для предвхода', async () => {
    recordVisit(admission('done', 1000));
    presence.answers = [
      { roomId: 'done', state: 'closed', people: 0, title: 'Встреча done', code: '123456789' },
    ];
    const { onCreate } = show();
    const row = (await screen.findByText('Встреча done')).closest('li')!;
    await waitFor(() => expect(within(row).getByText(/завершена/)).toBeInTheDocument());
    fireEvent.click(within(row).getByRole('button', { name: 'Создать снова' }));
    expect(onCreate).toHaveBeenCalled();
    expect(readCreateTitle()).toBe('Встреча done');
  });

  it('«Очистить» спрашивает и убирает весь блок', async () => {
    recordVisit(admission('a'));
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Очистить' }));
    const dialog = await screen.findByRole('dialog', { name: 'Очистить недавние?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Очистить' }));
    await waitFor(() => expect(screen.queryByText('Встреча a')).toBeNull());
  });
});
