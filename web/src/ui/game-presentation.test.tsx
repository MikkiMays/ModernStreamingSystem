import { act, render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Meeting } from '../core/meeting';
import { Store } from '../core/store';
import { CardMotion, GameTurn } from './GamePresentation';
import { occupiedSeatLayout } from '../core/game-layout';
import type { GameVisualEvent } from '../api/types';

const state = new Store<'connected' | 'recovering'>('connected');
let now = 10000;
const meeting = { control: { state }, serverNow: () => now } as unknown as Meeting;
const spots = occupiedSeatLayout([0, 3], 0);
const event = (id: number, type: GameVisualEvent['type'] = 'deal'): GameVisualEvent => ({
  id,
  at: now,
  type,
  fromSeat: null,
  toSeat: 3,
  count: 1,
  cards: [],
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  now = 10000;
  state.set('connected');
});
describe('authoritative card motion', () => {
  it('does not replay first snapshot, duplicate IDs, or recovery history', () => {
    const { container, rerender } = render(
      <CardMotion meeting={meeting} events={[event(1)]} spots={spots} />,
    );
    expect(container.querySelectorAll('.game-card-flight')).toHaveLength(0);
    rerender(<CardMotion meeting={meeting} events={[event(1), event(2)]} spots={spots} />);
    expect(container.querySelectorAll('.game-card-flight')).toHaveLength(1);
    expect(container.querySelector('.game-card-flight')).toHaveAttribute('data-back', 'true');
    rerender(<CardMotion meeting={meeting} events={[event(1), event(2)]} spots={spots} />);
    expect(container.querySelectorAll('.game-card-flight')).toHaveLength(1);
    act(() => state.set('recovering'));
    act(() => state.set('connected'));
    rerender(<CardMotion meeting={meeting} events={[event(3)]} spots={spots} />);
    expect(container.querySelectorAll('.game-card-flight')).toHaveLength(0);
    rerender(<CardMotion meeting={meeting} events={[event(3), event(4, 'draw')]} spots={spots} />);
    expect(container.querySelectorAll('.game-card-flight')).toHaveLength(1);
  });
  it('renders only public faces and clears after motion', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<CardMotion meeting={meeting} events={[]} spots={spots} />);
    rerender(
      <CardMotion
        meeting={meeting}
        events={[{ ...event(1, 'play'), fromSeat: 3, toSeat: null, cards: ['Ah'] }]}
        spots={spots}
      />,
    );
    expect(container.querySelector('.game-card-flight')).toHaveTextContent('Т♥');
    act(() => vi.advanceTimersByTime(2400));
    expect(container.querySelectorAll('.game-card-flight')).toHaveLength(0);
  });
  it('uses the server clock for the visible countdown', () => {
    vi.useFakeTimers();
    render(<GameTurn meeting={meeting} deadline={15000} active label="Ваш ход" />);
    expect(screen.getByLabelText('Осталось 5 секунд')).toBeVisible();
    now = 12000;
    act(() => vi.advanceTimersByTime(250));
    expect(screen.getByLabelText('Осталось 3 секунд')).toBeVisible();
  });
});

it('suppresses event motion when reduced motion is requested', () => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
  const { container, rerender } = render(<CardMotion meeting={meeting} events={[]} spots={spots} />);
  rerender(<CardMotion meeting={meeting} events={[event(1)]} spots={spots} />);
  expect(container.querySelectorAll('.game-card-flight')).toHaveLength(0);
  vi.unstubAllGlobals();
});

it('freezes a flight delay when an unrelated snapshot arrives', () => {
  const { container, rerender } = render(<CardMotion meeting={meeting} events={[]} spots={spots} />);
  const first = event(1);
  rerender(<CardMotion meeting={meeting} events={[first]} spots={spots} />);
  const before = (container.querySelector('.game-card-flight') as HTMLElement).style.animationDelay;
  now += 180;
  rerender(<CardMotion meeting={meeting} events={[first]} spots={spots} />);
  expect((container.querySelector('.game-card-flight') as HTMLElement).style.animationDelay).toBe(before);
});
