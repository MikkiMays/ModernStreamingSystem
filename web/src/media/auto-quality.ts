import { targetBitrate, type FrameRate, type Resolution } from './profiles';

export interface Rung {
  resolution: Resolution;
  fps: FrameRate;
}

/**
 * Worst to best, ordered by what each level asks of the link.
 *
 * Раньше лестница кончалась на 1080p60, и это было решением: 1440p — только осознанный выбор.
 * На практике оно означало другое. Выбранный вручную 1440p жил ровно до первой подстройки:
 * `setProfile({ ...profile, ...rung })` затирал разрешение ступенью из лестницы, а вернуться
 * ей было некуда — 1440p в ней не было вовсе. То есть «Авто» не просто не поднималось до
 * 1440p, оно ещё и **опускало** тех, кто выбрал 1440p руками, и держало там до перезапуска
 * показа. Потолок теперь задаётся тем, что выбрал человек (`ceilingFor`), а не таблицей.
 *
 * 1080p60 и 1440p30 стоят каналу одинаково. При равной цене лестница предпочитает более
 * поздний, то есть более крупный кадр: для показываемого экрана это не близко, а лицо на
 * 1440p30 читается лучше, чем на 1080p60. Кому нужны именно 60 кадров — выбирает их руками,
 * и тогда автоматика этот выбор не трогает.
 */
export const ladder: Rung[] = [
  { resolution: 720, fps: 15 },
  { resolution: 720, fps: 30 },
  { resolution: 1080, fps: 30 },
  { resolution: 1080, fps: 60 },
  { resolution: 1440, fps: 30 },
  { resolution: 1440, fps: 60 },
];

/**
 * Выше этого лестница не поднимается: ни по кадру, ни по частоте.
 *
 * Считается по обоим измерениям, а не по цене. По цене 1080p60 и 1440p30 неразличимы, и
 * потолок «1080p60» пропустил бы 1440p30 — то есть кадр крупнее выбранного.
 */
export function ceilingFor(level: Rung): number {
  let best = 0;
  for (let index = 0; index < ladder.length; index++) {
    const rung = ladder[index]!;
    if (rung.resolution <= level.resolution && rung.fps <= level.fps) best = index;
  }
  return best;
}

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
 * picture is not evidence the link can sustain it. Первая же оценка — исключение, и только
 * вверх: она приходит через секунды после входа, к этому моменту разгон полосы уже случился,
 * и ждать второй значит держать человека на стартовом уровне дольше без всякой причины.
 * Вниз по первой оценке не двигаемся никогда — иначе разгон полосы выглядел бы как затор.
 */
export class AutoQuality {
  private index: number;
  private ceiling: number;
  private good = 0;
  private bad = 0;
  private seeded = false;

  constructor(start: number = startingRung, ceiling: number = ladder.length - 1) {
    this.ceiling = Math.min(ladder.length - 1, Math.max(0, ceiling));
    this.index = Math.min(this.ceiling, Math.max(0, start));
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
      this.seeded = true;
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
    const fit = Math.min(this.ceiling, levelFor(available));
    const first = !this.seeded;
    this.seeded = true;
    if (fit <= this.index) {
      this.good = 0;
      return null;
    }
    if (!first && ++this.good < 2) return null;
    this.good = 0;
    this.index = fit;
    return this.current;
  }
}
