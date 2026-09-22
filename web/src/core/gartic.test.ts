import { afterEach, describe, expect, it, vi } from 'vitest';
import { drawingBatch, drawingPoint, DrawingQueue, mergeDrawing, type DrawingStroke } from './gartic';

const stroke = (id: string, count = 3): DrawingStroke => ({
  id,
  color: '#3564f3',
  width: 6,
  points: Array.from({ length: count }, () => [999, 1000]),
});
afterEach(() => vi.useRealTimers());

describe('drawing geometry', () => {
  it('normalizes pointer positions and clamps captured pointers outside the surface', () => {
    const box = { left: 10, top: 20, width: 500, height: 300 };
    expect(drawingPoint(260, 170, box)).toEqual([500, 500]);
    expect(drawingPoint(-5, 400, box)).toEqual([0, 1000]);
  });
  it('packs whole segments below the command limit and rejects invalid geometry', () => {
    const input = Array.from({ length: 8 }, (_, index) => stroke(String(index), 128));
    const batch = drawingBatch(input);
    expect(batch.text.length).toBeLessThanOrEqual(4000);
    expect(batch.count).toBeGreaterThan(0);
    expect(batch.count).toBeLessThan(input.length);
    expect(JSON.parse(batch.text).strokes).toEqual(input.slice(0, batch.count));
    expect(() => drawingBatch([{ ...stroke('x'), points: [[Number.NaN, 0]] }])).toThrow();
    expect(() => drawingBatch([{ ...stroke('x'), color: 'url(unsafe)' }])).toThrow();
    expect(() => drawingBatch([stroke('x', 129)])).toThrow();
  });
  it('reconciles accepted IDs without painting the same ink twice', () => {
    expect(mergeDrawing([stroke('a')], [stroke('a'), stroke('b')])).toEqual([stroke('a'), stroke('b')]);
  });
});

describe('drawing command queue', () => {
  it('splits a backlog of 33 short strokes at the server batch limit and completes flush', async () => {
    vi.useFakeTimers();
    const input = Array.from({ length: 33 }, (_, index) => stroke(String(index), 1));
    expect(JSON.stringify({ strokes: input }).length).toBeLessThan(4000);
    const received: DrawingStroke[] = [];
    const send = vi.fn(async (text: string) => {
      const batch = JSON.parse(text).strokes as DrawingStroke[];
      if (batch.length > 32) throw new Error('Неверное число штрихов');
      received.push(...batch);
    });
    const queue = new DrawingQueue({ send, interval: 250 });
    input.forEach((item) => queue.enqueue(item));
    const flushed = queue.flush().then(
      () => true,
      () => false,
    );
    await vi.runAllTimersAsync();
    expect(await flushed).toBe(true);
    expect(send.mock.calls.map(([text]) => JSON.parse(text).strokes.length)).toEqual([32, 1]);
    expect(received).toEqual(input);
    expect(queue.pending).toBe(0);
    queue.dispose();
  });
  it('keeps one request in flight, preserves ordering, and flushes only after acknowledgement', async () => {
    vi.useFakeTimers();
    let accept!: () => void;
    const send = vi.fn(
      (_text: string) =>
        new Promise<void>((resolve) => {
          accept = resolve;
        }),
    );
    const queue = new DrawingQueue({ send, interval: 250 });
    queue.enqueue(stroke('first'));
    await vi.advanceTimersByTimeAsync(0);
    queue.enqueue(stroke('second'));
    const finished = vi.fn();
    void queue.flush().then(finished);
    await vi.advanceTimersByTimeAsync(500);
    expect(send).toHaveBeenCalledTimes(1);
    expect(finished).not.toHaveBeenCalled();
    accept();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(send.mock.calls[1]![0]).strokes[0].id).toBe('second');
    accept();
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toHaveBeenCalledOnce();
    queue.dispose();
  });
  it('retries identical IDs after network failure and drops queued old-phase work on disposal', async () => {
    vi.useFakeTimers();
    const send = vi
      .fn<(text: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined);
    const failed = vi.fn();
    const queue = new DrawingQueue({ send, interval: 500, failed });
    queue.enqueue(stroke('same-id'));
    await vi.advanceTimersByTimeAsync(0);
    expect(failed).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2000);
    expect(send).toHaveBeenCalledTimes(1);
    queue.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(send.mock.calls[0]![0]).toEqual(send.mock.calls[1]![0]);
    queue.enqueue(stroke('obsolete'));
    queue.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('acknowledges a retried stroke even when another tab has already cleared it', async () => {
    vi.useFakeTimers();
    let local = [stroke('already-cleared')];
    const send = vi
      .fn<(text: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('acknowledgement lost'))
      .mockResolvedValue(undefined);
    const acknowledged = vi.fn((ids: string[]) => {
      local = local.filter((item) => !ids.includes(item.id));
    });
    const queue = new DrawingQueue({ send, interval: 250, acknowledged });
    queue.enqueue(local[0]!);
    await vi.advanceTimersByTimeAsync(0);
    expect(mergeDrawing([], local)).toHaveLength(1);
    queue.retry();
    await vi.advanceTimersByTimeAsync(250);
    expect(acknowledged).toHaveBeenCalledWith(['already-cleared']);
    expect(mergeDrawing([], local)).toEqual([]);
    queue.dispose();
  });
  it('waits for in-flight ink before discarding queued work, without replaying it after clear', async () => {
    vi.useFakeTimers();
    let accept!: () => void;
    const send = vi.fn(
      (_text: string) =>
        new Promise<void>((resolve) => {
          accept = resolve;
        }),
    );
    const queue = new DrawingQueue({ send, interval: 250 });
    queue.enqueue(stroke('in-flight'));
    await vi.advanceTimersByTimeAsync(0);
    queue.enqueue(stroke('not-sent'));
    const cleared = vi.fn();
    const discard = queue.discardPending().then((ids) => {
      cleared();
      return ids;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(cleared).not.toHaveBeenCalled();
    accept();
    expect(await discard).toEqual(['not-sent']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(queue.pending).toBe(0);
    await expect(queue.flush()).resolves.toBeUndefined();
    queue.dispose();
  });
  it('does not send queued ink until connection is restored', async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValue(undefined);
    const queue = new DrawingQueue({ send, interval: 250 });
    queue.setConnected(false);
    queue.enqueue(stroke('offline'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).not.toHaveBeenCalled();
    await expect(queue.flush()).rejects.toThrow('соединения');
    queue.setConnected(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledOnce();
    queue.dispose();
  });
});
