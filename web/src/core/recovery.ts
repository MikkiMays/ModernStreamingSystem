/**
 * A monotonic deadline shared with the SDK policy; retries never create a new window.
 *
 * ОКНО МОЖНО ПРИДЕРЖАТЬ, И ЭТО ПРО ТЕЛЕФОН В КАРМАНЕ. Двадцать секунд отведены человеку, который
 * смотрит на экран: столько он готов ждать переподключения, прежде чем услышать «не получилось».
 * У погашенного экрана смотреть некому — а таймеры там идут как попало и браузер вправе заморозить
 * страницу совсем. Отсчитывать в это время конец встречи значит закончить её ровно там, где
 * человек ничего не делал: положил в карман и пошёл. Поэтому окно умеет стоять ({@link hold}), и
 * снова идёт с того же места, когда на экран опять смотрят.
 */
export class RecoveryWindow {
  private deadline: number | null = null;
  private epoch = 0;
  /** Остаток, замерший на время придержки, или `null` — окно идёт. */
  private held: number | null = null;
  constructor(
    readonly durationMs = 20000,
    private now = () => performance.now(),
    private random = Math.random,
  ) {}
  begin() {
    if (this.deadline === null) {
      this.deadline = this.now() + this.durationMs;
      this.epoch++;
    }
    return this.epoch;
  }
  remaining() {
    if (this.held !== null) return this.held;
    return this.deadline === null ? this.durationMs : Math.max(0, this.deadline - this.now());
  }
  get active() {
    return this.deadline !== null;
  }
  current(epoch: number) {
    return epoch === this.epoch && this.deadline !== null;
  }
  recovered() {
    this.deadline = null;
    this.epoch++;
    this.held = null;
  }

  /**
   * Придержать окно или отпустить его.
   *
   * <p>Пока придержано, {@link remaining} возвращает тот остаток, который был на момент
   * остановки: срок не тратится. Отпущенное окно продолжает идти с того же остатка, а не с
   * начала, — иначе «свернул и развернул» дарило бы по двадцать секунд сколько угодно раз.
   */
  hold(on: boolean) {
    if (on) {
      if (this.held === null && this.deadline !== null) this.held = this.remaining();
      return;
    }
    if (this.held !== null) {
      if (this.deadline !== null) this.deadline = this.now() + this.held;
      this.held = null;
    }
  }

  get holding() {
    return this.held !== null;
  }
  stop() {
    this.deadline = this.now();
    this.epoch++;
  }
  delay(retry: number): number | null {
    this.begin();
    const remaining = this.remaining();
    if (remaining <= 0) return null;
    const base = [0, 500, 1000, 2000][retry] ?? 3000;
    const delay = base === 0 ? 0 : Math.round(base * (0.9 + this.random() * 0.2));
    return delay < remaining ? delay : null;
  }
}
