import { afterEach, expect, it, vi } from 'vitest';
import { CordAudioProcessor } from './audio';
import type { AudioProcessorOptions } from 'livekit-client';

/** Достаточно того, что читает обработчик: узлы ему нужны только чтобы их соединить. */
function stubAudio() {
  const created: { sampleRate: number }[] = [];
  const node = () => ({ connect: vi.fn((next: unknown) => next), disconnect: vi.fn() });
  class Fake {
    state = 'running';
    sampleRate: number;
    constructor(options?: { sampleRate?: number }) {
      this.sampleRate = options?.sampleRate ?? 48000;
      created.push(this);
    }
    createMediaStreamSource = vi.fn(node);
    createGain = vi.fn(() => ({ ...node(), gain: { value: 1 } }));
    createMediaStreamDestination = vi.fn(() => ({
      ...node(),
      stream: { getAudioTracks: () => [{ id: 'processed' }], getTracks: () => [] },
    }));
    resume = vi.fn(async () => {});
    close = vi.fn(async () => {
      this.state = 'closed';
    });
  }
  vi.stubGlobal('AudioContext', Fake);
  vi.stubGlobal('MediaStream', class {});
  return { created, Fake };
}
afterEach(() => vi.unstubAllGlobals());

const options = (audioContext?: unknown) =>
  ({ track: { id: 'mic' }, kind: 'audio', audioContext }) as unknown as AudioProcessorOptions;

it('переживает перезапуск без контекста: смена микрофона его не приносит', async () => {
  const { created, Fake } = stubAudio();
  const room = new Fake() as unknown as AudioContext;
  const processor = new CordAudioProcessor({
    suppression: 'off',
    echoCancellation: true,
    autoGainControl: false,
    gain: 1.4,
  });
  await processor.init(options(room));
  expect(created).toHaveLength(1);
  // Ровно то, что делает LiveKit в `LocalTrack.restart`: контекст он не передаёт.
  await expect(processor.restart(options(undefined))).resolves.toBeUndefined();
  expect(processor.processedTrack).toBeDefined();
  // Контекст комнаты остался годным, значит своего заводить не пришлось.
  expect(created).toHaveLength(1);
});

it('заводит свой контекст, когда комната работает не на 48 кГц', async () => {
  const { created, Fake } = stubAudio();
  const room = new Fake({ sampleRate: 44100 }) as unknown as AudioContext;
  const processor = new CordAudioProcessor({
    suppression: 'off',
    echoCancellation: true,
    autoGainControl: false,
    gain: 1,
  });
  await processor.init(options(room));
  expect(created).toHaveLength(2);
  expect(created[1]!.sampleRate).toBe(48000);
  await processor.destroy();
});

it('без контекста вовсе работает на своём', async () => {
  const { created } = stubAudio();
  const processor = new CordAudioProcessor({
    suppression: 'off',
    echoCancellation: true,
    autoGainControl: false,
    gain: 1,
  });
  await expect(processor.init(options(undefined))).resolves.toBeUndefined();
  expect(created).toHaveLength(1);
  await processor.destroy();
});
