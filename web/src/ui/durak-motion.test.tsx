import { useRef } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurakTable, GameVisualEvent } from '../api/types';
import type { Meeting } from '../core/meeting';
import { Store } from '../core/store';
import { useDurakMotion } from './DurakMotion';

const connection = new Store<'connected' | 'recovering'>('connected');
const meeting = { control: { state: connection }, serverNow: () => 10_000 } as unknown as Meeting;
const animations: {
  onfinish: (() => void) | null;
  oncancel: (() => void) | null;
  cancel: ReturnType<typeof vi.fn>;
}[] = [];
const animate = vi.fn(function (this: HTMLElement) {
  const animation = { onfinish: null, oncancel: null, cancel: vi.fn() };
  animations.push(animation);
  return animation as unknown as Animation;
});
const event = (id: number, card = '8h', fromSeat = 0): GameVisualEvent => ({
  id,
  at: 10_000,
  type: 'play',
  fromSeat,
  toSeat: null,
  count: 1,
  cards: [card],
});
const snapshot = (cards: string[] = [], events: GameVisualEvent[] = [], handNumber = 1) =>
  ({
    phase: 'bout',
    handNumber,
    table: cards.map((attack) => ({ attack, beat: null })),
    visualEvents: events,
    you: { seat: 0 },
  }) as unknown as DurakTable;

function Fixture({
  table,
  paused = false,
  replaceBoard = false,
}: {
  table: DurakTable;
  paused?: boolean;
  replaceBoard?: boolean;
}) {
  const scene = useRef<HTMLDivElement>(null);
  const motion = useDurakMotion({ meeting, table, scene, paused });
  return (
    <div ref={scene} className="durak">
      <div className="durak-table">
        <div data-game-seat="3" />
        <button
          data-source="true"
          style={{ width: 100, height: 140, rotate: '-5deg' }}
          onClick={(e) => motion.capture('8h', e.currentTarget)}
        >
          Capture
        </button>
        <button
          onClick={() => motion.capture('8h', { left: 320, top: 200, width: 100, height: 140, angle: 9 })}
        >
          Release
        </button>
        <button onClick={() => motion.reject('8h')}>Reject</button>
        {table.table.map(({ attack }) => (
          <span key={`${attack}-${replaceBoard}`} style={{ rotate: '7deg' }}>
            <span data-durak-board-card={attack} className="durak-card" style={{ width: 80, height: 112 }}>
              {attack}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  animate.mockClear();
  animations.length = 0;
  connection.set('connected');
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const shape = this.dataset.source
      ? [50, 500, 100, 140]
      : this.dataset.gameSeat
        ? [400, 50, 48, 48]
        : this.dataset.durakBoardCard
          ? [300, 150, 80, 112]
          : [0, 0, 800, 700];
    const [x, y, width, height] = shape as [number, number, number, number];
    return { x, y, left: x, top: y, width, height, right: x + width, bottom: y + height, toJSON: () => ({}) };
  });
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
});

describe('confirmed Durak throws', () => {
  it('flies from the actual hand rectangle to the actual rotated board card and restores it once', () => {
    const { container, rerender } = render(<Fixture table={snapshot()} />);
    fireEvent.click(screen.getByText('Capture'));
    expect(animate).not.toHaveBeenCalled();
    const confirmed = snapshot(['8h'], [event(1)]);
    rerender(<Fixture table={confirmed} />);
    expect(animate).toHaveBeenCalledTimes(1);
    const [frames, options] = animate.mock.calls[0]! as unknown as [Keyframe[], KeyframeAnimationOptions];
    expect(frames[0]?.transform).toBe('translate3d(-240px, 364px, 0) rotate(-5deg) scale(1.25, 1.25)');
    expect(frames.at(-1)?.transform).toBe('translate3d(0px, 0px, 0) rotate(7deg) scale(1, 1)');
    expect(options.duration).toBeLessThanOrEqual(360);
    const target = container.querySelector<HTMLElement>('[data-durak-board-card]')!;
    expect(target.style.visibility).toBe('hidden');
    expect(container.querySelectorAll('[data-durak-board-card]')).toHaveLength(1);
    expect(container.querySelector('.durak-motion-layer')).toHaveAttribute('aria-hidden', 'true');
    rerender(<Fixture table={{ ...confirmed }} />);
    expect(animate).toHaveBeenCalledTimes(1);
    act(() => animations[0]!.onfinish?.());
    expect(target.style.visibility).toBe('');
    expect(container.querySelector('.durak-motion-layer')).toBeNull();
    expect(animations[0]!.cancel).toHaveBeenCalledTimes(1);
  });

  it('uses the drag release rectangle instead of returning to the hand before throwing', () => {
    const { rerender } = render(<Fixture table={snapshot()} />);
    fireEvent.click(screen.getByText('Release'));
    rerender(<Fixture table={snapshot(['8h'], [event(1)])} />);
    const [frames] = animate.mock.calls[0]! as unknown as [Keyframe[]];
    expect(frames[0]?.transform).toBe('translate3d(30px, 64px, 0) rotate(9deg) scale(1.25, 1.25)');
  });

  it.each(['replacement', 'reflow'])('settles a target before a %s is painted', (change) => {
    const { container, rerender } = render(<Fixture table={snapshot()} />);
    const confirmed = snapshot(['8h'], [event(1, '8h', 3)]);
    rerender(<Fixture table={confirmed} />);
    const target = container.querySelector<HTMLElement>('[data-durak-board-card]')!;
    expect(target.style.visibility).toBe('hidden');
    if (change === 'reflow') {
      const box = target.getBoundingClientRect();
      vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ ...box, left: box.left + 60 });
    }
    rerender(<Fixture table={confirmed} replaceBoard={change === 'replacement'} />);
    expect(container.querySelector('.durak-motion-layer')).toBeNull();
    expect(container.querySelector<HTMLElement>('[data-durak-board-card]')!.style.visibility).toBe('');
    expect(animate).toHaveBeenCalledTimes(1);
  });

  it('leaves rejected and uncaptured local moves authoritative without a ghost flight', () => {
    const { container, rerender } = render(<Fixture table={snapshot()} />);
    fireEvent.click(screen.getByText('Capture'));
    fireEvent.click(screen.getByText('Reject'));
    rerender(<Fixture table={snapshot(['8h'], [event(1)])} />);
    expect(animate).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLElement>('[data-durak-board-card]')!.style.visibility).toBe('');
  });

  it('starts remote play at its seat and ignores dealing and events without a new board card', () => {
    const { rerender } = render(<Fixture table={snapshot()} />);
    rerender(<Fixture table={snapshot([], [{ ...event(1, '8h', 3), type: 'deal' }, event(2, '9h', 3)])} />);
    expect(animate).not.toHaveBeenCalled();
    rerender(<Fixture table={snapshot(['8h'], [event(3, '8h', 3)])} />);
    expect(animate).toHaveBeenCalledTimes(1);
    const [frames] = animate.mock.calls[0]! as unknown as [Keyframe[]];
    expect(frames[0]?.transform).toContain('translate3d(84px, -132px, 0)');
  });

  it('baselines first snapshots, recovery snapshots, old events and a new deal', () => {
    const initial = snapshot(['8h'], [event(1, '8h', 3)]);
    const { rerender } = render(<Fixture table={initial} />);
    expect(animate).not.toHaveBeenCalled();
    act(() => connection.set('recovering'));
    act(() => connection.set('connected'));
    rerender(<Fixture table={snapshot(['8h', '9h'], [event(2, '9h', 3)])} />);
    expect(animate).not.toHaveBeenCalled();
    rerender(<Fixture table={snapshot(['8h', '9h', 'Th'], [{ ...event(3, 'Th', 3), at: 1000 }])} />);
    expect(animate).not.toHaveBeenCalled();
    rerender(<Fixture table={snapshot(['Jh'], [event(4, 'Jh', 3)], 2)} />);
    expect(animate).not.toHaveBeenCalled();
    rerender(<Fixture table={snapshot(['Jh', 'Qh'], [event(5, 'Qh', 3)], 2)} />);
    expect(animate).toHaveBeenCalledTimes(1);
  });

  it.each(['pause', 'disconnect', 'resize', 'scroll', 'hidden', 'unmount'])(
    'restores the authoritative card and cancels the overlay on %s',
    (reason) => {
      const { container, rerender, unmount } = render(<Fixture table={snapshot()} />);
      const confirmed = snapshot(['8h'], [event(1, '8h', 3)]);
      rerender(<Fixture table={confirmed} />);
      const target = container.querySelector<HTMLElement>('[data-durak-board-card]')!;
      expect(target.style.visibility).toBe('hidden');
      if (reason === 'pause') rerender(<Fixture table={confirmed} paused />);
      else if (reason === 'disconnect') act(() => connection.set('recovering'));
      else if (reason === 'unmount') unmount();
      else if (reason === 'hidden') {
        vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
        fireEvent(document, new Event('visibilitychange'));
      } else fireEvent(window, new Event(reason));
      expect(target.style.visibility).toBe('');
      expect(container.querySelector('.durak-motion-layer')).toBeNull();
      expect(animations[0]!.cancel).toHaveBeenCalledTimes(1);
      act(() => vi.advanceTimersByTime(1000));
      expect(animations[0]!.cancel).toHaveBeenCalledTimes(1);
    },
  );

  it('cleans up on timeout even if the browser never emits animation finish', () => {
    const { container, rerender } = render(<Fixture table={snapshot()} />);
    rerender(<Fixture table={snapshot(['8h'], [event(1, '8h', 3)])} />);
    act(() => vi.advanceTimersByTime(500));
    expect(container.querySelector('.durak-motion-layer')).toBeNull();
    expect(container.querySelector<HTMLElement>('[data-durak-board-card]')!.style.visibility).toBe('');
  });

  it('does not replay a snapshot received after updates continued in a hidden tab', () => {
    const { rerender } = render(<Fixture table={snapshot()} />);
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    fireEvent(document, new Event('visibilitychange'));
    rerender(<Fixture table={snapshot(['8h'], [event(1, '8h', 3)])} />);
    rerender(<Fixture table={snapshot(['8h', '9h'], [event(2, '9h', 3)])} />);
    hidden.mockReturnValue(false);
    fireEvent(document, new Event('visibilitychange'));
    rerender(<Fixture table={snapshot(['8h', '9h', 'Th'], [event(3, 'Th', 3)])} />);
    expect(animate).not.toHaveBeenCalled();
    rerender(<Fixture table={snapshot(['8h', '9h', 'Th', 'Jh'], [event(4, 'Jh', 3)])} />);
    expect(animate).toHaveBeenCalledTimes(1);
  });

  it('shows the board immediately when motion is reduced or WAAPI is unavailable', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
    const { container, rerender, unmount } = render(<Fixture table={snapshot()} />);
    rerender(<Fixture table={snapshot(['8h'], [event(1, '8h', 3)])} />);
    expect(animate).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLElement>('[data-durak-board-card]')!.style.visibility).toBe('');
    unmount();
    vi.unstubAllGlobals();
    delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
    const view = render(<Fixture table={snapshot()} />);
    view.rerender(<Fixture table={snapshot(['8h'], [event(1, '8h', 3)])} />);
    expect(view.container.querySelector('.durak-motion-layer')).toBeNull();
  });
});
