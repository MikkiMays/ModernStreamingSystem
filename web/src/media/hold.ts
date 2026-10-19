import type { Resolution, ScreenProfile } from './profiles';

/**
 * Удержание выбранного уровня — то, что осталось от лестницы качества.
 *
 * ЗАЧЕМ. Лестница «Авто» (`auto-quality.ts`, удалена) начинала с середины, спускалась до 720p15 и
 * пробовала вверх сама — это и было «начал показ — 15 fps и каша» (T44). По П2 выбранный уровень
 * публикуется сразу, а если канал его не вывозит в первые секунды, мы **ждём разгона**, а не
 * спускаемся: окно `settle` приходит с сервера (`capabilities.quality.settleMs`).
 *
 * Что остаётся после окна. Жалобы кодировщика (`bandwidth`/`cpu`) две подряд опускают **только
 * разрешение, на одну ступень и не ниже 720p**; частота — то, ради чего уровень и выбирают, —
 * остаётся выбранной. Это временно: десять спокойных опросов подряд (полминуты) возвращают выбор.
 * Второй ступени вниз нет: 720p при выбранной частоте — пол, дальше работает только адаптация
 * самого браузера внутри слоя (`degradationPreference`), а она обратима сама по себе.
 *
 * Запись в настройках не меняется никогда: «выбрано» и «идёт сейчас» — два разных числа, и второе
 * видно в плашке отдачи.
 */
export const RETURN_TICKS = 10;
const FLOOR: Resolution = 720;

function stepDown(resolution: Resolution): Resolution {
  return resolution > 1080 ? 1080 : FLOOR;
}

export class HoldLevel {
  private settle: number;
  private bad = 0;
  private calm = 0;
  private lowered = false;

  /**
   * @param chosen что выбрал человек
   * @param settleTicks сколько опросов после публикации или смены уровня жалобы не считаются
   */
  constructor(
    private chosen: ScreenProfile,
    private readonly settleTicks: number,
  ) {
    this.settle = settleTicks;
  }

  get current(): ScreenProfile {
    return this.lowered
      ? { resolution: stepDown(this.chosen.resolution), fps: this.chosen.fps }
      : this.chosen;
  }

  /** Тот ли это выбор, под который удержание создано. */
  holds(level: ScreenProfile) {
    return level.resolution === this.chosen.resolution && level.fps === this.chosen.fps;
  }

  /**
   * @param limitation `qualityLimitationReason` из исходящей статистики.
   * @returns новый уровень отдачи, когда он сменился, иначе null.
   */
  observe(limitation: string): ScreenProfile | null {
    if (this.settle > 0) {
      // Жалоба во время разгона — это жалоба на разгон, а не на канал.
      this.settle--;
      return null;
    }
    const complaint = limitation === 'bandwidth' || limitation === 'cpu';
    if (complaint) {
      this.calm = 0;
      if (this.lowered || this.chosen.resolution <= FLOOR || ++this.bad < 2) return null;
      this.lowered = true;
      this.bad = 0;
      this.settle = this.settleTicks;
      return this.current;
    }
    this.bad = 0;
    if (!this.lowered || ++this.calm < RETURN_TICKS) return null;
    this.lowered = false;
    this.calm = 0;
    this.settle = this.settleTicks;
    return this.current;
  }
}
