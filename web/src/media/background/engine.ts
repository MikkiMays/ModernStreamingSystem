import { BLUR_SIGMA, Budget, modelFor, type BudgetState } from './budget';
import { Pipeline } from './pipeline';
import { Segmenter, type SegmenterAssets } from './segmenter';

/**
 * Движок фона: один кадр на входе — один кадр на выходе (R186, Р-89).
 *
 * Живёт там, где идут кадры: в воркере (`background.worker.ts`) или на главном потоке, если воркер
 * недоступен (`effect.ts`). Сам не знает ни о дорожках, ни о LiveKit: получает `VideoFrame`, отдаёт
 * `VideoFrame`. Порядок на кадре: загрузить кадр в конвейер → если сторож бюджета велит — посчитать
 * модель и уточнить маску → свести с фоном → новый кадр с той же меткой времени.
 *
 * Пока модель грузится, кадр **не уходит сырым** (ревью R186, A10): сводится с пустой маской — и в
 * обоих режимах это размытие целиком (R189, И5, `pipeline.ts` → `NO_MASK_LOOK`), а не картинка поверх
 * человека: у тёмной картинки это выглядело «чёрной камерой». Комнату за спиной лучше не показать
 * лишнюю секунду, чем показать.
 * Фон «нет» — кадр как есть. Своё и чужое время считается на каждом кадре и идёт в сторож (`Budget`) и
 * в статистику.
 *
 * Потеря контекста WebGL (A6): по `webglcontextlost` движок пропускает кадры как есть, по
 * `webglcontextrestored` (или при следующем источнике, если контекст уже вернулся) собирает конвейер
 * и модель заново — движок живёт всю страницу, и один сброс видеокарты не должен выключить фон до
 * перезагрузки.
 */
export type EngineChoice =
  | { mode: 'none' }
  | { mode: 'blur'; strength: keyof typeof BLUR_SIGMA }
  | { mode: 'image'; image: ImageBitmap };

export interface EngineStats extends BudgetState {
  /** Кадров на выходе за последнюю секунду. */
  fps: number;
  /** Средняя цена одного прогона модели, мс. */
  segmentMs: number;
  /** Идёт ли обработка (модель готова и фон выбран). */
  active: boolean;
}

export class Engine {
  private pipeline: Pipeline;
  private segmenter: Segmenter;
  private readonly budget = new Budget();
  private choice: EngineChoice = { mode: 'none' };
  private segmentMs = 0;
  private outputs = 0;
  private outputsAt = 0;
  private fps = 0;
  private disposed = false;
  /** Контекст WebGL потерян — кадры идут как есть, пока не вернётся. */
  private lost = false;
  /** Сторож сменил ступень — сказать наружу (журнал, диагностика). */
  onLevel?: (state: BudgetState) => void;
  /** Модель не загрузилась — наружу: воркер отчитается странице, та перейдёт на главный поток. */
  onError?: (error: unknown) => void;

  constructor(
    private readonly canvas: OffscreenCanvas | HTMLCanvasElement,
    private readonly assets: SegmenterAssets,
  ) {
    this.pipeline = new Pipeline(canvas);
    this.segmenter = new Segmenter(canvas, assets);
    canvas.addEventListener('webglcontextlost', this.onLost as EventListener);
    canvas.addEventListener('webglcontextrestored', this.onRestored as EventListener);
  }

  private onLost = (event: Event) => {
    // Без `preventDefault` браузер не станет восстанавливать контекст.
    event.preventDefault();
    this.lost = true;
    console.warn('[cord] background webgl context lost');
  };

  private onRestored = () => {
    this.rebuild();
  };

  /** Собрать конвейер и модель заново на том же холсте (после потери контекста). */
  private rebuild() {
    if (this.disposed) return;
    const oldSegmenter = this.segmenter;
    try {
      this.pipeline.dispose();
    } catch {
      /* старый контекст мёртв — удалять нечего */
    }
    this.pipeline = new Pipeline(this.canvas);
    this.segmenter = new Segmenter(this.canvas, this.assets);
    void oldSegmenter.dispose().catch(() => {});
    this.lost = false;
    this.setChoice(this.choice);
    console.info('[cord] background webgl context restored');
  }

  /** Загрузить модель под кадр заранее — чтобы первый кадр с фоном не ждал. Отказ — наружу. */
  warm(width: number, height: number): Promise<unknown> {
    return this.segmenter.load(modelFor(width, height));
  }

  setChoice(choice: EngineChoice) {
    this.choice = choice;
    if (choice.mode === 'blur') this.pipeline.setLook({ mode: 'blur', sigma: BLUR_SIGMA[choice.strength] });
    if (choice.mode === 'image') {
      this.pipeline.setLook({ mode: 'image', sigma: BLUR_SIGMA.light });
      this.pipeline.setImage(choice.image);
    }
  }

  /** Частота источника изменилась на лету — сторожу бюджета новый интервал кадра. */
  setFrameRate(frameRate: number | undefined) {
    this.budget.setFrameRate(frameRate);
  }

  /** Новый источник кадров: прошлая маска к нему не относится; `frameRate` — его частота, если известна. */
  resetSource(frameRate?: number) {
    if (this.lost && !this.pipeline.gl.isContextLost()) this.rebuild();
    this.pipeline.resetTemporal();
    this.budget.resetSource(frameRate);
  }

  get stats(): EngineStats {
    return {
      ...this.budget.state,
      fps: this.fps,
      segmentMs: this.segmentMs,
      active: this.choice.mode !== 'none' && this.pipeline.ready,
    };
  }

  /**
   * Обработать кадр. Возвращает кадр на выход — новый (входной закрыт) или тот же, если обработки нет.
   * Исключение конвейера не роняет поток: кадр уходит как есть.
   */
  process(frame: VideoFrame): VideoFrame {
    if (this.disposed || this.lost || this.choice.mode === 'none') return frame;
    // Картинка ещё не загружена — размывать нечем и закрывать нечем: как есть, это миг после выбора.
    if (this.choice.mode === 'image' && !this.pipeline.hasImage) return frame;
    const model = modelFor(frame.displayWidth, frame.displayHeight);
    const segmenter = this.segmenter.ready(model);
    if (!segmenter) void this.segmenter.load(model).catch((error) => this.onError?.(error));
    const started = performance.now();
    try {
      this.pipeline.upload(frame);
      // Первую маску ждём во что бы то ни стало: без неё сводить не с чем — до неё маска пустая,
      // и кадр уходит целиком размытым, а не сырым и не закрытым картинкой.
      if (segmenter && (this.budget.shouldSegment() || !this.pipeline.ready)) {
        const t = performance.now();
        this.segmenter.segment(segmenter, frame, (mask) =>
          this.pipeline.refineMask(mask.texture, mask.width, mask.height),
        );
        const cost = performance.now() - t;
        this.segmentMs = this.segmentMs ? this.segmentMs * 0.8 + cost * 0.2 : cost;
      }
      this.pipeline.render();
      const stamp = frame.timestamp;
      const output = new VideoFrame(this.pipeline.canvas, { timestamp: stamp, alpha: 'discard' });
      frame.close();
      this.count(stamp / 1000, started);
      return output;
    } catch (error) {
      console.warn('[cord] background frame failed', error);
      return frame;
    }
  }

  private count(stampMs: number, started: number) {
    const now = performance.now();
    if (this.budget.record(stampMs, now - started)) this.onLevel?.(this.budget.state);
    this.outputs++;
    if (now - this.outputsAt >= 1000) {
      this.fps = this.outputsAt ? Math.round((this.outputs * 1000) / (now - this.outputsAt)) : this.outputs;
      this.outputs = 0;
      this.outputsAt = now;
    }
  }

  async dispose() {
    this.disposed = true;
    this.canvas.removeEventListener('webglcontextlost', this.onLost as EventListener);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored as EventListener);
    await this.segmenter.dispose();
    this.pipeline.dispose();
  }
}
