import type { LocalVideoTrack } from 'livekit-client';
import type { BackgroundChoice, BackgroundSupport } from '../background-effect';
import type { BackgroundEffect } from './effect';
import { CordBackgroundProcessor } from './processor';

/**
 * Фон у дорожки камеры встречи (R153 → R186): ставит обработчик при первом эффекте и переключает его
 * на лету — без переопубликации и без мигания у зрителей. «Без фона» снимает обработчик целиком:
 * лишний проход кадров через конвейер стоит процессора, а движок с моделью остаётся живым у страницы
 * (`BackgroundEffect.shared()`) — следующее включение фона не ждёт загрузки.
 *
 * Вызовы идут очередью: смена камеры, включение и смена выбора приходят вразнобой, а `setProcessor`
 * у LiveKit не терпит наложений.
 */
/** Выход обработчика жив — или его нет вовсе (сырая дорожка публикуется, пока движок не поднялся). */
function healthy(processor: CordBackgroundProcessor): boolean {
  const output = processor.processedTrack;
  const source = processor.source;
  if (!output) return !source || source.readyState !== 'live';
  return output.readyState === 'live';
}

export class CameraBackground {
  private processor: CordBackgroundProcessor | null = null;
  private track: LocalVideoTrack | null = null;
  private queue: Promise<void> = Promise.resolve();

  /** `effect` — движок страницы; по умолчанию общий (`BackgroundEffect.shared()`), в тестах — подмена. */
  constructor(private readonly effect?: BackgroundEffect) {}

  /** Стоит ли обработчик на дорожке сейчас. */
  get active(): boolean {
    return this.processor !== null;
  }

  /** Применить выбор к дорожке (или к новой дорожке после смены камеры/кодека). */
  apply(
    track: LocalVideoTrack | null | undefined,
    choice: BackgroundChoice,
    support: BackgroundSupport,
  ): Promise<void> {
    this.queue = this.queue.catch(() => {}).then(() => this.run(track ?? null, choice, support));
    return this.queue;
  }

  private async run(track: LocalVideoTrack | null, choice: BackgroundChoice, support: BackgroundSupport) {
    if (this.track && this.track !== track) {
      this.processor = null;
      this.track = null;
    }
    if (!track) return;
    this.track = track;
    if (choice.kind === 'none') {
      if (track.getProcessor()) await track.stopProcessor().catch(() => {});
      this.processor = null;
      return;
    }
    const current = track.getProcessor();
    if (current instanceof CordBackgroundProcessor && healthy(current)) {
      this.processor = current;
      await current.update(choice);
      return;
    }
    // Обработчик стоит, но его выход кончился (генератор остановлен при сбое пути), а камера жива —
    // поставить заново (ревью R186, A1): иначе зрители видели бы застывший кадр до выключения камеры.
    if (current) await track.stopProcessor().catch(() => {});
    this.processor = new CordBackgroundProcessor(choice, support, this.effect);
    await track.setProcessor(this.processor);
  }
}
