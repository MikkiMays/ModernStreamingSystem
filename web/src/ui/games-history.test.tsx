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
