import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Admission } from '../../api/types';
import { favoriteApi, type Favorite } from '../../core/favorites';
import { listRecent, readCreateTitle, recordVisit, type Presence } from '../../core/recent-meetings';
import { ToastProvider } from '../kit';
import { RecentMeetings, recentStep } from './RecentMeetings';

const presence = vi.hoisted(() => ({ answers: [] as Presence[] }));
/** Ответ ядра на снимок по пропуску из списка: `status` — отказ с этим кодом. */
const room = vi.hoisted(() => ({ status: 0, closedAt: null as number | null }));
vi.mock('../../core/recent-meetings', async (original) => ({
  ...(await original<typeof import('../../core/recent-meetings')>()),
  fetchPresence: async () => new Map(presence.answers.map((answer) => [answer.roomId, answer])),
}));
vi.mock('../../api/client', async (original) => ({
  ...(await original<typeof import('../../api/client')>()),
  RoomApi: class {
    constructor(readonly admission: Admission) {}
    snapshot = async () => {
      if (room.status) throw Object.assign(new Error('Отказ'), { status: room.status });
      return {
        ...this.admission.snapshot,
        id: this.admission.roomId,
        title: 'Снимок',
        closedAt: room.closedAt,
      };
    };
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

const saved = (roomId: string): Favorite => ({
  roomId,
  title: `Встреча ${roomId}`,
  code: '123456789',
  savedAt: 1,
  closed: false,
  canJoin: true,
  pinned: false,
});

describe('«Недавние» на главной (R148)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    presence.answers = [];
    room.status = 0;
    room.closedAt = null;
    vi.spyOn(favoriteApi, 'list').mockResolvedValue([]);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('пустой список — блока нет вовсе', () => {
    show();
    expect(screen.queryByRole('region', { name: 'Недавние' })).toBeNull();
    expect(screen.queryByText('Недавние')).toBeNull();
  });

  it('идущая встреча: вся карточка — одна кнопка «Вернуться» тем же участником (R162, R164)', async () => {
    recordVisit(admission('live'));
    presence.answers = [{ roomId: 'live', state: 'live', people: 3, title: 'Дейли', code: '123456789' }];
    const { onJoin, onCreate } = show();
    const card = await screen.findByRole('button', { name: 'Вернуться: Дейли' });
    // Что будет — словом на самой карточке; код, время и люди — описанием кнопки.
    expect(card).toHaveTextContent('Вернуться');
    expect(card).toHaveAccessibleDescription(/^сегодня, \d\d:\d\d · 123-456-789 3 человека$/);
    // Внутри карточки нет ни одной другой кнопки: «…» — рядом, а не в ней.
    expect(within(card).queryAllByRole('button')).toEqual([]);
    expect(card.closest('li')!.querySelectorAll('button')).toHaveLength(2);
    fireEvent.click(card);
    await waitFor(() => expect(onJoin).toHaveBeenCalled());
    expect(onCreate).not.toHaveBeenCalled();
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

  it('завершённая — та же карточка «Создать снова» с тем же названием для предвхода', async () => {
    recordVisit(admission('done', 1000));
    presence.answers = [
      { roomId: 'done', state: 'closed', people: 0, title: 'Встреча done', code: '123456789' },
    ];
    const { onCreate, onJoin } = show();
    const card = await screen.findByRole('button', { name: 'Создать снова: Встреча done' });
    expect(card).toHaveTextContent('Создать снова');
    expect(card).toHaveAccessibleDescription(/^сегодня, \d\d:\d\d · завершена · 123-456-789$/);
    fireEvent.click(card);
    expect(onCreate).toHaveBeenCalled();
    expect(onJoin).not.toHaveBeenCalled();
    expect(readCreateTitle()).toBe('Встреча done');
  });

  it('шаг карточки: ответ ядра главнее записи, без ответа — запись', () => {
    const entry = { roomId: 'a', code: '1', title: 'A', creator: false, lastAt: 1, credential: 'c' };
    expect(recentStep(entry).step).toBe('rejoin');
    expect(recentStep({ ...entry, closedAt: 5 }).step).toBe('again');
    expect(recentStep({ ...entry, credential: undefined }).step).toBe('code');
    const live = { roomId: 'a', state: 'live', people: 2, title: null, code: null } as const;
    // Сохранённую встречу снова открыли из избранного: в записи «завершена», а она идёт.
    expect(recentStep({ ...entry, closedAt: 5 }, live)).toEqual({ step: 'rejoin', ended: false, live: true });
    expect(recentStep(entry, { ...live, state: 'gone' }).step).toBe('again');
  });

  it('встреча кончилась между опросами — карточка так и говорит и становится «Создать снова»', async () => {
    recordVisit(admission('gone'));
    presence.answers = [{ roomId: 'gone', state: 'live', people: 1, title: 'Встреча gone', code: '1' }];
    room.status = 404;
    const { onJoin, onCreate } = show();
    fireEvent.click(await screen.findByRole('button', { name: 'Вернуться: Встреча gone' }));
    expect(await screen.findByText('Встреча уже закончилась')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Создать снова: Встреча gone' })).toBeInTheDocument();
    expect(listRecent()[0]!.closedAt).toBeTypeOf('number');
    expect(onJoin).not.toHaveBeenCalled();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('пропуск больше не годится (403) — вход по коду, как гость', async () => {
    recordVisit(admission('kicked'));
    room.status = 403;
    const { onJoin } = show();
    fireEvent.click(await screen.findByRole('button', { name: 'Вернуться: Встреча kicked' }));
    await waitFor(() => expect(onJoin).toHaveBeenCalledWith({ kind: 'code', code: '123456789' }));
  });

  it('«…» — в избранное и обратно; пункт знает, что встреча уже там (R162)', async () => {
    recordVisit(admission('fav'));
    const save = vi.spyOn(favoriteApi, 'save').mockImplementation(async () => {
      vi.mocked(favoriteApi.list).mockResolvedValue([saved('fav')]);
    });
    const remove = vi.spyOn(favoriteApi, 'remove').mockImplementation(async () => {
      vi.mocked(favoriteApi.list).mockResolvedValue([]);
    });
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Действия: Встреча fav' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'В избранное' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ roomId: 'fav', credential: 'fav.secret' }));
    expect(await screen.findByText('Встреча в избранном')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Действия: Встреча fav' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Убрать из избранного' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('fav'));
    expect(await screen.findByText('Встреча убрана из избранного')).toBeInTheDocument();
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
