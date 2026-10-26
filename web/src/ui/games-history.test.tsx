import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Meeting } from '../core/meeting';
import { Store } from '../core/store';
import { GamesGroup } from './GamesGroup';
afterEach(cleanup);
it('does not request history until the dialog opens and reports an empty history', async () => {
  const games = vi.fn().mockResolvedValue([]),
    durakGames = vi.fn().mockResolvedValue([]);
  const meeting = {
    snapshot: new Store({ participants: [], poker: null, durak: null }),
    viewing: new Store(null),
    cinema: new Store(null),
    stageAway: new Store(null),
    admission: { participantId: 'self', roomId: 'room' },
    api: { games, durakGames },
  } as unknown as Meeting;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <GamesGroup meeting={meeting} onBack={() => {}} />
    </QueryClientProvider>,
  );
  expect(games).not.toHaveBeenCalled();
  expect(durakGames).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'История игр' })));
  expect(await screen.findByRole('dialog', { name: 'История игр' })).toBeVisible();
  expect(games).toHaveBeenCalledTimes(1);
  expect(durakGames).toHaveBeenCalledTimes(1);
  expect(await screen.findAllByText('Сыгранных партий пока нет.')).toHaveLength(2);
  client.clear();
});
it('names the fool of every durak game and never a draw, even for a record saved before R111', async () => {
  const record = (number: number, foolName: string, extra: object = {}) => ({
    id: `g:${number}`,
    mode: 'podkidnoy',
    modeName: 'Подкидной',
    deckSize: 36,
    startedAt: 1,
    finishedAt: 2,
    number,
    bouts: 5,
    foolName,
    places: [],
    players: [],
    highlights: [],
    ...extra,
  });
  const durakGames = vi.fn().mockResolvedValue([record(1, '', { draw: true }), record(2, 'Игрок 1')]);
  const meeting = {
    snapshot: new Store({ participants: [], poker: null, durak: null }),
    viewing: new Store(null),
    cinema: new Store(null),
    stageAway: new Store(null),
    admission: { participantId: 'self', roomId: 'room' },
    api: { games: vi.fn().mockResolvedValue([]), durakGames },
  } as unknown as Meeting;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <GamesGroup meeting={meeting} onBack={() => {}} />
    </QueryClientProvider>,
  );
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'История игр' })));
  const second = await screen.findByRole('button', { name: /Партия 2/ });
  expect(second).toHaveTextContent('дурак — Игрок 1 · 5 боёв · подкидной');
  const first = screen.getByRole('button', { name: /Партия 1/ });
  expect(first).toHaveTextContent('5 боёв · подкидной');
  expect(first).not.toHaveTextContent(/ничья|дурак —/);
  client.clear();
});

/*
  R121: открыть идущую игру из панели, когда ушёл к участникам, — значит вернуться к столу. Кнопка видна
  сразу, без раскрытия строки игры; пока стол на сцене перед глазами, её нет.
*/
it('ушёл от стола к участникам — «Открыть на сцене» возвращает; у стола на сцене кнопки нет', () => {
  const stageAway = new Store<'durak' | null>(null);
  const meeting = {
    snapshot: new Store({
      participants: [],
      poker: null,
      durak: { seats: [{ index: 0, memberId: 'self' }], score: [], phase: 'lobby' },
    }),
    viewing: new Store(null),
    cinema: new Store(null),
    stageAway,
    admission: { participantId: 'self', roomId: 'room' },
    api: { games: vi.fn(), durakGames: vi.fn() },
    returnToStage: vi.fn(() => stageAway.set(null)),
  } as unknown as Meeting & { returnToStage: ReturnType<typeof vi.fn> };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <GamesGroup meeting={meeting} onBack={() => {}} />
    </QueryClientProvider>,
  );
  expect(screen.queryByRole('button', { name: 'Открыть на сцене' })).toBeNull();
  act(() => stageAway.set('durak'));
  fireEvent.click(screen.getByRole('button', { name: 'Открыть на сцене' }));
  expect(meeting.returnToStage).toHaveBeenCalledTimes(1);
  client.clear();
});
