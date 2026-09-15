import type { FrameRate, Resolution } from './profiles';

export interface Rung {
  resolution: Resolution;
  fps: FrameRate;
}

/** Worst to best. Automatic quality only ever moves one rung at a time. */
export const ladder: Rung[] = [
  { resolution: 720, fps: 15 },
  { resolution: 720, fps: 30 },
  { resolution: 1080, fps: 30 },
  { resolution: 1080, fps: 60 },
  { resolution: 1440, fps: 60 },
];

export const startingRung = 2;

/**
 * Picks the best rung the connection actually carries.
 *
 * Dropping is deliberately quicker than climbing. A link that just failed to carry a level
 * will usually fail again, while a moment of free bandwidth proves nothing — so a step up
 * needs sustained headroom above the current target. Without that gap the level would
 * oscillate, which looks far worse than sitting one rung lower.
 */
export class AutoQuality {
  private index: number;
  private good = 0;
  private bad = 0;

  constructor(start: number = startingRung) {
    this.index = Math.min(ladder.length - 1, Math.max(0, start));
  }

  get current(): Rung {
    return ladder[this.index] ?? ladder[startingRung]!;
  }

  /**
   * @param limitation `qualityLimitationReason` from the outbound video stats.
   * @param available `availableOutgoingBitrate`, or null when the browser withholds it.
   * @param target bits per second the current rung is asking for.
   * @returns the new rung when the level changed, otherwise null.
   */
  observe(limitation: string, available: number | null, target: number): Rung | null {
    if (limitation === 'bandwidth' || limitation === 'cpu') {
      this.good = 0;
      if (++this.bad < 2 || this.index === 0) return null;
      this.bad = 0;
      this.index--;
      return this.current;
    }
    this.bad = 0;
    // Half again the current target, so the next rung has somewhere to grow into.
    this.good = available !== null && available > target * 1.5 ? this.good + 1 : 0;
    if (this.good < 5 || this.index === ladder.length - 1) return null;
    this.good = 0;
    this.index++;
    return this.current;
  }
}
