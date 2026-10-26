import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { PokerSeat, PokerTable } from '../api/types';
import type { Meeting } from '../core/meeting';
import { Store } from '../core/store';
import { VoiceLevels } from '../media/levels';
import PokerScene, { Slide } from './PokerTable';
import { StageExitContext } from './stage-context';
vi.mock('../core/sounds', () => ({
  signal: vi.fn(),
  ensureNotificationAudio: vi.fn(),
  notificationAudio: () => undefined,
  soundVolume: () => 1,
}));
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    disconnect() {}
  },
);
afterEach(cleanup);
function seat(index: number, patch: Partial<PokerSeat> = {}): PokerSeat {
  return {
    index,
    memberId: `p${index}`,
    name: `Игрок ${index}`,
    stack: 5000,
    bet: 0,
    committed: 0,
    buyIn: 5000,
    cards: [],
    held: 0,
    revealed: false,
    inHand: false,
    folded: false,
    allIn: false,
    waiting: false,
    away: false,
    leaving: false,
    busted: false,
    place: 0,
    lastAction: '',
    lastActionAmount: 0,
    wonAmount: 0,
    handName: '',
    handCards: [],
    timeBankMs: 60000,
    ...patch,
  };
}

function table(patch: Partial<PokerTable> = {}): PokerTable {
  return {
    mode: 'friendly',
    modeName: 'Дружеская игра',
    phase: 'preflop',
    hostId: 'p0',
    handNumber: 1,
    revision: 1,
    button: 0,
    smallBlind: 25,
    bigBlind: 50,
    ante: 0,
    level: 1,
    levelUpAt: 0,
    turnSeconds: 45,
    seatingOpen: true,
    autoDeal: true,
    awaiting: false,
    paused: false,
    rebuy: true,
    rebuyLimit: -1,
    rebuyChips: 5000,
    startingStack: 5000,
    pot: 0,
    betToCall: 50,
    actor: 0,
    actionAt: 1000,
    deadline: 46000,
    streetAt: 1000,
    handStartedAt: 1000,
    board: [],
    seats: Array.from({ length: 10 }, (_, index) =>
      seat(index, { memberId: index < 3 ? `p${index}` : null }),
    ),
    pots: [],
    log: [],
    result: null,
    you: null,
    commitment: '',
    seed: '',
    closesAt: 0,
    summary: null,
    ...patch,
  };
}

function room(participantId = 'spectator') {
  const tracks = new Store([]);
  const speaking = new Store<string[]>([]);
  return {
    admission: { participantId, roomId: 'room' },
    snapshot: new Store({ participants: [] }),
    media: { tracks, preferences: new Store({}), speaking, levels: new VoiceLevels(tracks, speaking) },
    control: { state: new Store('connected') },
    serverNow: () => 10000,
    command: vi.fn().mockResolvedValue(undefined),
  } as unknown as Meeting;
}

it('asks the server for a seat instead of choosing one from a stale snapshot', () => {
  const meeting = room();
  render(<PokerScene meeting={meeting} table={table({ phase: 'lobby' })} />);
  fireEvent.click(screen.getByRole('button', { name: 'Сесть за стол' }));
  expect(meeting.command).toHaveBeenCalledWith('poker.sit', undefined, undefined, undefined);
});

/** R45: у не севшего под столом только «Сесть за стол» — серой строки подсказок нет совсем. */
it('gives a spectator no hint row under the table, only the seat button', () => {
  const { container } = render(
    <PokerScene meeting={room()} table={table({ phase: 'lobby', seed: 'revealed' })} />,
  );
  expect(container.querySelector('.poker-controls')).toBeNull();
  expect(screen.queryByText('Сядьте за стол, чтобы играть')).toBeNull();
  expect(screen.queryByText('Раздать можно, когда за столом двое')).toBeNull();
  expect(screen.getByRole('button', { name: 'Сесть за стол' })).toBeVisible();
});

/** R46 + R27: состояние стола — в шапке, а не плашками на сукне. */
it('says the table state in the bar and puts nothing on the felt between hands', () => {
  const lone = table({
    phase: 'lobby',
    hostId: 'p0',
    closesAt: 0,
    seats: Array.from({ length: 10 }, (_, index) => seat(index, { memberId: index < 1 ? 'p0' : null })),
  });
  const { container, rerender } = render(<PokerScene meeting={room('p0')} table={lone} />);
  const status = container.querySelector<HTMLElement>('.poker-bar [data-table-status]')!;
  expect(status).toHaveAttribute('data-table-status', 'waiting');
  expect(status).toHaveTextContent('Ждём игроков · 1 из 2');
  expect(container.querySelector('.poker-felt .poker-waiting')).toBeNull();
  const deal = screen.getByRole('button', { name: 'Раздать' });
  expect(deal).toBeDisabled();
  expect(deal).toHaveAttribute('title', 'Раздать можно, когда за столом двое');
  expect(deal).toHaveAccessibleDescription('Ждём игроков · 1 из 2');
  rerender(<PokerScene meeting={room('p0')} table={{ ...lone, closesAt: 490000 }} />);
  const closing = container.querySelector<HTMLElement>('.poker-bar [data-table-status]')!;
  expect(closing).toHaveAttribute('data-table-status', 'closing');
  expect(closing).toHaveTextContent('Стол закроется через 8 мин');
  expect(container.querySelector('.poker-linger')).toBeNull();
  rerender(<PokerScene meeting={room('p0')} table={table({ phase: 'lobby', deadline: 0 })} />);
  expect(container.querySelector('[data-table-status]')).toHaveTextContent('Можно раздавать');
  rerender(<PokerScene meeting={room('p1')} table={table({ phase: 'lobby', deadline: 0 })} />);
  expect(container.querySelector('[data-table-status]')).toHaveTextContent('Ждём раздающего');
  rerender(<PokerScene meeting={room('p1')} table={table({ phase: 'lobby', deadline: 15000 })} />);
  expect(container.querySelector('[data-table-status]')).toHaveTextContent('Раздаём через 5 с');
});

/** Проверка честности раздачи — не под столом, а в «Настройках игры», у всех, кто смотрит. */
it('offers the fairness check inside the game settings', () => {
  const { container } = render(
    <PokerScene meeting={room()} table={table({ phase: 'lobby', seed: 'revealed' })} />,
  );
  expect(screen.queryByRole('button', { name: /Проверить раздачу/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Настройки игры' }));
  const sheet = container.querySelector<HTMLElement>('.poker-sheet')!;
  expect(within(sheet).getByRole('button', { name: /Проверить раздачу/ })).toBeVisible();
});

/** R110: кольцо хода у покера то же, что у дурака, — от меток ядра. */
it('winds the shared turn ring around the acting seat from the server clock', () => {
  const { container } = render(<PokerScene meeting={room()} table={table({ actor: 1 })} />);
  const ring = container.querySelector<HTMLElement>('[data-game-seat="1"] .turn-ring .turn-ring-run')!;
  expect(ring.style.animationDuration).toBe('45000ms');
  expect(ring.style.animationDelay).toBe('-9000ms');
  expect(container.querySelectorAll('.turn-ring')).toHaveLength(1);
});

it('keeps a rebuy drag active when the moving knob leaves the track', () => {
  const confirm = vi.fn();
  const view = render(<Slide label="Взять 400" onConfirm={confirm} />);
  const track = view.container.querySelector<HTMLElement>('.poker-slide')!;
  const knob = view.getByRole('button', { name: 'Взять 400' });
  vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
    bottom: 52,
    height: 52,
    left: 0,
    right: 200,
    top: 0,
    width: 200,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  Object.assign(track, { setPointerCapture: vi.fn(), hasPointerCapture: vi.fn(() => false) });

  fireEvent.pointerDown(knob, { button: 0, buttons: 1, pointerId: 1, isPrimary: true });
  fireEvent.pointerMove(track, { buttons: 1, clientX: 100, pointerId: 1 });
  fireEvent.pointerLeave(track, { buttons: 1, pointerId: 1 });

  expect(track).not.toHaveAttribute('data-done');
  expect(knob).toHaveStyle({ left: 'calc(50.0% - 24.0px)' });
  fireEvent.pointerMove(track, { buttons: 1, clientX: 196, pointerId: 1 });
  expect(confirm).toHaveBeenCalledOnce();
});

/*
  R121: ушедший к участникам видит сетку, а стол идёт спрятанным. Клавиша «F», нажатая над сеткой, — не
  пас: пока стол спрятан, его клавиши молчат; вернулся — снова работают.
*/
it('keeps the poker keys quiet while the player is away with the participants', () => {
  const meeting = room('p0');
  const turn = table({
    you: {
      seat: 0,
      turn: true,
      actions: ['fold', 'call', 'raise'],
      cards: ['As', 'Kd'],
      hand: '',
      callAmount: 50,
      minRaiseTo: 100,
      maxRaiseTo: 5000,
      rebuy: 0,
      rebuysLeft: 0,
      timeBankMs: 60000,
    },
    seats: Array.from({ length: 10 }, (_, index) =>
      seat(index, { memberId: index < 3 ? `p${index}` : null, inHand: index < 3 }),
    ),
  });
  const view = render(
    <StageExitContext.Provider value={{ away: true, leave: null }}>
      <PokerScene meeting={meeting} table={turn} />
    </StageExitContext.Provider>,
  );
  fireEvent.keyDown(document.body, { key: 'f' });
  expect(meeting.command).not.toHaveBeenCalled();
  view.rerender(
    <StageExitContext.Provider value={{ away: false, leave: null }}>
      <PokerScene meeting={meeting} table={turn} />
    </StageExitContext.Provider>,
  );
  fireEvent.keyDown(document.body, { key: 'f' });
  expect(meeting.command).toHaveBeenCalledWith('poker.act', undefined, undefined, {
    option: 'fold',
    chips: undefined,
  });
});
