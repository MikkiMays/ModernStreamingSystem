import { describe, expect, it } from 'vitest';
import { formatDuration, readStartedAt, spokenDuration } from './meeting-clock';

describe('readStartedAt', () => {
  it('takes the moment the core reports', () => {
    expect(readStartedAt({ startedAt: 1_760_000_000_000 })).toBe(1_760_000_000_000);
  });

  it('has nothing to show for a core that does not send it yet, or for nonsense', () => {
    expect(readStartedAt({})).toBeNull();
    expect(readStartedAt({ startedAt: null })).toBeNull();
    expect(readStartedAt({ startedAt: '1760000000000' })).toBeNull();
    expect(readStartedAt({ startedAt: Number.NaN })).toBeNull();
    expect(readStartedAt(null)).toBeNull();
  });
});

describe('formatDuration', () => {
  it('shows minutes and seconds within the first hour', () => {
    expect(formatDuration(0)).toBe('00:00');
    expect(formatDuration(65_400)).toBe('01:05');
    expect(formatDuration(59 * 60_000 + 59_999)).toBe('59:59');
  });

  it('adds hours from the first full hour', () => {
    expect(formatDuration(3_600_000)).toBe('1:00:00');
    expect(formatDuration(3_600_000 * 2 + 3 * 60_000 + 7_000)).toBe('2:03:07');
  });

  it('never runs backwards while the clocks settle', () => {
    expect(formatDuration(-1500)).toBe('00:00');
  });
});

describe('spokenDuration', () => {
  it('reads naturally', () => {
    expect(spokenDuration(20_000)).toBe('меньше минуты');
    expect(spokenDuration(12 * 60_000)).toBe('12 мин');
    expect(spokenDuration(65 * 60_000)).toBe('1 ч 5 мин');
    expect(spokenDuration(120 * 60_000)).toBe('2 ч');
  });
});
