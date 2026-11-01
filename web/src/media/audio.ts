import type {
  AudioCaptureOptions,
  AudioProcessorOptions,
  LocalAudioTrack,
  Track,
  TrackProcessor,
  TrackPublishOptions,
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
 *
 * `forceStereo: false` — речь всегда моно (R113). Без этого LiveKit сам решает по устройству:
 * гарнитура или веб-камера, отдающая микрофон двумя каналами (`channelCount: 2`), публиковалась
 * стерео Opus, и если звучал только один канал — а у таких устройств это обычное дело, — всех
 * слушателей этот человек звучал в одном ухе. Моно-кодер сводит каналы сам, голос — в обоих ушах.
 */
export function microphoneOptions(): TrackPublishOptions {
  return { audioPreset: { maxBitrate: 64000 }, red: true, dtx: true, forceStereo: false };
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

/**
 * Модуль, ворклет и WASM шумодава RNNoise — один раз на страницу (R160).
 *
 * Раньше каждый обработчик грузил их сам: `loadRnnoise` заново тянул 150 КБ WASM, а
 * `audioWorklet.addModule` заново поднимал модуль в контексте встречи, — и так на каждое включение
 * микрофона, потому что обработчик пересобирался при каждом включении. Теперь сборка обработчика —
 * это узлы графа и компиляция WASM в самом ворклете, а всё, что можно держать, держится.
 */
interface RnnoiseAssets {
  Node: typeof import('@sapphi-red/web-noise-suppressor').RnnoiseWorkletNode;
  worklet: string;
  binary: ArrayBuffer;
}
let rnnoise: Promise<RnnoiseAssets> | undefined;
function rnnoiseAssets(): Promise<RnnoiseAssets> {
  if (rnnoise) return rnnoise;
  const loading = (async () => {
    const [{ RnnoiseWorkletNode, loadRnnoise }, worklet, wasm, simd] = await Promise.all([
      import('@sapphi-red/web-noise-suppressor'),
      import('@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url'),
      import('@sapphi-red/web-noise-suppressor/rnnoise.wasm?url'),
      import('@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url'),
    ]);
    const binary = await loadRnnoise(
      { url: wasm.default, simdUrl: simd.default },
      { signal: AbortSignal.timeout(10000) },
    );
    return { Node: RnnoiseWorkletNode, worklet: worklet.default, binary };
  })();
  rnnoise = loading;
  // Не загрузилось (сеть, таймаут) — следующая попытка начнёт заново, а не получит тот же отказ.
  loading.catch(() => {
    if (rnnoise === loading) rnnoise = undefined;
  });
  return loading;
}
/** Модуль ворклета уже поднят в этом контексте: второй `addModule` того же адреса не нужен. */
const workletModules = new WeakMap<BaseAudioContext, Promise<void>>();
function addWorklet(context: BaseAudioContext, url: string): Promise<void> {
  let added = workletModules.get(context);
  if (!added) {
    added = context.audioWorklet.addModule(url);
    workletModules.set(context, added);
    added.catch(() => workletModules.delete(context));
  }
  return added;
}
/**
 * Загрузить шумодав заранее — в начале встречи, а не по нажатию на микрофон: первое включение
 * не ждёт ни импорта, ни WASM. Только сеть и разбор модуля; контекст звука здесь не трогается.
 */
export function warmAudioProcessor(audio: AudioPreferences) {
  if (audio.suppression === 'rnnoise') void rnnoiseAssets().catch(() => {});
}
/**
 * Сырая дорожка захвата под публикацией. С обработчиком `mediaStreamTrack` у LiveKit — уже
 * обработанная (выход графа WebAudio): она живёт, даже когда сам микрофон отобрала система, и
 * `muted`/`ended` у неё не те. Сторож (R147) и включение смотрят на захват.
 */
export function captureTrack(track: LocalAudioTrack): MediaStreamTrack {
  const processor = track.getProcessor();
  return (processor instanceof CordAudioProcessor && processor.input) || track.mediaStreamTrack;
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
  private mono?: GainNode;
  private gain?: GainNode;
  private denoiser?: { disconnect(): void; destroy(): void };
  private destination?: MediaStreamAudioDestinationNode;
  private revision = 0;
  /** Сырая дорожка захвата, которую обрабатываем (`captureTrack`). */
  input?: MediaStreamTrack;
  constructor(private settings: AudioPreferences) {}
  /**
   * Подходит ли этот обработчик под настройки как есть (R160): тот же шумодав и граф живой —
   * пересобирать незачем; громкость при этом меняется на месте (`setGain`).
   */
  serves(audio: AudioPreferences) {
    return (
      audio.suppression === this.settings.suppression &&
      this.processedTrack?.readyState === 'live' &&
      this.context?.state !== 'closed'
    );
  }
  /** Усиление микрофона — на лету, без нового графа. */
  setGain(value: number) {
    this.settings = { ...this.settings, gain: value };
    if (this.gain) this.gain.gain.value = value;
  }
  async init({ track, audioContext }: AudioProcessorOptions) {
    const revision = ++this.revision;
    this.input = track;
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
      // Речь — один канал (R113). Устройство может отдать два, из которых звучит один, а RNNoise
      // с `maxChannels: 1` обрабатывает только первый и оставляет второй нулями: на выходе было
      // стерео «голос слева, тишина справа». Сводим заранее, по правилам «динамиков» ((L+R)/2).
      const mono = context.createGain();
      mono.channelCount = 1;
      mono.channelCountMode = 'explicit';
      mono.channelInterpretation = 'speakers';
      this.mono = mono;
      source.connect(mono);
      let tail: AudioNode = mono;
      if (this.settings.suppression === 'rnnoise') {
        const { Node, worklet, binary } = await rnnoiseAssets();
        await addWorklet(context, worklet);
        if (revision !== this.revision) return;
        const denoiser = new Node(context, { maxChannels: 1, wasmBinary: binary });
        this.denoiser = denoiser;
        tail.connect(denoiser);
        tail = denoiser;
      }
      if (revision !== this.revision) return;
      const gain = context.createGain();
      this.gain = gain;
      gain.gain.value = this.settings.gain;
      const destination = context.createMediaStreamDestination();
      // У назначения по умолчанию два канала: моно разложилось бы в стерео-дорожку.
      destination.channelCount = 1;
      destination.channelCountMode = 'explicit';
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
    // Сменился только захват — другое устройство, перезахват сторожа (R147): граф с шумодавом
    // остаётся, меняется его вход. Без новой компиляции WASM и без перерыва на выходе, а выход —
    // та же дорожка, и отправитель её даже не замечает (R160).
    const context = this.context;
    if (this.mono && context && context.state !== 'closed' && this.processedTrack?.readyState === 'live') {
      this.source?.disconnect();
      const source = context.createMediaStreamSource(new MediaStream([options.track]));
      source.connect(this.mono);
      this.source = source;
      this.input = options.track;
      return;
    }
    await this.destroy();
    await this.init(options);
  }
  async destroy() {
    this.revision++;
    this.source?.disconnect();
    this.mono?.disconnect();
    this.denoiser?.disconnect();
    this.denoiser?.destroy();
    this.gain?.disconnect();
    this.destination?.stream.getTracks().forEach((track) => track.stop());
    this.processedTrack = undefined;
    this.input = undefined;
    this.source = undefined;
    this.mono = undefined;
    this.denoiser = undefined;
    this.gain = undefined;
    this.destination = undefined;
    const context = this.context;
    this.context = undefined;
    if (context && this.ownsContext && context.state !== 'closed') await context.close();
  }
}
