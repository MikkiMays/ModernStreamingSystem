import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DrawingStroke } from '../core/gartic';
import GarticCanvas from './GarticCanvas';

const stroke = (id: string): DrawingStroke => ({
  id,
  color: '#3564f3',
  width: 6,
  points: [
    [100, 200],
    [200, 400],
    [400, 500],
  ],
});
const props = {
  editable: false,
  connected: true,
  smoothRemote: true,
  onDraw: async () => {},
  onEdit: async () => {},
};
const lines = (container: HTMLElement) => [...container.querySelectorAll('polyline')];
const complete = (container: HTMLElement) => {
  for (const line of lines(container)) {
    expect(line.style.strokeDashoffset).toBe('');
    expect(line.style.visibility).not.toBe('hidden');
  }
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('remote drawing presentation', () => {
  it('reveals fresh ink progressively without restarting on an identical snapshot', () => {
    const first = stroke('first');
    const second = stroke('second');
    const { container, rerender } = render(<GarticCanvas {...props} strokes={[first]} />);
    complete(container);
    rerender(<GarticCanvas {...props} strokes={[first, second]} />);
    act(() => vi.advanceTimersByTime(80));
    const ink = lines(container)[1]!;
    const progress = Number(ink.style.strokeDashoffset);
    expect(progress).toBeGreaterThan(0);
    expect(progress).toBeLessThan(1);
    rerender(<GarticCanvas {...props} strokes={structuredClone([first, second])} />);
    expect(Number(ink.style.strokeDashoffset)).toBe(progress);
    act(() => vi.advanceTimersByTime(200));
    complete(container);
    expect(ink.getAttribute('points')).toBe('100,125 200,250 400,312.5');
  });

  it.each(['undo', 'clear', 'replacement'] as const)(
    'applies %s immediately and cancels obsolete frames',
    (change) => {
      const first = stroke('first');
      const second = stroke('second');
      const { container, rerender } = render(<GarticCanvas {...props} strokes={[first]} />);
      rerender(<GarticCanvas {...props} strokes={[first, second]} />);
      act(() => vi.advanceTimersByTime(32));
      expect(lines(container)[1]!.style.strokeDashoffset).not.toBe('');
      const authoritative =
        change === 'clear' ? [] : change === 'undo' ? [first] : [{ ...first, color: '#ef4444' }, second];
      rerender(<GarticCanvas {...props} strokes={authoritative} />);
      complete(container);
      act(() => vi.advanceTimersByTime(300));
      expect(lines(container)).toHaveLength(authoritative.length);
      complete(container);
    },
  );

  it('shows initial and large catch-up snapshots immediately and never queues animation behind newer ink', () => {
    const initial = [stroke('first')];
    const { container, rerender } = render(<GarticCanvas {...props} strokes={initial} />);
    complete(container);
    const caughtUp = [...initial, ...Array.from({ length: 8 }, (_, index) => stroke(`catch-up-${index}`))];
    rerender(<GarticCanvas {...props} strokes={caughtUp} />);
    complete(container);
    const next = [...caughtUp, stroke('next')];
    rerender(<GarticCanvas {...props} strokes={next} />);
    act(() => vi.advanceTimersByTime(32));
    expect(lines(container).at(-1)!.style.strokeDashoffset).not.toBe('');
    rerender(<GarticCanvas {...props} strokes={[...next, stroke('latest')]} />);
    expect(lines(container).at(-2)!.style.strokeDashoffset).toBe('');
    act(() => vi.advanceTimersByTime(250));
    complete(container);
  });

  it('finishes ink on disconnect and accepts the first restored snapshot without animation', () => {
    const initial = [stroke('first')];
    const next = [...initial, stroke('second')];
    const { container, rerender } = render(<GarticCanvas {...props} strokes={initial} />);
    rerender(<GarticCanvas {...props} strokes={next} />);
    act(() => vi.advanceTimersByTime(32));
    expect(lines(container)[1]!.style.strokeDashoffset).not.toBe('');
    rerender(<GarticCanvas {...props} connected={false} strokes={next} />);
    complete(container);
    rerender(<GarticCanvas {...props} strokes={next} />);
    const restored = [...next, stroke('restored')];
    rerender(<GarticCanvas {...props} strokes={restored} />);
    complete(container);
    rerender(<GarticCanvas {...props} strokes={[...restored, stroke('live')]} />);
    act(() => vi.advanceTimersByTime(32));
    expect(lines(container).at(-1)!.style.strokeDashoffset).not.toBe('');
  });

  it('respects reduced motion, including a preference change during an animation', () => {
    const listeners = new Set<() => void>();
    const query = {
      matches: false,
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    };
    vi.stubGlobal('matchMedia', () => query);
    const initial = [stroke('first')];
    const next = [...initial, stroke('second')];
    const { container, rerender } = render(<GarticCanvas {...props} strokes={initial} />);
    rerender(<GarticCanvas {...props} strokes={next} />);
    act(() => vi.advanceTimersByTime(32));
    expect(lines(container)[1]!.style.strokeDashoffset).not.toBe('');
    act(() => {
      query.matches = true;
      [...listeners].forEach((listener) => listener());
    });
    complete(container);
    rerender(<GarticCanvas {...props} strokes={[...next, stroke('third')]} />);
    complete(container);
  });

  it('keeps the author immediate even when remote smoothing was requested', () => {
    const first = stroke('first');
    const { container, rerender } = render(<GarticCanvas {...props} editable strokes={[first]} />);
    rerender(<GarticCanvas {...props} editable strokes={[first, stroke('second')]} />);
    complete(container);
  });

  it('reveals multiple appended segments in order and cancels its frame on unmount', () => {
    const first = stroke('first');
    const { container, rerender, unmount } = render(<GarticCanvas {...props} strokes={[first]} />);
    rerender(<GarticCanvas {...props} strokes={[first, stroke('second'), stroke('third')]} />);
    act(() => vi.advanceTimersByTime(48));
    expect(lines(container)[1]!.style.visibility).not.toBe('hidden');
    expect(lines(container)[2]!.style.visibility).toBe('hidden');
    act(() => vi.advanceTimersByTime(96));
    expect(lines(container)[2]!.style.visibility).not.toBe('hidden');
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('finishes animation when the tab hides and renders its first returning snapshot immediately', () => {
    const first = stroke('first');
    const next = [first, stroke('second')];
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const { container, rerender } = render(<GarticCanvas {...props} strokes={[first]} />);
    rerender(<GarticCanvas {...props} strokes={next} />);
    act(() => vi.advanceTimersByTime(32));
    expect(lines(container)[1]!.style.strokeDashoffset).not.toBe('');
    act(() => {
      hidden.mockReturnValue(true);
      document.dispatchEvent(new Event('visibilitychange'));
    });
    complete(container);
    const background = [...next, stroke('background')];
    rerender(<GarticCanvas {...props} strokes={background} />);
    complete(container);
    hidden.mockReturnValue(false);
    rerender(<GarticCanvas {...props} strokes={[...background, stroke('caught-up')]} />);
    complete(container);
  });
});
