/**
 * Как выглядит чужая демонстрация, пока её не открыли.
 *
 * ЗАЧЕМ. Плитка того, кто показывает экран, была ровным серым прямоугольником с аватаром.
 * По ней нельзя понять, стоит ли заходить: там презентация, игра или чей-то рабочий стол.
 *
 * ПОЧЕМУ НЕ ПОДПИСКА. Очевидный ход — подписаться на маленький слой демонстрации и показать
 * его в плитке. Но выбранный вручную уровень публикуется **одним** слоем, и маленького
 * просто нет: «превью» стоило бы столько же, сколько сам просмотр, у каждого в комнате и
 * всё время. Discord решает это иначе — периодическим кадром, а не живым потоком. Здесь так
 * же, и выключателя к этому нет: показ и так виден комнате, а размытый кадр только отвечает
 * на вопрос «что там». Десять секунд — цена этого ответа: несколько килобайт в минуту.
 *
 * ЧТО ВМЕСТО. Показывающий раз в десять секунд рисует свой экран в канвас 256×144,
 * кодирует JPEG и отправляет его каналом данных SFU — мимо ядра, мимо базы, несколько
 * килобайт. Получатель размывает картинку до состояния настроения: разобрать текст в ней
 * нельзя, а понять, что происходит, можно.
 */

/** Тема пакета: канал данных общий, и чужие сообщения по нему тоже ходят. */
export const PREVIEW_TOPIC = 'cord.screen-preview';
export const PREVIEW_WIDTH = 256;
export const PREVIEW_HEIGHT = 144;
export const PREVIEW_INTERVAL = 10000;
/**
 * Потолок одного пакета.
 *
 * Надёжный канал данных LiveKit ограничен 15 КиБ. Берём с запасом: пакет, который не
 * пролез, — это исключение в середине разговора ради картинки, без которой можно жить.
 */
export const PREVIEW_LIMIT = 14000;
/** Качество JPEG, от приличного к скромному: первый кадр, который влезет, и отправляется. */
export const PREVIEW_QUALITY = [0.5, 0.35, 0.2];

/**
 * Куда вписать кадр источника, сохранив пропорции.
 *
 * Вертикальный телефон и сверхширокий монитор не должны растягиваться: превью — это подсказка
 * о содержимом, и искажённая подсказка врёт о нём не меньше, чем отсутствующая.
 */
export function fitPreview(width: number, height: number) {
  if (!(width > 0) || !(height > 0)) return { width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT };
  const scale = Math.min(PREVIEW_WIDTH / width, PREVIEW_HEIGHT / height, 1);
  return {
    width: Math.max(2, Math.round(width * scale)),
    height: Math.max(2, Math.round(height * scale)),
  };
}

/** Собственные ссылки на картинки, которые надо отзывать: иначе вкладка растёт весь разговор. */
export class PreviewImages {
  private urls = new Map<string, string>();

  /** @returns ссылку на новый кадр этого участника. */
  accept(participantId: string, bytes: Uint8Array): string {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/jpeg' }));
    this.replace(participantId, url);
    return url;
  }

  forget(participantId: string) {
    this.replace(participantId, undefined);
  }

  clear() {
    for (const id of [...this.urls.keys()]) this.forget(id);
  }

  private replace(participantId: string, url: string | undefined) {
    const previous = this.urls.get(participantId);
    if (previous) URL.revokeObjectURL(previous);
    if (url) this.urls.set(participantId, url);
    else this.urls.delete(participantId);
  }
}

/**
 * Снимает кадры со своей демонстрации.
 *
 * Скрытый `<video>` вместо `ImageCapture`: второй есть не во всех браузерах, а первый
 * работает везде и ничего не декодирует — дорожка локальная, кадры уже есть.
 */
export class ScreenPreviewSource {
  private video?: HTMLVideoElement;
  private canvas?: HTMLCanvasElement;
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;

  start(track: MediaStreamTrack, send: (bytes: Uint8Array<ArrayBuffer>) => void) {
    this.stop();
    if (typeof document === 'undefined') return;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([track]);
    this.video = video;
    void video.play().catch(() => {});
    this.canvas = document.createElement('canvas');
    // Первый кадр — сразу, а не через интервал: иначе плитка остаётся серой ровно те
    // секунды, когда на неё и смотрят, решая, заходить ли.
    const tick = () => void this.capture(send);
    setTimeout(tick, 400);
    this.timer = setInterval(tick, PREVIEW_INTERVAL);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    if (this.video) {
      this.video.srcObject = null;
      this.video = undefined;
    }
    this.canvas = undefined;
  }

  private async capture(send: (bytes: Uint8Array<ArrayBuffer>) => void) {
    const video = this.video;
    const canvas = this.canvas;
    if (!video || !canvas || this.busy || !video.videoWidth) return;
    this.busy = true;
    try {
      const size = fitPreview(video.videoWidth, video.videoHeight);
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext('2d');
      if (!context) return;
      context.drawImage(video, 0, 0, size.width, size.height);
      for (const quality of PREVIEW_QUALITY) {
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, 'image/jpeg', quality),
        );
        if (!blob || this.canvas !== canvas) return;
        if (blob.size <= PREVIEW_LIMIT) {
          send(new Uint8Array(await blob.arrayBuffer()));
          return;
        }
      }
    } catch {
      /* Превью — украшение. Его отказ не должен трогать саму демонстрацию. */
    } finally {
      this.busy = false;
    }
  }
}
