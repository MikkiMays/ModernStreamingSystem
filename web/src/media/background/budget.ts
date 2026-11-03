/**
 * Сторож бюджета кадра для фона в видео (R186, Р-89).
 *
 * ЗАЧЕМ. Сегментация и сведение кадра стоят времени, и на слабой машине их цена превышает интервал между
 * кадрами камеры: конвейер не успевает, кадры копятся и выбрасываются, в эфир уходит рваное видео —
 * именно так работал обработчик `@livekit/track-processors` (сегментация каждого кадра, без запаса).
 * Meet в такой ситуации не рвёт видео, а снижает долю работы: модель считается реже, маска между
 * прогонами переиспользуется, сведение идёт на каждом кадре. Сторож решает это одной цифрой — ступенью.
 *
 * Ступень говорит, на каждом ли кадре считать модель (`segmentEvery`): 1 — на каждом, 2 — на каждом
 * втором, … Между прогонами модели кадр сводится с прежней сглаженной маской: человек на 30 кадрах
 * за 33 мс сдвигается мало, а временное сглаживание маски (`shaders.ts`) и так тянет её за прежней.
 *
 * Правило — гистерезис, чтобы ступень не дёргалась: вверх (легче) — когда средняя цена кадра дольше
 * `HEAVY` доли интервала `UP_FRAMES` кадров подряд; вниз (качественнее) — когда цена ниже `LIGHT`
 * доли `DOWN_FRAMES` кадров подряд. Цена кадра — скользящее среднее, интервал — из меток времени
 * кадров источника, тоже сглаженный: камера в полумраке сама отдаёт меньше кадров, и бюджет растёт.
 */
export const LEVELS = [1, 2, 3, 4] as const;
/** Доля интервала кадра, выше которой конвейер не успевает и ступень поднимается. */
export const HEAVY = 0.8;
/** Доля интервала, ниже которой запас велик и можно считать модель чаще. */
export const LIGHT = 0.3;
/** Сколько тяжёлых кадров подряд — чтобы облегчить; сколько лёгких — чтобы вернуть качество. */
export const UP_FRAMES = 12;
export const DOWN_FRAMES = 90;
/** Интервал кадра, пока меток времени ещё нет: 30 кадров в секунду. */
const DEFAULT_INTERVAL_MS = 1000 / 30;

export interface BudgetState {
  /** Ступень: индекс в `LEVELS`. */
  level: number;
  /** Модель считается на каждом `segmentEvery`-м кадре. */
  segmentEvery: number;
  /** Средняя цена кадра конвейера, мс (сглажено). */
  costMs: number;
  /** Средний интервал между кадрами источника, мс (сглажено). */
  intervalMs: number;
}

export class Budget {
  private level = 0;
  private cost = 0;
  private costKnown = false;
  private interval = DEFAULT_INTERVAL_MS;
  /** Интервал задан снаружи (частота кадров источника) — метки времени его не меняют. */
  private fixedInterval = false;
  private lastStamp: number | null = null;
  private heavy = 0;
  private light = 0;
  private frames = 0;

  /** Сколько ступеней: тест и диагностика. */
  static readonly top = LEVELS.length - 1;

  get state(): BudgetState {
    return {
      level: this.level,
      segmentEvery: LEVELS[this.level]!,
      costMs: this.cost,
      intervalMs: this.interval,
    };
  }

  /** Считать ли модель на этом кадре — спрашивается до обработки, по счётчику кадров ступени. */
  shouldSegment(): boolean {
    return this.frames % LEVELS[this.level]! === 0;
  }

  /**
   * Кадр обработан: `stampMs` — метка времени кадра источника (любые единицы, пересчитанные в мс),
   * `costMs` — сколько ушло на него целиком. Возвращает `true`, если ступень изменилась.
   */
  record(stampMs: number, costMs: number): boolean {
    this.frames++;
    if (this.lastStamp !== null && !this.fixedInterval) {
      const gap = stampMs - this.lastStamp;
      // Пауза источника (вкладка спала, камера переключалась) — не интервал кадра, а разрыв.
      if (gap > 0 && gap < 1000) this.interval = this.interval * 0.9 + gap * 0.1;
    }
    this.lastStamp = stampMs;
    this.cost = this.costKnown ? this.cost * 0.8 + costMs * 0.2 : costMs;
    this.costKnown = true;
    const share = this.cost / this.interval;
    if (share > HEAVY) {
      this.heavy++;
      this.light = 0;
    } else if (share < LIGHT) {
      this.light++;
      this.heavy = 0;
    } else {
      this.heavy = 0;
      this.light = 0;
    }
    if (this.heavy >= UP_FRAMES && this.level < Budget.top) {
      this.level++;
      this.heavy = 0;
      this.frames = 0;
      return true;
    }
    if (this.light >= DOWN_FRAMES && this.level > 0) {
      this.level--;
      this.light = 0;
      this.frames = 0;
      return true;
    }
    return false;
  }

  /** Частота источника изменилась на лету (`enforceCameraRate` 30 → 60): бюджет кадра — по новой. */
  setFrameRate(frameRate: number | undefined) {
    if (frameRate && Number.isFinite(frameRate) && frameRate > 0) {
      this.interval = 1000 / frameRate;
      this.fixedInterval = true;
    } else this.fixedInterval = false;
  }

  /**
   * Новый источник — прежние метки времени к нему не относятся; ступень остаётся: машина та же.
   * `frameRate` источника, если известна, задаёт интервал точнее меток: когда конвейер не успевает,
   * источник выбрасывает кадры, и промежутки между дошедшими растут — по ним бюджет казался бы шире.
   */
  resetSource(frameRate?: number) {
    this.lastStamp = null;
    this.frames = 0;
    this.setFrameRate(frameRate);
  }
}

/**
 * Какая модель под кадр: ландшафтная (144×256, та же линия, что у Meet) — для горизонтального кадра,
 * квадратная (256×256) — для вертикального (телефон в руке). Обе — Selfie Segmenter MediaPipe.
 */
export type SegmenterModel = 'landscape' | 'square';
export function modelFor(width: number, height: number): SegmenterModel {
  return width >= height ? 'landscape' : 'square';
}

/**
 * Во сколько раз уменьшать кадр для размытия: 1, 2 или 4 — уменьшение идёт шагами вдвое (одна
 * билинейная выборка — ровно среднее 2×2), и кадр для размытия не уже 320 точек (480p камера сводилась
 * бы с мозаики). Чем меньше буфер, тем дешевле ядро размытия: у 1280×720 — вчетверо.
 */
export function blurDivisor(width: number): 1 | 2 | 4 {
  if (width / 4 >= 320) return 4;
  if (width / 2 >= 320) return 2;
  return 1;
}
export function blurSize(width: number, height: number): { width: number; height: number } {
  const divisor = blurDivisor(width);
  return {
    width: Math.max(1, Math.round(width / divisor)),
    height: Math.max(1, Math.round(height / divisor)),
  };
}

/** Размер буфера маски: половина кадра, не шире 640 — уточнять маску точнее, чем видно, незачем. */
export function maskSize(width: number, height: number): { width: number; height: number } {
  const w = Math.min(640, Math.max(1, Math.round(width / 2)));
  return { width: w, height: Math.max(1, Math.round((height * w) / width)) };
}

/**
 * Сигма гауссова размытия в точках буфера размытия. «Лёгкое» — фон читается, но не отвлекает (у Meet
 * «Slightly blur»); «сильное» — пятна цвета (у Meet «Blur»). Буфер ~320 точек шириной: сигма 3 на нём —
 * около 6–12 точек на кадре 640–1280.
 */
export const BLUR_SIGMA = { light: 3, strong: 9 } as const;
