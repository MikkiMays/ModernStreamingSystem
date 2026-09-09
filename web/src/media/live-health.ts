export interface InboundSample {
  timestamp: number;
  bytesReceived: number;
  framesDecoded: number;
  framesReceived?: number;
  jitterBufferDelay?: number;
  jitterBufferMinimumDelay?: number;
  jitterBufferEmittedCount?: number;
}
/** Detect sustained decode stalls, not sparse frames from a static desktop. */
export class LiveHealth {
  private previous?: InboundSample;
  private stalled = 0;
  private buffered = 0;
  observe(current: InboundSample): boolean {
    const previous = this.previous;
    this.previous = current;
    const dt = previous ? current.timestamp - previous.timestamp : 0;
    if (
      !previous ||
      dt < 250 ||
      dt > 5000 ||
      current.framesDecoded < previous.framesDecoded ||
      current.bytesReceived < previous.bytesReceived
    ) {
      this.stalled = this.buffered = 0;
      return false;
    }
    const bytes = current.bytesReceived - previous.bytesReceived;
    // Muted, hidden/dynacast and static sources must never trigger an endless resubscribe loop.
    const completeFramesArrive =
      current.framesReceived !== undefined &&
      previous.framesReceived !== undefined &&
      current.framesReceived > previous.framesReceived;
    this.stalled =
      current.framesDecoded === previous.framesDecoded && completeFramesArrive && bytes / dt > 10
        ? this.stalled + dt
        : 0;
    const emitted = (current.jitterBufferEmittedCount ?? 0) - (previous.jitterBufferEmittedCount ?? 0);
    const delay =
      emitted > 0 ? ((current.jitterBufferDelay ?? 0) - (previous.jitterBufferDelay ?? 0)) / emitted : 0;
    const minimum =
      emitted > 0 &&
      current.jitterBufferMinimumDelay !== undefined &&
      previous.jitterBufferMinimumDelay !== undefined
        ? (current.jitterBufferMinimumDelay - previous.jitterBufferMinimumDelay) / emitted
        : Infinity;
    this.buffered = delay > 0.8 && minimum < 0.25 ? this.buffered + dt : 0;
    if (this.stalled >= 6000 || this.buffered >= 6000) {
      this.stalled = this.buffered = 0;
      return true;
    }
    return false;
  }
}
