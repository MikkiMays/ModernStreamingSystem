import type { FrameRate, Resolution, ScreenProfile } from './profiles';

/**
 * Нагрузка камеры — только на месте и только из-за процессора (R192).
 *
 * `balanced` у libwebrtc (R189) снимал и настоящую перегрузку, и нехватку канала: на старте, пока полоса разгоняется,
 * камера шла 480×270 при 10 кадрах и доходила до выбранного кадра через 30–40 секунд — те самые «293p10» владельца на
 * iPhone (480p × 3/5). Разделить эти две причины самому движку нельзя: предпочтение одно. Поэтому движку — выбранный кадр
 * (`maintain-resolution`), а кадр снижаем сами и только когда не хватает процессора: тем же `setParameters`, которым меняется
 * уровень (`retune.ts`), без переговоров и без переопубликации. Канал кадр не трогает никогда (X10, Р-32).
 *
 * Ступени — кадры шкалы камеры, у низа — половина частоты: в таблице битрейта есть только они.
 */
export function cameraLoadLadder(level: Pick<ScreenProfile, 'resolution' | 'fps'>) {
  const steps: { resolution: Resolution; fps: FrameRate }[] = [
    { resolution: level.resolution, fps: level.fps },
  ];
  for (const resolution of [720, 480] as const)
    if (resolution < level.resolution) steps.push({ resolution, fps: level.fps });
  if (level.fps > 15) steps.push({ resolution: steps[steps.length - 1]!.resolution, fps: 15 });
  return steps;
}

/** Что сказал замер: процессор не успевает, успевает — или вопрос не о нём (канал, браузер молчит). */
export type CameraLoadSignal = 'over' | 'calm' | 'other';

/**
 * Какая ступень сейчас. Такт — замер отдачи, 3 с: вниз после трёх подряд (≈ 9 с, всплеск — не перегрузка), вверх после
 * минуты спокойствия. Сорвалось вскоре после возврата — следующий возврат вдвое терпеливее: качание туда-сюда хуже, чем
 * чуть более долгая ступень. Терпение сбрасывается при смене уровня и новом захвате (`reset`).
 */
export class CameraLoad {
  static readonly OVER_SAMPLES = 3;
  static readonly CALM_SAMPLES = 20;
  static readonly MAX_CALM_SAMPLES = 160;
  /** Сколько замеров после возврата перегрузка считается срывом этого возврата. */
  private static readonly RELAPSE_SAMPLES = 20;

  step = 0;
  private over = 0;
  private calm = 0;
  private patience = CameraLoad.CALM_SAMPLES;
  private sinceReturn = Infinity;

  /** @returns новая ступень, если её нужно применить; `deepest` — номер нижней ступени. */
  observe(signal: CameraLoadSignal, deepest: number): number | null {
    this.sinceReturn++;
    if (signal === 'other') return null;
    if (signal === 'over') {
      this.calm = 0;
      this.over++;
      if (this.over < CameraLoad.OVER_SAMPLES || this.step >= deepest) return null;
      this.over = 0;
      if (this.sinceReturn <= CameraLoad.RELAPSE_SAMPLES)
        this.patience = Math.min(this.patience * 2, CameraLoad.MAX_CALM_SAMPLES);
      this.sinceReturn = Infinity;
      return ++this.step;
    }
    this.over = 0;
    if (this.step === 0) return null;
    this.calm++;
    if (this.calm < this.patience) return null;
    this.calm = 0;
    this.sinceReturn = 0;
    return --this.step;
  }

  reset() {
    this.step = 0;
    this.over = 0;
    this.calm = 0;
    this.patience = CameraLoad.CALM_SAMPLES;
    this.sinceReturn = Infinity;
  }
}
