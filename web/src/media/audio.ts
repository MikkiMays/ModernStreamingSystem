import {
  Track,
  type AudioCaptureOptions,
  type AudioProcessorOptions,
  type TrackProcessor,
  type TrackPublishOptions,
} from 'livekit-client';
import type { AudioPreferences } from '../core/preferences';

/**
 * Как публиковать микрофон.
 *
 * ЗАЧЕМ ЯВНО. Раньше эти параметры не задавались вовсе: дорожка микрофона наследовала
 * `publishDefaults`, собранные для камеры, и получала то, что положил туда LiveKit. Это
 * работало, но означало, что качество речи в Cord меняется при обновлении библиотеки и
 * никем не решается. Поэтому числа теперь стоят здесь, вместе с причинами.
 *
 * `maxBitrate` — 64 кбит/с вместо прежних 48 по умолчанию. Разница на слух небольшая:
 * Opus и на 48 кбит/с передаёт речь почти прозрачно. Но 16 кбит/с — это тысячная доля
 * того, что занимает одна видеодорожка, а слышно их одинаково хорошо, и на такой цене
 * выбор очевиден. Голос — единственное, без чего встреча не встреча.
 *
 * `red` — дублирование предыдущего кадра в следующем пакете. Это главная защита речи от
 * потерь: потерянный пакет восстанавливается из соседнего, и вместо провала слышен
 * нормальный звук. Платится это удвоением потока, то есть теми же десятками килобит.
 *
 * `dtx` — молчание не передаётся. Для микрофона это правильно: в комнате на десять человек
 * девять молчат одновременно. Для музыки — нет, и там он выключен отдельно.
 */
export function microphoneOptions(): TrackPublishOptions {
  return { audioPreset: { maxBitrate: 64000 }, red: true, dtx: true };
}

export function audioCapture(audio: AudioPreferences, deviceId?: string): AudioCaptureOptions {
  return {
    deviceId: deviceId || undefined,
    echoCancellation: audio.echoCancellation,
    noiseSuppression: audio.suppression === 'browser',
    autoGainControl: audio.autoGainControl,
    voiceIsolation: audio.suppression === 'voice',
    channelCount: 1,
  };
}
export function needsAudioProcessor(audio: AudioPreferences) {
  return audio.suppression === 'rnnoise' || audio.gain !== 1;
}

/** A local, optional processor. Capture and speech never leave the device for filtering. */
export class CordAudioProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  readonly name = 'cord-audio';
  processedTrack?: MediaStreamTrack;
  private context?: AudioContext;
  /**
   * Контекст комнаты, каким его дали при первой настройке.
   *
   * ЗАЧЕМ ЗАПОМИНАТЬ. Смена микрофона идёт через `restartTrack`, а тот зовёт
   * `processor.restart({ track, kind, element, localTrack })` — **без** `audioContext`, хотя
   * в типе SDK это поле обязательное. Отсюда и красная строка внизу встречи «Cannot read
   * properties of undefined (reading 'sampleRate')» после каждой смены устройства, которую
   * лечил только перезаход в комнату. Своего контекста у обработчика может и не быть, а
   * прежний остаётся годным: комната его не закрывает от смены микрофона.
   */
  private shared?: AudioContext;
  private ownsContext = false;
  private source?: MediaStreamAudioSourceNode;
  private gain?: GainNode;
  private denoiser?: { disconnect(): void; destroy(): void };
  private destination?: MediaStreamAudioDestinationNode;
  private revision = 0;
  constructor(private settings: AudioPreferences) {}
  async init({ track, audioContext }: AudioProcessorOptions) {
    const revision = ++this.revision;
    // `audioContext` приходит пустым при перезапуске дорожки — см. `shared`.
    const given: AudioContext | undefined = audioContext ?? this.shared;
    this.shared = given && given.state !== 'closed' ? given : undefined;
    this.ownsContext = !this.shared || this.shared.sampleRate !== 48000;
    const context = this.ownsContext
      ? new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' })
      : this.shared!;
    this.context = context;
    try {
      const source = context.createMediaStreamSource(new MediaStream([track]));
      this.source = source;
      let tail: AudioNode = source;
      if (this.settings.suppression === 'rnnoise') {
        const { RnnoiseWorkletNode, loadRnnoise } = await import('@sapphi-red/web-noise-suppressor');
        const [worklet, wasm, simd] = await Promise.all([
          import('@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url'),
          import('@sapphi-red/web-noise-suppressor/rnnoise.wasm?url'),
          import('@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url'),
        ]);
        const [binary] = await Promise.all([
          loadRnnoise({ url: wasm.default, simdUrl: simd.default }, { signal: AbortSignal.timeout(10000) }),
          context.audioWorklet.addModule(worklet.default),
        ]);
        if (revision !== this.revision) return;
        const denoiser = new RnnoiseWorkletNode(context, { maxChannels: 1, wasmBinary: binary });
        this.denoiser = denoiser;
        tail.connect(denoiser);
        tail = denoiser;
      }
      if (revision !== this.revision) return;
      const gain = context.createGain();
      this.gain = gain;
      gain.gain.value = this.settings.gain;
      const destination = context.createMediaStreamDestination();
      this.destination = destination;
      tail.connect(gain).connect(destination);
      this.processedTrack = destination.stream.getAudioTracks()[0];
      await context.resume();
    } catch (error) {
      await this.destroy();
      throw error;
    }
  }
  async restart(options: AudioProcessorOptions) {
    await this.destroy();
    await this.init(options);
  }
  async destroy() {
    this.revision++;
    this.source?.disconnect();
    this.denoiser?.disconnect();
    this.denoiser?.destroy();
    this.gain?.disconnect();
    this.destination?.stream.getTracks().forEach((track) => track.stop());
    this.processedTrack = undefined;
    this.source = undefined;
    this.denoiser = undefined;
    this.gain = undefined;
    this.destination = undefined;
    const context = this.context;
    this.context = undefined;
    if (context && this.ownsContext && context.state !== 'closed') await context.close();
  }
}
