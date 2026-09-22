export interface DrawingStroke {
  id: string;
  color: string;
  width: number;
  points: number[][];
}

export const DRAWING_LIMITS = { strokes: 256, points: 4000, segment: 128, batch: 32, payload: 4000 };

export function drawingPoint(
  x: number,
  y: number,
  bounds: { left: number; top: number; width: number; height: number },
): number[] {
  const coordinate = (value: number) => Math.max(0, Math.min(1000, Math.round(value)));
  return [
    coordinate(((x - bounds.left) / Math.max(1, bounds.width)) * 1000),
    coordinate(((y - bounds.top) / Math.max(1, bounds.height)) * 1000),
  ];
}

/** Never duplicate locally optimistic ink when its authoritative copy arrives. */
export function mergeDrawing(server: DrawingStroke[], local: DrawingStroke[]): DrawingStroke[] {
  const ids = new Set(server.map((stroke) => stroke.id));
  return [...server, ...local.filter((stroke) => !ids.has(stroke.id))];
}

/** Whole immutable segments fit one command; retries retain their original IDs. */
export function drawingBatch(strokes: DrawingStroke[]): { text: string; count: number } {
  const batch: DrawingStroke[] = [];
  let text = '{"strokes":[]}';
  for (const stroke of strokes) {
    if (batch.length >= DRAWING_LIMITS.batch) break;
    if (
      !/^[a-zA-Z0-9_-]{1,36}$/.test(stroke.id) ||
      !/^#[0-9a-f]{6}$/i.test(stroke.color) ||
      !Number.isInteger(stroke.width) ||
      stroke.width < 1 ||
      stroke.width > 40 ||
      stroke.points.length < 1 ||
      stroke.points.length > DRAWING_LIMITS.segment ||
      stroke.points.some(
        (point) =>
          point.length !== 2 || point.some((value) => !Number.isInteger(value) || value < 0 || value > 1000),
      )
    )
      throw new Error('Некорректный штрих. Начните рисовать снова.');
    const next = JSON.stringify({ strokes: [...batch, stroke] });
    if (next.length > DRAWING_LIMITS.payload) break;
    batch.push(stroke);
    text = next;
  }
  if (strokes.length && !batch.length) throw new Error('Штрих слишком длинный.');
  return { text, count: batch.length };
}

/** One request at a time. A queue belongs to exactly one game and phase token. */
export class DrawingQueue {
  private strokes: DrawingStroke[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private paused = false;
  private connected = true;
  private disposed = false;
  private discarding = false;
  private inFlight: Promise<void> | undefined;
  private nextAt = 0;
  private waiters: { resolve: () => void; reject: (reason: Error) => void }[] = [];

  constructor(
    private readonly options: {
      send: (text: string) => Promise<unknown>;
      interval: number;
      changed?: (pending: number) => void;
      acknowledged?: (ids: string[]) => void;
      failed?: (error: Error) => void;
    },
  ) {}

  get pending() {
    return this.strokes.length;
  }

  enqueue(stroke: DrawingStroke) {
    if (this.disposed) return;
    drawingBatch([stroke]);
    this.strokes.push(stroke);
    this.options.changed?.(this.pending);
    this.schedule();
  }

  setConnected(connected: boolean) {
    this.connected = connected;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (connected) this.retry();
  }

  retry() {
    if (this.disposed) return;
    this.paused = false;
    this.schedule();
  }

  flush(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Раунд уже завершён.'));
    if (!this.pending && !this.running) return Promise.resolve();
    if (!this.connected) return Promise.reject(new Error('Дождитесь восстановления соединения.'));
    if (this.paused) return Promise.reject(new Error('Сначала отправьте рисунок повторно.'));
    const promise = new Promise<void>((resolve, reject) => this.waiters.push({ resolve, reject }));
    this.schedule();
    return promise;
  }

  /** Clear may discard rejected ink, but must wait for an already sent batch first. */
  async discardPending(): Promise<string[]> {
    this.discarding = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    try {
      if (this.running) await this.inFlight;
      const ids = this.strokes.map((stroke) => stroke.id);
      this.strokes = [];
      this.paused = false;
      this.settle(new Error('Локальные штрихи отменены.'));
      if (!this.disposed) this.options.changed?.(0);
      return ids;
    } finally {
      this.discarding = false;
    }
  }

  dispose() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.strokes = [];
    this.settle(new Error('Раунд уже завершён.'));
  }

  private settle(error?: Error) {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) error ? waiter.reject(error) : waiter.resolve();
  }

  private schedule() {
    if (this.disposed || this.discarding || this.running || this.paused || !this.connected || this.timer)
      return;
    if (!this.pending) {
      this.settle();
      return;
    }
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.inFlight = this.pump();
      },
      Math.max(0, this.nextAt - Date.now()),
    );
  }

  private async pump() {
    if (this.disposed || this.discarding || !this.connected || this.running || this.paused) return;
    this.running = true;
    this.nextAt = Date.now() + this.options.interval;
    try {
      const batch = drawingBatch(this.strokes);
      await this.options.send(batch.text);
      if (this.disposed) return;
      const ids = this.strokes.slice(0, batch.count).map((stroke) => stroke.id);
      this.strokes.splice(0, batch.count);
      this.options.acknowledged?.(ids);
    } catch (cause) {
      if (this.disposed) return;
      const error = cause instanceof Error ? cause : new Error('Не удалось отправить рисунок.');
      this.paused = true;
      if (!this.discarding) this.options.failed?.(error);
      this.settle(error);
    } finally {
      this.running = false;
      if (!this.disposed) {
        this.options.changed?.(this.pending);
        this.schedule();
      }
    }
  }
}
