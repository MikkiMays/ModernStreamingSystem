import type { LocalVideoTrack } from 'livekit-client';
import type { BackgroundChoice, BackgroundSupport } from '../background-effect';
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
export class CameraBackground {
  private processor: CordBackgroundProcessor | null = null;
  private track: LocalVideoTrack | null = null;
  private queue: Promise<void> = Promise.resolve();

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
    if (current instanceof CordBackgroundProcessor) {
      this.processor = current;
      await current.update(choice);
      return;
    }
    this.processor = new CordBackgroundProcessor(choice, support);
    await track.setProcessor(this.processor);
  }
}
