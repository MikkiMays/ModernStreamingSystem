import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GarticTable as Table } from '../api/types';
import type { Meeting } from '../core/meeting';
import { Store } from '../core/store';
import GarticTable from './GarticTable';
import { GamePerson } from './GamePeople';

const player = (memberId: string, name: string, score = 0) => ({
  memberId,
  name,
  score,
  away: false,
  active: true,
  guessed: false,
  submitted: false,
});

function table(patch: Partial<Table> = {}): Table {
  return {
    gameId: 'results-game',
    hostId: 'self',
    mode: 'classic',
    phase: 'finished',
    revision: 1,
    turnToken: 24,
    round: 2,
    rounds: 2,
    turnSeconds: 60,
    step: 5,
    totalSteps: 6,
    drawerId: 'other',
    deadline: 0,
    phaseStartedAt: 10000,
    players: [player('self', 'Анна', 700), player('other', 'Борис', 700), player('gone', 'Вера', 350)],
    you: {
      memberId: 'self',
      playing: true,
      canDraw: false,
      canGuess: false,
      canSubmit: false,
      submitted: false,
      prompt: null,
      choices: [],
      previous: null,
    },
    canvas: [],
    guesses: [],
    answer: null,
    hint: null,
    albums: [],
    revealAlbum: 0,
    revealEntry: 0,
    revealed: null,
    closesAt: 0,
    ...patch,
  };
}

function meeting(value: Table) {
  const participants = [
    { id: 'self', name: 'Анна', status: 'CONNECTED', owner: false },
    { id: 'other', name: 'Борис', status: 'CONNECTED', owner: false },
  ];
  return {
    snapshot: new Store({ gartic: value, participants }),
    admission: { participantId: 'self' },
    control: { state: new Store('connected') },
    media: { tracks: new Store([]), speaking: new Store([]), volumes: new Store({}) },
    command: vi.fn().mockResolvedValue({}),
    serverNow: () => 10000,
  } as unknown as Meeting;
}

function telephone(patch: Partial<Table> = {}) {
  return table({
    mode: 'telephone',
    phase: 'reveal',
    totalSteps: 3,
    albums: [
      { index: 0, ownerId: 'self', ownerName: 'Анна', entries: 3 },
      { index: 1, ownerId: 'other', ownerName: 'Борис', entries: 3 },
    ],
    revealed: {
      authorId: 'gone',
      authorName: 'Вера',
      kind: 'text',
      text: 'Кот на Луне',
      strokes: [],
      skipped: false,
      step: 0,
    },
    ...patch,
  });
}

afterEach(() => cleanup());

describe('Gartic results with real participant identities', () => {
  it('gives tied scores the same rank and keeps a departed player’s recorded name', () => {
    render(<GarticTable meeting={meeting(table())} />);
    expect(screen.getByRole('heading', { name: 'Ничья на первом месте' })).toBeVisible();
    const ranking = screen.getByRole('list', { name: 'Итоговый счёт' });
    const rows = within(ranking).getAllByRole('listitem');
    expect(within(rows[0]!).getByLabelText('Место 1')).toBeVisible();
    expect(within(rows[1]!).getByLabelText('Место 1')).toBeVisible();
    expect(within(rows[2]!).getByLabelText('Место 3')).toBeVisible();
    expect(within(rows[2]!).getByText('Вера')).toBeVisible();
    expect(within(ranking).queryByText('Рисует')).not.toBeInTheDocument();
    expect(within(ranking).queryByText('Свободное место')).not.toBeInTheDocument();
  });

  it('does not announce a winner when every score is zero', () => {
    render(
      <GarticTable
        meeting={meeting(table({ players: [player('self', 'Анна'), player('other', 'Борис')] }))}
      />,
    );
    expect(screen.getByRole('heading', { name: 'В этот раз без очков' })).toBeVisible();
    expect(screen.queryByText('Ничья на первом месте')).not.toBeInTheDocument();
  });

  it('expands a player’s actual distance to first place without invented performance metrics', () => {
    render(<GarticTable meeting={meeting(table())} />);
    const details = screen.getByRole('button', { name: 'Подробности: Вера' });
    expect(details).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(details);
    const panel = document.getElementById(details.getAttribute('aria-controls')!)!;
    expect(details).toHaveAttribute('aria-expanded', 'true');
    expect(within(panel).getByText('До первого места')).toBeVisible();
    expect(within(panel).getByText('350 очков')).toBeVisible();
    fireEvent.click(details);
    expect(details).toHaveAttribute('aria-expanded', 'false');
  });

  it('retains the game status while a participant is speaking', () => {
    const client = meeting(table());
    client.media.speaking.set(['self']);
    render(<GamePerson meeting={client} memberId="self" label="Рисует" />);
    expect(screen.getByText('Рисует')).toBeVisible();
  });

  it('describes word selection accurately and gives a disconnected drawer the connection status', () => {
    const client = meeting(table({ phase: 'choosing' }));
    render(<GarticTable meeting={client} />);
    const roster = screen.getByRole('list', { name: 'Счёт игроков' });
    expect(within(roster).getByText('Выбирает слово')).toBeVisible();
    act(() =>
      client.snapshot.update((snapshot) => ({
        ...snapshot,
        gartic: {
          ...snapshot.gartic!,
          players: snapshot.gartic!.players.map((person) => ({
            ...person,
            away: person.memberId === 'other',
          })),
        },
      })),
    );
    expect(within(roster).getByText('Нет связи')).toBeVisible();
    expect(within(roster).queryByText('Выбирает слово')).not.toBeInTheDocument();
  });
});

describe('Shared telephone reveal', () => {
  it('moves to the next album from its final entry using the authoritative phase token', async () => {
    const client = meeting(telephone({ revealEntry: 2 }));
    render(<GarticTable meeting={client} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Следующая история' })));
    expect(client.command).toHaveBeenCalledWith('gartic.reveal', undefined, undefined, {
      contentId: 'results-game',
      positionMs: 24,
      chips: 1,
      seat: 0,
    });
  });

  it('returns to the last entry of the previous album and allows explicit numbered navigation', async () => {
    const client = meeting(telephone({ revealAlbum: 1 }));
    render(<GarticTable meeting={client} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Предыдущий шаг' })));
    expect(client.command).toHaveBeenLastCalledWith('gartic.reveal', undefined, undefined, {
      contentId: 'results-game',
      positionMs: 24,
      chips: 0,
      seat: 2,
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Показать шаг 3' })));
    expect(client.command).toHaveBeenLastCalledWith('gartic.reveal', undefined, undefined, {
      contentId: 'results-game',
      positionMs: 24,
      chips: 1,
      seat: 2,
    });
  });

  it('explains a skipped drawing instead of showing an empty drawing as a completed picture', () => {
    const client = meeting(
      telephone({
        revealed: {
          authorId: 'gone',
          authorName: 'Вера',
          kind: 'drawing',
          text: null,
          strokes: [],
          skipped: true,
          step: 1,
        },
      }),
    );
    render(<GarticTable meeting={client} />);
    expect(screen.getByText('Этот шаг пропущен')).toBeVisible();
    expect(screen.getByText('Вера')).toBeVisible();
    expect(screen.queryByRole('img', { name: 'Рисунок: Вера' })).not.toBeInTheDocument();
  });

  it('gives spectators readable progress without shared navigation actions', () => {
    const client = meeting(telephone({ hostId: 'other', you: null }));
    render(<GarticTable meeting={client} />);
    expect(screen.getByText('Ведущий листает истории для всех')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: /Показать шаг|Следующий шаг|Следующая история/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Кот на Луне')).toBeVisible();
  });

  it('scopes keyboard navigation to the reveal controls and ignores modified arrow shortcuts', async () => {
    const client = meeting(telephone());
    render(<GarticTable meeting={client} />);
    const navigation = screen.getByRole('navigation', { name: 'Листать историю' });
    fireEvent.keyDown(navigation, { key: 'ArrowRight', altKey: true });
    expect(client.command).not.toHaveBeenCalled();
    await act(async () => fireEvent.keyDown(navigation, { key: 'ArrowRight' }));
    expect(client.command).toHaveBeenCalledWith('gartic.reveal', undefined, undefined, {
      contentId: 'results-game',
      positionMs: 24,
      chips: 0,
      seat: 1,
    });
  });

  it('keeps absent reveal content neutral with navigation disabled', () => {
    render(<GarticTable meeting={meeting(telephone({ revealed: null }))} />);
    expect(screen.getByRole('button', { name: 'Следующий шаг' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Показать шаг 2' })).toBeDisabled();
    expect(screen.getByText('Ждём обновления игры.')).toBeVisible();
    expect(screen.queryByRole('img', { name: /Рисунок:/ })).not.toBeInTheDocument();
  });

  it('retains the revealed content and prevents duplicate navigation while the command is pending', async () => {
    const client = meeting(telephone());
    let reject!: (error: Error) => void;
    vi.mocked(client.command).mockImplementation(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    render(<GarticTable meeting={client} />);
    fireEvent.click(screen.getByRole('button', { name: 'Следующий шаг' }));
    expect(screen.getByRole('button', { name: 'Следующий шаг' })).toBeDisabled();
    expect(screen.getByText('Кот на Луне')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Показать шаг 3' }));
    expect(client.command).toHaveBeenCalledTimes(1);
    await act(async () => reject(new Error('Не удалось открыть шаг')));
    expect(screen.getByRole('alert')).toHaveTextContent('Не удалось открыть шаг');
    expect(screen.getByRole('button', { name: 'Следующий шаг' })).toBeEnabled();
  });
});
