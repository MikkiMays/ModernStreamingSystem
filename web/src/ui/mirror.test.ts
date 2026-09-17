import { describe, expect, it } from 'vitest';
import { Track } from 'livekit-client';
import { mirrored } from './Stage';

/**
 * Зеркалят себя, а не камеру. У задней камеры отражения не бывает: там смотрят на мир, и
 * зеркало означает, что рука уезжает влево, когда её ведут вправо.
 */
const tile = (local: boolean, source: Track.Source, facingMode?: string) =>
  ({
    local,
    source,
    track: { mediaStreamTrack: { getSettings: () => ({ facingMode }) } },
  }) as unknown as Parameters<typeof mirrored>[0];

describe('зеркало своей камеры', () => {
  it('зеркалит фронтальную', () => {
    expect(mirrored(tile(true, Track.Source.Camera, 'user'))).toBe(true);
  });

  it('не зеркалит заднюю', () => {
    expect(mirrored(tile(true, Track.Source.Camera, 'environment'))).toBe(false);
  });

  /** Настольные камеры молчат о facingMode, и молчание обязано значить «фронтальная». */
  it('зеркалит камеру, которая ничего о себе не сообщает', () => {
    expect(mirrored(tile(true, Track.Source.Camera, undefined))).toBe(true);
  });

  it('не трогает чужие камеры и свой экран', () => {
    expect(mirrored(tile(false, Track.Source.Camera, 'user'))).toBe(false);
    expect(mirrored(tile(true, Track.Source.ScreenShare, undefined))).toBe(false);
  });
});
