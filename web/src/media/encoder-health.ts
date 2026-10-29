/** Решение сторожа кодировщика: отступить на совместимый кодек, вернуться на основной, или ничего. */
export type CodecMove = 'none' | 'fallback' | 'restore';

/**
 * Сторож кодировщика: когда держать VP9/AV1, когда отступить на H.264 и когда вернуться.
 *
 * Отступаем после трёх подряд жалоб на процессор (`cpu`) при продвинутом кодеке — редкие
 * одиночные кадры на статике за перегрузку не считаем. Возвращаемся не сразу: нужно устойчивое
 * «процессор свободен» (`RESTORE_WINDOW` замеров подряд без `cpu`, при 3-секундном такте — около
 * минуты). И не бесконечно: после `MAX_FALLS` отступов за сессию остаёмся на H.264 до конца —
 * иначе слабая машина прыгала бы между кодеками, а каждый прыжок — переопубликация и моргание плитки.
 */
export class EncoderHealth {
  private overloaded = 0;
  private healthy = 0;
  private falls = 0;
  private static readonly RESTORE_WINDOW = 20;
  private static readonly MAX_FALLS = 2;

  /**
   * @param reason `qualityLimitationReason` последнего замера: `cpu` / `bandwidth` / `none` / `unknown`.
   * @param advancedCodec сейчас кодируем VP9/AV1 — есть откуда отступать.
   * @param fellBack сейчас уже на запасном кодеке после отступа — есть куда возвращаться.
   */
  observe(reason: string, advancedCodec: boolean, fellBack = false): CodecMove {
    if (advancedCodec) {
      this.healthy = 0;
      this.overloaded = reason === 'cpu' ? this.overloaded + 1 : 0;
      if (this.overloaded >= 3) {
        this.overloaded = 0;
        this.falls++;
        return 'fallback';
      }
      return 'none';
    }
    this.overloaded = 0;
    if (!fellBack || this.falls >= EncoderHealth.MAX_FALLS) return 'none';
    // «Здорово» — это не-cpu: нехватка канала (`bandwidth`) к процессору отношения не имеет, а
    // `unknown` осторожно считаем за не-здорово, чтобы не вернуться на тяжёлый кодек вслепую.
    this.healthy = reason === 'cpu' || reason === 'unknown' ? 0 : this.healthy + 1;
    if (this.healthy >= EncoderHealth.RESTORE_WINDOW) {
      this.healthy = 0;
      return 'restore';
    }
    return 'none';
  }
}
