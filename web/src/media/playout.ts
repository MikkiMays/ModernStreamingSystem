/** Ask for the smallest viable buffer; the engine still handles jitter, loss and A/V synchronization. */
export function preferRealtimePlayout(receiver?: RTCRtpReceiver) {
  if (!receiver) return;
  if ('jitterBufferTarget' in receiver) {
    try {
      (receiver as RTCRtpReceiver & { jitterBufferTarget: number }).jitterBufferTarget = 0;
    } catch {
      // A partially supported API must not interrupt subscription or playback.
    }
  }
  if ('playoutDelayHint' in receiver) {
    try {
      (receiver as RTCRtpReceiver & { playoutDelayHint: number }).playoutDelayHint = 0;
    } catch {
      // Fall back to the engine's own adaptive defaults.
    }
  }
}
