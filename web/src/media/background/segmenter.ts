import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';
import type { SegmenterModel } from './budget';

/**
 * Сегментация человека — MediaPipe Selfie Segmenter (R186, Р-89): две модели, ландшафтная 144×256 и
 * квадратная 256×256, обе из `public/mediapipe/`; среда wasm — оттуда же (`vite.config.ts` →
 * `mediapipeAssets`). Модель держится живой на всё время работы движка: пересоздавать wasm и модель на
 * каждое включение камеры (как делал прежний обработчик на `processor.restart()`) — это секунда
 * чёрного кадра и лишние 20 МБ разбора.
 *
 * Выход — **маска уверенности** (`outputConfidenceMasks`), а не категория по порогу 0,5: у волос и у
 * края плеча уверенность 0,3–0,7, и жёсткий порог делал край рваным. Текстура маски читается прямо
 * из контекста WebGL, общего с конвейером (`canvas`), без копии через процессор.
 */
const RETRY_MS = 15_000;

export interface SegmenterAssets {
  /** Каталог wasm MediaPipe (`/mediapipe/wasm`). */
  wasm: string;
  /** Адреса моделей по виду. */
  models: Record<SegmenterModel, string>;
}

export interface MaskTexture {
  texture: WebGLTexture;
  width: number;
  height: number;
}

export class Segmenter {
  private readonly segmenters = new Map<SegmenterModel, Promise<ImageSegmenter>>();
  /** Когда загрузка этой модели провалилась: повтор — не раньше чем через `RETRY_MS`. */
  private readonly failedAt = new Map<SegmenterModel, number>();
  private fileset: Promise<Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>> | null = null;
  private lastStamp = 0;
  private closed = false;

  constructor(
    private readonly canvas: OffscreenCanvas | HTMLCanvasElement,
    private readonly assets: SegmenterAssets,
  ) {}

  /** Загрузить модель нужного вида (один раз); ждать — только первой загрузки. */
  load(model: SegmenterModel): Promise<ImageSegmenter> {
    let loading = this.segmenters.get(model);
    if (!loading) {
      const failed = this.failedAt.get(model);
      if (failed !== undefined && performance.now() - failed < RETRY_MS)
        return Promise.reject(new Error('segmenter load failed recently'));
      this.fileset ??= FilesetResolver.forVisionTasks(this.assets.wasm);
      loading = remember(
        this.fileset.then((fileset) =>
          ImageSegmenter.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: this.assets.models[model], delegate: 'GPU' },
            canvas: this.canvas,
            runningMode: 'VIDEO',
            outputConfidenceMasks: true,
            outputCategoryMask: false,
          }),
        ),
      );
      loading.catch(() => {
        this.segmenters.delete(model);
        this.failedAt.set(model, performance.now());
        this.fileset = null;
      });
      this.segmenters.set(model, loading);
    }
    return loading;
  }

  /** Модель этого вида уже готова — иначе кадр уходит без сегментации, пока она грузится. */
  ready(model: SegmenterModel): ImageSegmenter | null {
    const loading = this.segmenters.get(model);
    if (!loading) return null;
    return (loading as Promise<ImageSegmenter> & { value?: ImageSegmenter }).value ?? null;
  }

  /**
   * Посчитать маску человека для кадра и отдать её текстуру в `use` — синхронно, пока результат жив.
   * Метка времени для модели — строго растущая: MediaPipe в режиме VIDEO требует порядка.
   */
  segment(segmenter: ImageSegmenter, frame: VideoFrame, use: (mask: MaskTexture) => void): void {
    if (this.closed) return;
    const now = Math.max(performance.now(), this.lastStamp + 1);
    this.lastStamp = now;
    segmenter.segmentForVideo(frame, now, (result) => {
      try {
        // Selfie Segmenter: категория 0 — фон, 1 — человек; маска уверенности — по категориям.
        const masks = result.confidenceMasks;
        const mask = masks?.[masks.length - 1];
        if (mask) use({ texture: mask.getAsWebGLTexture(), width: mask.width, height: mask.height });
      } finally {
        result.close();
      }
    });
  }

  async dispose() {
    this.closed = true;
    for (const loading of this.segmenters.values()) await loading.then((s) => s.close()).catch(() => {});
    this.segmenters.clear();
  }
}

/**
 * Готовность обещания без ожидания: `ready()` зовётся на каждом кадре, а `await` там — лишний такт.
 * Запоминаем значение на самом обещании, когда оно исполнится.
 */
export function remember<T>(promise: Promise<T>): Promise<T> & { value?: T } {
  const tracked = promise as Promise<T> & { value?: T };
  void promise.then((value) => {
    tracked.value = value;
  });
  return tracked;
}
