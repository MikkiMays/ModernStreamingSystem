/**
 * Задержка доски (R159): от того, как сосед отправил штрих, до того, как он пришёл сюда.
 *
 * Метка `t` в правке — часы автора, поправленные по серверу (`Meeting.serverNow`), и здесь из таких же
 * часов вычитается она: разница и есть путь «браузер → ядро → браузер». Ошибка — порядка половины
 * времени ответа у каждого, поэтому редкий отрицательный замер считается нулём, а заведомо сломанный
 * (минуты) — выбрасывается. Окно — последние 200 замеров: p50 и p95 для «Диагностики».
 */
export interface LatencyStats {
  p50: number;
  p95: number;
  count: number;
}

export class LatencyWindow {
  private samples: number[] = [];
  constructor(private readonly size = 200) {}

  add(ms: number) {
    if (!Number.isFinite(ms) || ms > 60_000 || ms < -5_000) return;
    this.samples.push(Math.max(0, ms));
    if (this.samples.length > this.size) this.samples.splice(0, this.samples.length - this.size);
  }

  stats(): LatencyStats | null {
    if (!this.samples.length) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const at = (q: number) =>
      sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
    return { p50: Math.round(at(0.5)), p95: Math.round(at(0.95)), count: sorted.length };
  }
}
