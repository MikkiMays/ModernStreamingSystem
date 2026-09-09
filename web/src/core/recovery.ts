/** A monotonic deadline shared with the SDK policy; retries never create a new window. */
export class RecoveryWindow {
  private deadline: number | null = null;
  private epoch = 0;
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
