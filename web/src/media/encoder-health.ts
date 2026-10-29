/** Решение сторожа кодировщика: отступить на совместимый кодек, вернуться на основной, или ничего. */
export type CodecMove = 'none' | 'fallback' | 'restore';

/**
 * Сторож кодировщика: когда держать VP9/AV1, когда отступить на H.264 и когда вернуться.
 *
 * Отступаем после `FALL_SAMPLES` жалоб на процессор (`cpu`) подряд при продвинутом кодеке
 * (при 3-секундном такте — около 9 с): редкие одиночные кадры на статике за перегрузку не считаем.
 *
 * Возвращаемся быстро, но с оглядкой. Отступ на капризном железе почти всегда временный (открыли
 * тяжёлое приложение, троттлинг), поэтому первый возврат — уже через `RESTORE_BASE` спокойных
 * замеров (≈12 с), а не через минуту: лишнюю H.264-секунду зритель не заметит, но и застревать на
 * запасном незачем. Если же машина отступает снова, каждый следующий возврат ждёт вдвое дольше, а
 * после `MAX_FALLS` отступов за сессию остаёмся на H.264 до конца — иначе кодек прыгал бы туда-сюда,
 * а каждый прыжок — переопубликация и моргание плитки. Так быстрый случай быстрый, а редкий
 * по-настоящему слабый — не дёргается.
 */
export class EncoderHealth {
  private overloaded = 0;
  private healthy = 0;
  private falls = 0;
  private static readonly FALL_SAMPLES = 3;
  private static readonly RESTORE_BASE = 4;
  private static readonly MAX_FALLS = 3;

  /**
   * @param reason `qualityLimitationReason` последнего замера: `cpu` / `bandwidth` / `none` / `unknown`.
   * @param advancedCodec сейчас кодируем VP9/AV1 — есть откуда отступать.
   * @param fellBack сейчас уже на запасном кодеке после отступа — есть куда возвращаться.
   */
  observe(reason: string, advancedCodec: boolean, fellBack = false): CodecMove {
    if (advancedCodec) {
      this.healthy = 0;
      this.overloaded = reason === 'cpu' ? this.overloaded + 1 : 0;
      if (this.overloaded >= EncoderHealth.FALL_SAMPLES) {
        this.overloaded = 0;
        this.falls++;
        return 'fallback';
      }
      return 'none';
    }
    this.overloaded = 0;
    if (!fellBack || this.falls >= EncoderHealth.MAX_FALLS) return 'none';
    // «Спокойно» — это не-cpu: нехватка канала (`bandwidth`) к процессору отношения не имеет, а
    // `unknown` осторожно считаем за не-спокойно, чтобы не вернуться на тяжёлый кодек вслепую.
    this.healthy = reason === 'cpu' || reason === 'unknown' ? 0 : this.healthy + 1;
    // Первый возврат — через RESTORE_BASE; каждый следующий отступ вдвое терпеливее.
    const needed = EncoderHealth.RESTORE_BASE * 2 ** (this.falls - 1);
    if (this.healthy >= needed) {
      this.healthy = 0;
      return 'restore';
    }
    return 'none';
  }
}
