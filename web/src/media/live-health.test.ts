import { describe, expect, it } from 'vitest';
import { LiveHealth } from './live-health';

describe('return to live detector', () => {
  it('leaves a static screen and a hidden subscriber alone', () => {
    const health = new LiveHealth();
    for (let i = 0; i < 120; i++)
      expect(
        health.observe({
          timestamp: i * 2000,
          framesDecoded: 1,
          framesReceived: 1,
          bytesReceived: i * 50000,
        }),
      ).toBe(false);
  });
  it('detects a frozen decoder receiving significant video traffic', () => {
    const health = new LiveHealth();
    const flags = [0, 1, 2, 3].map((i) =>
      health.observe({
        timestamp: i * 2000,
        bytesReceived: i * 50000,
        framesDecoded: 10,
        framesReceived: 10 + i * 30,
      }),
    );
    expect(flags).toEqual([false, false, false, true]);
  });
  it('discards a stale sample after sleep or a decoder counter reset', () => {
    const health = new LiveHealth();
    health.observe({ timestamp: 0, bytesReceived: 50000, framesDecoded: 300 });
    health.observe({ timestamp: 2000, bytesReceived: 100000, framesDecoded: 300 });
    expect(health.observe({ timestamp: 20000, bytesReceived: 500000, framesDecoded: 300 })).toBe(false);
    expect(health.observe({ timestamp: 22000, bytesReceived: 10000, framesDecoded: 0 })).toBe(false);
  });
  it('flushes excess buffering but respects buffering required by a jittery network', () => {
    for (const minimum of [0.1, 0.9]) {
      const health = new LiveHealth();
      const flags = [0, 1, 2, 3].map((i) =>
        health.observe({
          timestamp: i * 2000,
          bytesReceived: i * 50000,
          framesDecoded: i * 30,
          jitterBufferEmittedCount: i * 30,
          jitterBufferDelay: i * 30,
          jitterBufferMinimumDelay: i * 30 * minimum,
        }),
      );
      expect(flags.at(-1)).toBe(minimum === 0.1);
    }
  });
});
