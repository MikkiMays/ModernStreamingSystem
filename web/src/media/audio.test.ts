import { afterEach, expect, it, vi } from 'vitest';
import { audioCapture, CordAudioProcessor, microphoneOptions } from './audio';
import type { AudioProcessorOptions } from 'livekit-client';

/** Достаточно того, что читает обработчик: узлы ему нужны только чтобы их соединить. */
function stubAudio() {
  const created: {
    sampleRate: number;
    gains: { channelCount: number; channelCountMode: string; channelInterpretation: string }[];
    destinations: { channelCount: number; channelCountMode: string }[];
  }[] = [];
  const node = () => ({
    connect: vi.fn((next: unknown) => next),
    disconnect: vi.fn(),
    channelCount: 2,
    channelCountMode: 'max',
    channelInterpretation: 'speakers',
  });
  class Fake {
    state = 'running';
    sampleRate: number;
    constructor(options?: { sampleRate?: number }) {
      this.sampleRate = options?.sampleRate ?? 48000;
      created.push(this);
    }
    createMediaStreamSource = vi.fn(node);
    gains: { channelCount: number; channelCountMode: string; channelInterpretation: string }[] = [];
    createGain = vi.fn(() => {
      const gain = { ...node(), gain: { value: 1 } };
      this.gains.push(gain);
      return gain;
    });
    destinations: { channelCount: number; channelCountMode: string }[] = [];
    createMediaStreamDestination = vi.fn(() => {
      const destination = {
        ...node(),
        channelCountMode: 'explicit',
        stream: { getAudioTracks: () => [{ id: 'processed' }], getTracks: () => [] },
      };
      this.destinations.push(destination);
      return destination;
    });
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

/**
 * R113: «участника слышно только в левом ухе». Гарнитура или веб-камера отдают микрофон двумя
 * каналами, из которых звучит один; шумоподавление RNNoise (`maxChannels: 1`) обрабатывает только
 * первый канал и оставляет второй нулями, а LiveKit, видя `channelCount: 2`, публикует стерео Opus —
 * у всех слушателей голос в одном ухе. Речь — всегда моно: и в публикации, и после обработки.
 */
it('микрофон публикуется моно, даже если устройство отдаёт два канала', () => {
  expect(microphoneOptions().forceStereo).toBe(false);
  // RED и DTX — явно: для стерео LiveKit выключил бы их сам.
  expect(microphoneOptions()).toMatchObject({ red: true, dtx: true });
  expect(
    audioCapture({ suppression: 'browser', echoCancellation: true, autoGainControl: true, gain: 1 }),
  ).toMatchObject({
    channelCount: 1,
  });
});

it('обработка микрофона сводит вход в моно до шумодава и отдаёт моно', async () => {
  const { created } = stubAudio();
  const processor = new CordAudioProcessor({
    suppression: 'off',
    echoCancellation: true,
    autoGainControl: false,
    gain: 1.4,
  });
  await processor.init(options(undefined));
  const context = created[0]!;
  // Первый узел после источника — сведение: один канал, явно, по правилам «динамиков» ((L+R)/2).
  expect(context.gains[0]).toMatchObject({
    channelCount: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
  });
  expect(context.destinations[0]).toMatchObject({ channelCount: 1, channelCountMode: 'explicit' });
  await processor.destroy();
});
