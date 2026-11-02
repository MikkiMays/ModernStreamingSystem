import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Meeting } from '../core/meeting';
import { readPreferences, type Preferences } from '../core/preferences';
import { Store } from '../core/store';
import { ApiError } from '../api/client';
import { Services } from './Services';

/*
  Доска из «Интеграций» (R164, владелец 01.11.2026: «при нажатии на whiteboard нужно подтверждение как и
  у других интеграций»): карточка ведёт на шаг «Добавить во встречу» — тот же, что у музыки, — и только
  кнопка там открывает доску у всех. «Интеграции» над шагом — отказ. Открытая доска карточкой не
  спрашивается: нажатие возвращает к ней на сцену.
*/

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

/** Служба музыки молчит — витрине она не нужна. */
function serve() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 404 })),
  );
}

function meetingWith(can: string[]) {
  const snapshot = new Store({
    participants: [{ id: 'self', owner: true, status: 'CONNECTED' }],
    integrationsAllowed: true,
    you: { can },
    watch: null,
    poker: null,
    durak: null,
    chess: null,
    gartic: null,
    board: null as object | null,
  });
  /** Доска на сцене — так её видит снимок, кто бы её ни открыл. */
  const bringBoard = () => snapshot.set({ ...snapshot.get(), board: { drawers: 'all' } });
  const command = vi.fn(async (type: string) => {
    if (type === 'board.open') bringBoard();
  });
  const meeting = {
    admission: { roomId: 'room', participantId: 'self', credential: 'token' },
    snapshot,
    ended: new Store<string | null>(null),
    media: {
      preferences: new Store<Preferences>(readPreferences()),
      saveSettings: vi.fn(),
      volumes: new Store({}),
      setVolume: vi.fn(),
      musicPlayoutMs: () => 0,
    },
    refresh: vi.fn(async () => {}),
    command,
    bringBoard,
  };
  return meeting as unknown as Meeting & { command: typeof command; bringBoard: () => void };
}

function mount(meeting: Meeting) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Services meeting={meeting} />
    </QueryClientProvider>,
  );
}

const card = () => screen.getByRole('button', { name: /^Доска рисования/ });

describe('доска из «Интеграций» (R164)', () => {
  it('карточка сама доску не открывает — сначала шаг «Добавить во встречу», как у музыки', async () => {
    serve();
    const meeting = meetingWith(['board.open']);
    mount(meeting);
    fireEvent.click(card());
    expect(meeting.command).not.toHaveBeenCalled();
    const step = screen.getByRole('region', { name: 'Доска рисования' });
    expect(step).toHaveClass('integration-intro');
    expect(step).toHaveTextContent(
      'Общий холст на всю встречу: рисуют все сразу. Откроется на сцене у каждого.',
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Добавить во встречу' }));
    });
    expect(meeting.command).toHaveBeenCalledWith('board.open');
    // Доска на сцене — панель снова витрина, карточка говорит, что доска открыта.
    await waitFor(() => expect(card()).toHaveTextContent('Доска открыта'));
  });

  it('«Интеграции» над шагом — отказ: ничего не открылось', () => {
    serve();
    const meeting = meetingWith(['board.open']);
    mount(meeting);
    fireEvent.click(card());
    fireEvent.click(screen.getByRole('button', { name: 'Интеграции' }));
    expect(card()).toBeInTheDocument();
    expect(meeting.command).not.toHaveBeenCalled();
  });

  it('добавлять нельзя — шаг без кнопки, со строкой почему', () => {
    serve();
    mount(meetingWith([]));
    fireEvent.click(card());
    expect(screen.queryByRole('button', { name: 'Добавить во встречу' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Доска рисования' })).toHaveTextContent(
      'Добавлять интеграции организатор разрешил только себе.',
    );
  });

  it('отказ ядра — строкой на шаге, шаг остаётся', async () => {
    serve();
    const meeting = meetingWith(['board.open']);
    meeting.command.mockRejectedValueOnce(
      new ApiError(409, 'INTEGRATION_BUSY', 'Сейчас активна другая интеграция'),
    );
    mount(meeting);
    fireEvent.click(card());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Добавить во встречу' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Сейчас активна другая интеграция');
    expect(screen.getByRole('button', { name: 'Добавить во встречу' })).toBeInTheDocument();
  });

  it('доску открыл кто-то другой, пока шаг открыт, — назад к витрине', async () => {
    serve();
    const meeting = meetingWith(['board.open']);
    mount(meeting);
    fireEvent.click(card());
    act(() => meeting.bringBoard());
    await waitFor(() => expect(card()).toHaveTextContent('Доска открыта'));
    expect(screen.queryByRole('button', { name: 'Добавить во встречу' })).toBeNull();
  });
});
