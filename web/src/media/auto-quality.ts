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

/**
 * Сколько опросов после смены уровня не слушать жалобы кодировщика.
 *
 * ЗАЧЕМ. Это и есть ответ на «начал показ — сразу 15 fps и каша». Сразу после публикации
 * браузер ещё не знает пропускной способности и наращивает её пробами; пока он наращивает,
 * кодировщику тесно, и он честно говорит `bandwidth`. Раньше двух таких сообщений подряд
 * хватало, чтобы уронить лестницу — и не на ступень, а сразу на ту, которую подтверждала
 * заниженная оценка разгона, то есть на самое дно. Дальше начиналось самое обидное: чтобы
 * подняться, нужна оценка выше текущей, а оценка растёт медленно, потому что мы сами больше
 * не отдаём. Показ оставался на 720p15 на канале, который держит 1440p60.
 *
 * Разгон полосы — не доказательство плохого канала. Шесть секунд — это две пробы BWE,
 * после которых его оценка уже что-то значит. Хорошая оценка в это время по-прежнему
 * считается: подниматься можно сразу, спускаться — нет.
 */
export const SETTLE_TICKS = 2;

/**
 * Сколько спокойных опросов подряд ждать, прежде чем самим попробовать ступень выше.
 *
 * ЗАЧЕМ ПРОБА ВООБЩЕ НУЖНА. Подъём по оценке канала упирается в замкнутый круг: браузер
 * оценивает то, что через него идёт, а идёт ровно столько, сколько мы отдаём. С нижней
 * ступени в 1,5 Мбит/с оценка редко переваливает за 3,75, которых просит следующая, — и
 * лестница может не подняться никогда, хотя канал держит вдесятеро больше. Поэтому раз в
 * полминуты спокойствия делается шаг вверх просто так. Не угадали — вернёмся вниз и
 * подождём дольше; угадали — человек получил то, за что платит.
 */
const PROBE_TICKS = 10;
const PROBE_LIMIT = 80;

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
 * Выбирает лучший уровень, который канал действительно несёт, и стремится вверх.
 *
 * Оценка канала ведёт наверх: браузер сообщает, сколько, по его мнению, доступно, и уровень
 * выбирается под неё одним движением, а не ступенька за несколько секунд. Где оценка молчит
 * или врёт в меньшую сторону — вверх ведёт проба.
 *
 * Вниз нужны две жалобы подряд: одна — обычно случайность. И ни одной жалобе не верят, пока
 * не кончился разгон после последней смены уровня, иначе лестница воюет с собственным стартом.
 */
export class AutoQuality {
  private index: number;
  private ceiling: number;
  private good = 0;
  private bad = 0;
  private seeded = false;
  private settle = SETTLE_TICKS;
  private calm = 0;
  private patience = PROBE_TICKS;
  /**
   * Догнала ли оценка канала то, что мы на самом деле отдаём.
   *
   * ЗАЧЕМ. Прыжок вниз «сразу туда, что подтверждает измерение» задуман для настоящего
   * затора: там измерение — самое честное, что есть. Но в первые секунды показа это же
   * измерение показывает разгон, то есть почти ноль, — и прыжок уносил на дно лестницы с
   * первой же пары жалоб. Ровно это и слышалось как «начал трансляцию, а там 15 fps».
   *
   * Верить оценке можно тогда, когда она хотя бы раз оправдала текущий уровень при
   * довольном кодировщике: это и значит, что оценщик догнал реальность. До тех пор вниз
   * ходим по одной ступени — медленнее, зато никогда не мимо.
   */
  private trusted = false;

  constructor(start: number = startingRung, ceiling: number = ladder.length - 1) {
    this.ceiling = Math.min(ladder.length - 1, Math.max(0, ceiling));
    this.index = Math.min(this.ceiling, Math.max(0, start));
  }

  get current(): Rung {
    return ladder[this.index] ?? ladder[startingRung]!;
  }

  private moveTo(index: number): Rung {
    this.index = Math.min(this.ceiling, Math.max(0, index));
    this.settle = SETTLE_TICKS;
    this.good = 0;
    this.bad = 0;
    this.calm = 0;
    return this.current;
  }

  /**
   * @param limitation `qualityLimitationReason` from the outbound video stats.
   * @param available `availableOutgoingBitrate`, or null when the browser withholds it.
   * @returns the new level when it changed, otherwise null.
   */
  observe(limitation: string, available: number | null): Rung | null {
    const complaint = limitation === 'bandwidth' || limitation === 'cpu';
    if (complaint) {
      this.good = 0;
      this.calm = 0;
      // Жалоба во время разгона — это жалоба на разгон, а не на канал.
      if (this.settle > 0) {
        this.settle--;
        return null;
      }
      this.seeded = true;
      if (++this.bad < 2 || this.index === 0) return null;
      // Уровень не удержался — в следующий раз пробовать выше будем осторожнее.
      this.patience = Math.min(PROBE_LIMIT, this.patience * 2);
      // Настоящий затор лучше пережидать внизу, а не спускаться к нему по ступенькам —
      // но только когда оценке есть за что верить. Иначе шаг, и не больше.
      const fit =
        this.trusted && available !== null ? Math.min(this.index - 1, levelFor(available)) : this.index - 1;
      return this.moveTo(fit);
    }

    this.bad = 0;
    if (this.settle > 0) this.settle--;
    const fit = available === null ? -1 : Math.min(this.ceiling, levelFor(available));
    // Кодировщик доволен, и оценка подтверждает уровень, на котором мы стоим: оценщик
    // догнал реальность, и с этого момента его числам можно верить и на спуске.
    if (available !== null && levelFor(available) >= this.index) this.trusted = true;
    if (fit > this.index) {
      // Первая же оценка — исключение, и только вверх: она приходит через секунды после
      // входа, к этому моменту разгон уже случился, и ждать второй значит держать человека
      // на стартовом уровне дольше без всякой причины.
      const first = !this.seeded;
      this.seeded = true;
      if (!first && ++this.good < 2) return null;
      // Подъём по оценке — это успех уровня, а не риск: запас терпения возвращается.
      this.patience = PROBE_TICKS;
      return this.moveTo(fit);
    }
    this.good = 0;
    if (available !== null) this.seeded = true;
    if (this.index >= this.ceiling) return null;
    // Оценка не зовёт наверх — значит, зовём себя сами. Ровно на ступень: проба обязана
    // быть дешёвой, иначе неудачная проба стоит дороже, чем удачная приносит.
    if (++this.calm < this.patience) return null;
    return this.moveTo(this.index + 1);
  }
}
