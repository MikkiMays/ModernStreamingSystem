/**
 * Как выглядит чужая демонстрация, пока её не открыли.
 *
 * ЗАЧЕМ. Плитка того, кто показывает экран, была ровным прямоугольником с аватаром. По ней
 * нельзя понять, стоит ли заходить: там презентация, игра или чей-то рабочий стол. Discord
 * показывает превью стрима всем в канале (R80), и у стримящего есть один флажок «скрыть
 * превью» при запуске — глобальной настройки нет, и здесь тоже.
 *
 * ПОЧЕМУ НЕ ПОДПИСКА. Подписаться на показ ради превью — это полный поток у каждого в комнате
 * всё время (один слой, R91). Периодический кадр по каналу данных стоит 10–20 Кбит/с на
 * зрителя — в сотни раз дешевле.
 *
 * ПОЧЕМУ ПЕРЕПИСАНО (R07). Кадр снимался через скрытый `<video>`: в Electron и в свёрнутом
 * окне он мог так и не заиграть (`videoWidth` 0), и зритель всё время видел заглушку —
 * «только зелёный фон». Теперь кадр берётся прямо из дорожки: `MediaStreamTrackProcessor` →
 * `VideoFrame` — без элемента, без воспроизведения; `<video>` остаётся запасным путём, и там
 * ждём настоящий кадр (`requestVideoFrameCallback`), а не таймер. Одноцветный кадр (чёрный
 * экран игры на загрузке, пустой рабочий стол, защищённое окно) не отправляется: заглушка
 * честнее, чем «превью» без содержимого.
 */

/** Тема пакета: канал данных общий, и чужие сообщения по нему тоже ходят. */
export const PREVIEW_TOPIC = 'cord.screen-preview';
export const PREVIEW_WIDTH = 256;
export const PREVIEW_HEIGHT = 144;
/** Пять секунд — цена ответа «что там»: несколько килобайт в минуту на зрителя. */
export const PREVIEW_INTERVAL = 5000;
/** Первый кадр — почти сразу: плитка нужна ровно в ту секунду, когда решают, заходить ли. */
export const PREVIEW_FIRST_MS = 400;
/**
 * Потолок одного пакета.
 *
 * Надёжный канал данных LiveKit ограничен 15 КиБ. Берём с запасом: пакет, который не
 * пролез, — это исключение в середине разговора ради картинки, без которой можно жить.
 */
export const PREVIEW_LIMIT = 14000;
/** Качество JPEG, от приличного к скромному: первый кадр, который влезет, и отправляется. */
export const PREVIEW_QUALITY = [0.5, 0.35, 0.2];
/** Сколько точек кадра смотрим, решая, одноцветный ли он. */
export const PREVIEW_PROBE_POINTS = 64;
/** Ниже этого среднего отклонения яркости по точкам кадр считается пустым. */
export const PREVIEW_FLAT_THRESHOLD = 6;

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

/**
 * Одноцветный ли кадр: по решётке точек считается среднее отклонение яркости от средней.
 *
 * Не «все точки равны»: JPEG-шум и градиенты дают разброс в единицы, а любое содержимое —
 * в десятки. `rgba` — байты RGBA кадра шириной `width`.
 */
export function isFlat(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): boolean {
  if (width <= 0 || height <= 0 || rgba.length < width * height * 4) return true;
  const side = Math.max(1, Math.round(Math.sqrt(PREVIEW_PROBE_POINTS)));
  const values: number[] = [];
  for (let row = 0; row < side; row++)
    for (let column = 0; column < side; column++) {
      const x = Math.min(width - 1, Math.floor(((column + 0.5) * width) / side));
      const y = Math.min(height - 1, Math.floor(((row + 0.5) * height) / side));
      const at = (y * width + x) * 4;
      // Яркость по Rec. 601 — достаточно, чтобы отличить пустое от непустого.
      values.push(0.299 * rgba[at]! + 0.587 * rgba[at + 1]! + 0.114 * rgba[at + 2]!);
    }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const deviation = values.reduce((sum, value) => sum + Math.abs(value - mean), 0) / values.length;
  return deviation < PREVIEW_FLAT_THRESHOLD;
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

/** Источник кадра: что умеет отдать картинку размером `width × height` на канвас. */
export type FrameSource = (width: number, height: number) => Promise<CanvasImageSource | null>;

type TrackProcessor = { readable: ReadableStream<VideoFrame> };
type TrackProcessorCtor = new (init: { track: MediaStreamTrack }) => TrackProcessor;

/**
 * Снимает кадры со своей демонстрации.
 *
 * Основной путь — `MediaStreamTrackProcessor`: один `VideoFrame` из дорожки по запросу, без
 * элемента и без воспроизведения. Запасной — `<video>` c `requestVideoFrameCallback`.
 */
export class ScreenPreviewSource {
  private video?: HTMLVideoElement;
  private canvas?: HTMLCanvasElement;
  private reader?: ReadableStreamDefaultReader<VideoFrame>;
  private timer?: ReturnType<typeof setInterval>;
  private first?: ReturnType<typeof setTimeout>;
  private busy = false;
  private generation = 0;

  start(track: MediaStreamTrack, send: (bytes: Uint8Array<ArrayBuffer>) => void) {
    this.stop();
    if (typeof document === 'undefined') return;
    const generation = ++this.generation;
    const Processor = (globalThis as { MediaStreamTrackProcessor?: TrackProcessorCtor })
      .MediaStreamTrackProcessor;
    if (Processor) {
      try {
        this.reader = new Processor({ track }).readable.getReader();
      } catch {
        this.reader = undefined;
      }
    }
    if (!this.reader) {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = new MediaStream([track]);
      this.video = video;
      void video.play().catch(() => {});
    }
    this.canvas = document.createElement('canvas');
    const tick = () => void this.capture(send, generation);
    this.first = setTimeout(tick, PREVIEW_FIRST_MS);
    this.timer = setInterval(tick, PREVIEW_INTERVAL);
  }

  stop() {
    this.generation++;
    clearInterval(this.timer);
    clearTimeout(this.first);
    this.timer = this.first = undefined;
    void this.reader?.cancel().catch(() => {});
    this.reader = undefined;
    if (this.video) {
      this.video.srcObject = null;
      this.video = undefined;
    }
    this.canvas = undefined;
  }

  /** Один кадр из дорожки — `VideoFrame` или готовый к рисованию `<video>`. */
  private async frame(): Promise<{
    image: CanvasImageSource;
    width: number;
    height: number;
    close?: () => void;
  } | null> {
    if (this.reader) {
      const { value, done } = await this.reader.read();
      if (done || !value) return null;
      const width = value.displayWidth || value.codedWidth;
      const height = value.displayHeight || value.codedHeight;
      return { image: value as unknown as CanvasImageSource, width, height, close: () => value.close() };
    }
    const video = this.video;
    if (!video) return null;
    if (!video.videoWidth && 'requestVideoFrameCallback' in video) {
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        (
          video as HTMLVideoElement & { requestVideoFrameCallback(cb: () => void): number }
        ).requestVideoFrameCallback(done);
        setTimeout(done, 1500);
      });
    }
    if (!video.videoWidth) return null;
    return { image: video, width: video.videoWidth, height: video.videoHeight };
  }

  private async capture(send: (bytes: Uint8Array<ArrayBuffer>) => void, generation: number) {
    const canvas = this.canvas;
    if (!canvas || this.busy) return;
    this.busy = true;
    try {
      const frame = await this.frame();
      if (!frame || generation !== this.generation) {
        frame?.close?.();
        return;
      }
      try {
        const size = fitPreview(frame.width, frame.height);
        canvas.width = size.width;
        canvas.height = size.height;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) return;
        context.drawImage(frame.image, 0, 0, size.width, size.height);
        // Пустой кадр — не превью: пусть плитка честно остаётся заглушкой.
        if (isFlat(context.getImageData(0, 0, size.width, size.height).data, size.width, size.height)) return;
      } finally {
        frame.close?.();
      }
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
