import { targetBitrate, type FrameRate, type Resolution } from './profiles';

export interface Rung {
  resolution: Resolution;
  fps: FrameRate;
}

/**
 * Worst to best. The top is 1080p60: that is the steady state worth holding, and chasing 1440p
 * automatically costs encoder headroom that is better spent keeping the frame rate honest.
 * 1440p stays available as an explicit choice.
 */
export const ladder: Rung[] = [
  { resolution: 720, fps: 15 },
  { resolution: 720, fps: 30 },
  { resolution: 1080, fps: 30 },
  { resolution: 1080, fps: 60 },
];

export const startingRung = 2;

/** Bandwidth must exceed a level's target by this much before that level is considered safe. */
const headroom = 1.25;

/** Highest level whose target fits the measured bandwidth with headroom to spare. */
export function levelFor(available: number): number {
  let best = 0;
  for (let index = 0; index < ladder.length; index++)
    if (targetBitrate(ladder[index]!) * headroom <= available) best = index;
  return best;
}

/**
 * Picks the best level the connection actually carries, and moves there directly.
 *
 * Climbing one level every few seconds took the better part of a minute to reach a quality the
 * link could have carried immediately, so the estimate drives the jump: the browser reports the
 * bandwidth it believes is available, and the level is chosen to fit it in one move.
 *
 * Dropping still needs two consecutive complaints, because a single stalled sample is usually a
 * blip; climbing needs two agreeing estimates, because bandwidth reported during a pause in the
 * picture is not evidence the link can sustain it.
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
   * @returns the new level when it changed, otherwise null.
   */
  observe(limitation: string, available: number | null): Rung | null {
    if (limitation === 'bandwidth' || limitation === 'cpu') {
      this.good = 0;
      if (++this.bad < 2 || this.index === 0) return null;
      this.bad = 0;
      // Drop to what the measurement supports rather than one step at a time, but never
      // sideways or up: the encoder just said this level does not fit.
      const fit = available === null ? this.index - 1 : Math.min(this.index - 1, levelFor(available));
      this.index = Math.max(0, fit);
      return this.current;
    }
    this.bad = 0;
    if (available === null) return null;
    const fit = levelFor(available);
    if (fit <= this.index) {
      this.good = 0;
      return null;
    }
    if (++this.good < 2) return null;
    this.good = 0;
    this.index = fit;
    return this.current;
  }
}
