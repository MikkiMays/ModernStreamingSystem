import { expect, it } from 'vitest';
import { preferRealtimePlayout } from './playout';

it('uses compatible zero hints while leaving actual buffering to the browser', () => {
  const receiver = { jitterBufferTarget: 50, playoutDelayHint: 0.05 };
  preferRealtimePlayout(receiver as unknown as RTCRtpReceiver);
  expect(receiver.jitterBufferTarget).toBe(0);
  expect(receiver.playoutDelayHint).toBe(0);
});

it('falls back to the legacy hint when a browser rejects the standard setter', () => {
  const receiver = {
    set jitterBufferTarget(_: number) {
      throw new Error('Unsupported');
    },
    playoutDelayHint: 0.05,
  };
  preferRealtimePlayout(receiver as unknown as RTCRtpReceiver);
  expect(receiver.playoutDelayHint).toBe(0);
});

it('unsupported engines and ended receivers cannot interrupt a track subscription', () => {
  expect(() => preferRealtimePlayout()).not.toThrow();
  expect(() => preferRealtimePlayout({} as RTCRtpReceiver)).not.toThrow();
  expect(() =>
    preferRealtimePlayout({
      set playoutDelayHint(_: number) {
        throw new Error('Ended');
      },
    } as unknown as RTCRtpReceiver),
  ).not.toThrow();
});
