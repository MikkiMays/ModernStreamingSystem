import type { LocalVideoTrack, Track, TrackProcessor, VideoProcessorOptions } from 'livekit-client';
import type { BackgroundChoice, BackgroundSupport } from '../background-effect';
import { BackgroundEffect } from './effect';

/**
 * Обработчик дорожки LiveKit для фона (R186, Р-89): тонкий переходник к общему движку страницы
 * (`BackgroundEffect`). LiveKit зовёт `init` при установке, `restart` — при каждом включении камеры,
 * смене устройства, перевороте и смене качества (`restartTrack`), `destroy` — при снятии и остановке.
 * Прежний обработчик на `restart` пересоздавал wasm и модель; здесь это лишь новая дорожка-источник
 * у того же движка — и тот же выход (`processedTrack`): генератор принадлежит странице.
 *
 * `init` и `restart` **не бросают** (ревью R186, A4): исключение посреди `setMediaStreamTrack` у LiveKit
 * оставило бы новую дорожку камеры без `replaceTrack`, а отправителю — мёртвый генератор. При отказе
 * `processedTrack` остаётся пустым, и LiveKit публикует сырую дорожку (ставить её в `processedTrack`
 * нельзя: `internalStopProcessor` остановил бы её).
 */
export class CordBackgroundProcessor implements TrackProcessor<Track.Kind.Video, VideoProcessorOptions> {
  readonly name = 'cord-background';
  processedTrack?: MediaStreamTrack;
  /** Сырая дорожка захвата под обработкой — для возможностей, ограничений и настроек камеры. */
  source?: MediaStreamTrack;

  constructor(
    private choice: BackgroundChoice,
    private readonly support: BackgroundSupport,
    private readonly effect = BackgroundEffect.shared(),
  ) {}

  async init(opts: VideoProcessorOptions) {
    this.source = opts.track;
    try {
      this.processedTrack = await this.effect.attach(opts.track, this.choice, this.support, 'processor');
    } catch (error) {
      console.warn('[cord] background processor failed, publishing the camera as is', error);
      this.processedTrack = undefined;
    }
  }

  async restart(opts: VideoProcessorOptions) {
    await this.init(opts);
  }

  async destroy() {
    this.effect.detach(this.source);
    this.processedTrack = undefined;
    this.source = undefined;
  }

  /** Сменить выбор на лету — без переопубликации и без мигания у зрителей. */
  async update(choice: BackgroundChoice) {
    this.choice = choice;
    await this.effect.setChoice(choice, this.support);
  }
}

/**
 * Сырая дорожка захвата камеры. С обработчиком `mediaStreamTrack` у LiveKit — уже обработанная
 * (генератор кадров): у неё нет ни `getCapabilities` камеры, ни `deviceId`, ни `facingMode`, ни зума,
 * а `applyConstraints` к ней камеру не перенастраивает. Всё, что про камеру, смотрит сюда — как звук
 * смотрит на `captureTrack` (`media/audio.ts`).
 */
export function captureVideoTrack(track: LocalVideoTrack): MediaStreamTrack {
  const processor = track.getProcessor();
  return (processor instanceof CordBackgroundProcessor && processor.source) || track.mediaStreamTrack;
}
