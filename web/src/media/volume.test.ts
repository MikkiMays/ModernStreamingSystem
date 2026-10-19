import { describe, expect, it, vi } from 'vitest';
import { applyVolumeNow } from './volume';

function fakeTrack() {
  const gain = { value: 1, cancelScheduledValues: vi.fn() };
  const track = {
    gainNode: { gain } as unknown as GainNode,
    setVolume: vi.fn((volume: number) => {
      // Так делает LiveKit: громкость не ставится, а к ней плывут за ~100 мс.
      void volume;
    }),
  };
  return { track, gain };
}

describe('applyVolumeNow', () => {
  it('silences a just-attached track before its first sample, not 100 ms later', () => {
    const { track, gain } = fakeTrack();
    applyVolumeNow(track, 0);
    expect(gain.cancelScheduledValues).toHaveBeenCalled();
    expect(gain.value).toBe(0);
    expect(track.setVolume).toHaveBeenCalledWith(0);
  });

  it('applies any level at once', () => {
    const { track, gain } = fakeTrack();
    applyVolumeNow(track, 0.35);
    expect(gain.value).toBe(0.35);
  });

  it('still remembers the level when the track has no web-audio graph yet', () => {
    const track = { setVolume: vi.fn() };
    applyVolumeNow(track, 0);
    expect(track.setVolume).toHaveBeenCalledWith(0);
  });
});
