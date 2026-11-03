import { Store } from '../../core/store';
import {
  allowed,
  builtinBackgroundUrl,
  customBackgroundUrl,
  type BackgroundChoice,
  type BackgroundSupport,
} from '../background-effect';
import type { Engine, EngineChoice, EngineStats } from './engine';
import type { FromWorker, ToWorker } from './protocol';
import type { SegmenterAssets } from './segmenter';

/**
 * Фон в видео на странице (R186, Р-89): один движок на страницу, который принимает дорожку камеры и
 * отдаёт обработанную. Им пользуются предвход (превью), настройки «Видео» вне встречи и встреча
 * (через `CordBackgroundProcessor` у LiveKit) — модель грузится один раз и живёт до закрытия страницы,
 * смена камеры, включение и выключение её не трогают.
 *
 * Где идут кадры — выбирается по возможностям браузера, от лучшего к худшему:
 * 1. **воркер** — `MediaStreamTrackProcessor`/`MediaStreamTrackGenerator`, потоки переданы владением;
 *    главный поток свободен (Chrome, Edge, Electron, Android Chrome);
 * 2. **главный поток, те же потоки** — воркер не поднялся (dev-сервер Vite отдаёт воркер модулем,
 *    а MediaPipe грузится только через `importScripts`; или потоки непередаваемы);
 * 3. **холст** — `<video>` → `VideoFrame` → холст → `captureStream()` (Safari, Firefox): кадры идут
 *    по `requestVideoFrameCallback`, а в скрытой вкладке — реже, как у прежнего обработчика.
 */
type TrackProcessorCtor = new (init: { track: MediaStreamTrack }) => {
  readable: ReadableStream<VideoFrame>;
};
type TrackGeneratorCtor = new (init: { kind: 'video' }) => MediaStreamTrack & {
  writable: WritableStream<VideoFrame>;
};
const streams = () => {
  const g = globalThis as {
    MediaStreamTrackProcessor?: TrackProcessorCtor;
    MediaStreamTrackGenerator?: TrackGeneratorCtor;
  };
  return g.MediaStreamTrackProcessor && g.MediaStreamTrackGenerator
    ? { Processor: g.MediaStreamTrackProcessor, Generator: g.MediaStreamTrackGenerator }
    : null;
};

export type Transport = 'worker' | 'main' | 'canvas';
export interface BackgroundStats extends EngineStats {
  transport: Transport;
}

function assets(): SegmenterAssets {
  const origin = location.origin;
  return {
    wasm: `${origin}/mediapipe/wasm`,
    models: {
      landscape: `${origin}/mediapipe/selfie_segmenter_landscape.tflite`,
      square: `${origin}/mediapipe/selfie_segmenter.tflite`,
    },
  };
}

/** Что сказать движку под выбор: картинка — растровым `ImageBitmap` (в воркер — владением). */
async function engineChoice(choice: BackgroundChoice): Promise<EngineChoice> {
  if (choice.kind === 'blur') return { mode: 'blur', strength: choice.strength };
  if (choice.kind === 'image') {
    const url = choice.id === 'custom' ? await customBackgroundUrl() : await builtinBackgroundUrl(choice.id);
    if (!url) return { mode: 'none' };
    const image = await createImageBitmap(await (await fetch(url)).blob());
    return { mode: 'image', image };
  }
  return { mode: 'none' };
}

interface Attached {
  source: MediaStreamTrack;
  output: MediaStreamTrack;
  stop: () => void;
}

/** Путь кадров: воркер, главный поток или холст. Один живой на страницу. */
interface Path {
  readonly kind: Transport;
  attach(source: MediaStreamTrack): Promise<Attached>;
  choice(choice: EngineChoice): void;
  warm(width: number, height: number): void;
  stop(): void;
}

const READY_TIMEOUT_MS = 20_000;

class WorkerPath implements Path {
  readonly kind = 'worker';
  private readonly worker: Worker;
  private attached: Attached | null = null;
  private pending: { resolve: () => void; reject: (e: Error) => void } | null = null;
  /** Поднялся: ошибки до этого решает `start()` (отказ), после — `onError` (переезд на главный поток). */
  private started = false;
  constructor(
    private readonly onStats: (stats: EngineStats) => void,
    private readonly onError: (message: string) => void,
  ) {
    // Классический воркер (без `type: 'module'`): MediaPipe грузит wasm через `importScripts`.
    this.worker = new Worker(new URL('./background.worker.ts', import.meta.url));
    this.worker.onmessage = (event: MessageEvent<FromWorker>) => {
      const message = event.data;
      if (message.type === 'ready') this.pending?.resolve();
      else if (message.type === 'error') {
        if (this.started) this.onError(message.message);
        else this.pending?.reject(new Error(message.message));
      } else if (message.type === 'stats') this.onStats(message.stats);
      else if (message.type === 'level') console.info('[cord] background level (worker)', message.state);
    };
    this.worker.onerror = (event) => {
      // Ошибка воркера иначе всплывает в `window.onerror` и считается ошибкой приложения — а это
      // штатный отказ пути: движок поднимется на главном потоке.
      event.preventDefault();
      const text = event.message || 'worker failed';
      if (this.started) this.onError(text);
      else this.pending?.reject(new Error(text));
    };
  }
  /** Поднять движок в воркере; `ready` или ошибка — иначе через `READY_TIMEOUT_MS` считаем мёртвым. */
  start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('background worker timeout')), READY_TIMEOUT_MS);
      this.pending = {
        resolve: () => {
          clearTimeout(timer);
          this.started = true;
          resolve();
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      this.post({ type: 'init', assets: assets() });
    }).finally(() => {
      this.pending = null;
    });
  }
  async attach(source: MediaStreamTrack): Promise<Attached> {
    const api = streams();
    if (!api) throw new Error('insertable streams');
    this.attached?.stop();
    const processor = new api.Processor({ track: source });
    const generator = new api.Generator({ kind: 'video' });
    const { frameRate } = source.getSettings();
    this.post({ type: 'source', readable: processor.readable, writable: generator.writable, frameRate }, [
      processor.readable,
      generator.writable,
    ]);
    const attached: Attached = {
      source,
      output: generator,
      stop: () => {
        if (this.attached === attached) {
          this.attached = null;
          this.post({ type: 'detach' });
        }
        generator.stop();
      },
    };
    this.attached = attached;
    return attached;
  }
  choice(choice: EngineChoice) {
    this.post({ type: 'choice', choice }, choice.mode === 'image' ? [choice.image] : []);
  }
  warm(width: number, height: number) {
    this.post({ type: 'warm', width, height });
  }
  stop() {
    this.attached?.stop();
    this.post({ type: 'stop' });
    // Воркер закрывается сам после `stop`; на всякий случай — через секунду принудительно.
    setTimeout(() => this.worker.terminate(), 1000);
  }
  private post(message: ToWorker, transfer: Transferable[] = []) {
    this.worker.postMessage(message, transfer);
  }
}

/** Движок на главном потоке: общее для путей «главный поток» и «холст». */
abstract class LocalPath implements Path {
  abstract readonly kind: Transport;
  protected engine: Engine | null = null;
  protected attached: Attached | null = null;
  private statsTimer: ReturnType<typeof setInterval> | undefined;
  constructor(protected readonly onStats: (stats: EngineStats) => void) {}
  async start() {
    const { Engine } = await import('./engine');
    const canvas =
      typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(2, 2) : document.createElement('canvas');
    this.engine = new Engine(canvas, assets());
    this.engine.onLevel = (state) => console.info(`[cord] background level (${this.kind})`, state);
    this.statsTimer = setInterval(() => this.engine && this.onStats(this.engine.stats), 1000);
  }
  abstract attach(source: MediaStreamTrack): Promise<Attached>;
  choice(choice: EngineChoice) {
    this.engine?.setChoice(choice);
  }
  warm(width: number, height: number) {
    void this.engine?.warm(width, height);
  }
  stop() {
    this.attached?.stop();
    clearInterval(this.statsTimer);
    void this.engine?.dispose();
    this.engine = null;
  }
}

class MainPath extends LocalPath {
  readonly kind = 'main';
  async attach(source: MediaStreamTrack): Promise<Attached> {
    const api = streams();
    const engine = this.engine;
    if (!api || !engine) throw new Error('insertable streams');
    this.attached?.stop();
    const processor = new api.Processor({ track: source });
    const generator = new api.Generator({ kind: 'video' });
    const abort = new AbortController();
    engine.resetSource(source.getSettings().frameRate);
    processor.readable
      .pipeThrough(
        new TransformStream<VideoFrame, VideoFrame>({
          transform(frame, controller) {
            controller.enqueue(engine.process(frame));
          },
        }),
        { signal: abort.signal },
      )
      .pipeTo(generator.writable, { signal: abort.signal })
      .catch(() => {});
    const attached: Attached = {
      source,
      output: generator,
      stop: () => {
        abort.abort();
        generator.stop();
        if (this.attached === attached) this.attached = null;
      },
    };
    this.attached = attached;
    return attached;
  }
}

/**
 * Путь через холст — для браузеров без `MediaStreamTrackProcessor`: кадр из `<video>`, результат на
 * холст, с холста — `captureStream()`. Холст — в документе, но невидим: Safari не снимает кадры с
 * холста вне документа.
 */
class CanvasPath extends LocalPath {
  readonly kind = 'canvas';
  async attach(source: MediaStreamTrack): Promise<Attached> {
    const engine = this.engine;
    if (!engine) throw new Error('engine');
    this.attached?.stop();
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([source]);
    const canvas = document.createElement('canvas');
    canvas.style.cssText =
      'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
    document.body.append(canvas);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('canvas');
    const { frameRate } = source.getSettings();
    engine.resetSource(frameRate);
    const output = canvas.captureStream(frameRate || 30).getVideoTracks()[0];
    if (!output) throw new Error('captureStream');
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      if (!alive) return;
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth) {
        if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
        }
        const frame = new VideoFrame(video, { timestamp: Math.round(video.currentTime * 1e6) });
        const processed = engine.process(frame);
        context.drawImage(processed, 0, 0, canvas.width, canvas.height);
        processed.close();
      }
      schedule();
    };
    const schedule = () => {
      if (!alive) return;
      if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(tick);
      else timer = setTimeout(tick, 1000 / (frameRate || 30));
    };
    void video.play().then(schedule, schedule);
    const attached: Attached = {
      source,
      output,
      stop: () => {
        alive = false;
        clearTimeout(timer);
        video.pause();
        video.srcObject = null;
        output.stop();
        canvas.remove();
        if (this.attached === attached) this.attached = null;
      },
    };
    this.attached = attached;
    return attached;
  }
}

/** Может ли воркер взять потоки кадров: оба конструктора и передаваемые потоки. */
function workerCapable(): boolean {
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || !streams()) return false;
  try {
    const { port1 } = new MessageChannel();
    const stream = new ReadableStream();
    port1.postMessage(stream, [stream]);
    port1.close();
    return true;
  } catch {
    return false;
  }
}

let shared: BackgroundEffect | null = null;

export class BackgroundEffect {
  /** Один движок на страницу. */
  static shared(): BackgroundEffect {
    return (shared ??= new BackgroundEffect());
  }

  /** Статистика движка — для журнала и диагностики; `null` — движок ещё не поднят. */
  readonly stats = new Store<BackgroundStats | null>(null);
  private path: Promise<Path> | null = null;
  private attached: Attached | null = null;
  private choice: BackgroundChoice = { kind: 'none' };
  private release: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  /** Воркер однажды не поднялся — больше не пробовать на этой странице. */
  private workerBroken = false;

  /**
   * Поставить фон на дорожку: вернуть обработанную. Та же дорожка — только смена выбора, та же
   * обработанная дорожка. Другая дорожка — прежняя обработанная останавливается (её потребитель уже
   * ушёл или сейчас заменит её сам).
   */
  attach(
    source: MediaStreamTrack,
    choice: BackgroundChoice,
    support: BackgroundSupport,
  ): Promise<MediaStreamTrack> {
    return this.enqueue(async () => {
      clearTimeout(this.release);
      const path = await this.ensurePath();
      if (this.attached?.source !== source) {
        this.attached?.stop();
        this.attached = null;
        const { width, height } = source.getSettings();
        if (width && height) path.warm(width, height);
        this.attached = await path.attach(source);
      }
      await this.apply(path, allowed(choice, support) ? choice : { kind: 'none' });
      return this.attached.output;
    });
  }

  /** Сменить выбор у уже поставленной дорожки. */
  setChoice(choice: BackgroundChoice, support: BackgroundSupport): Promise<void> {
    return this.enqueue(async () => {
      const path = await this.ensurePath();
      await this.apply(path, allowed(choice, support) ? choice : { kind: 'none' });
    });
  }

  /**
   * Снять фон с дорожки. `lazy` — не сразу, а через такт: React сначала чистит прежний эффект, потом
   * ставит новый, и немедленное снятие пересобирало бы потоки на каждую смену выбора.
   */
  detach(source?: MediaStreamTrack, lazy = false) {
    const stop = () => {
      void this.enqueue(async () => {
        if (!this.attached || (source && this.attached.source !== source)) return;
        this.attached.stop();
        this.attached = null;
      });
    };
    clearTimeout(this.release);
    if (lazy) this.release = setTimeout(stop, 0);
    else stop();
  }

  /** Дорожка, которая обрабатывается сейчас, — чтобы не ставить второй захват поверх. */
  get source(): MediaStreamTrack | null {
    return this.attached?.source ?? null;
  }

  dispose() {
    void this.enqueue(async () => {
      this.attached?.stop();
      this.attached = null;
      const path = await this.path?.catch(() => null);
      path?.stop();
      this.path = null;
      this.stats.set(null);
    });
    if (shared === this) shared = null;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => {}).then(task);
    this.queue = next;
    return next;
  }

  private async apply(path: Path, choice: BackgroundChoice) {
    if (JSON.stringify(choice) === JSON.stringify(this.choice) && choice.kind !== 'image') return;
    this.choice = choice;
    path.choice(await engineChoice(choice));
  }

  private ensurePath(): Promise<Path> {
    return (this.path ??= this.openPath());
  }

  private async openPath(): Promise<Path> {
    const onStats = (kind: Transport) => (stats: EngineStats) =>
      this.stats.set({ ...stats, transport: kind });
    if (!this.workerBroken && workerCapable()) {
      const worker = new WorkerPath(onStats('worker'), (message) => this.workerFailed(message));
      try {
        await worker.start();
        return worker;
      } catch (error) {
        worker.stop();
        this.workerBroken = true;
        console.warn('[cord] background worker unavailable, running on the main thread', error);
      }
    }
    const local = streams() ? new MainPath(onStats('main')) : new CanvasPath(onStats('canvas'));
    await local.start();
    return local;
  }

  /**
   * Воркер упал уже в работе (чаще всего — не смог загрузить модель: dev-сервер Vite отдаёт воркер
   * модулем, где нет `importScripts`): поднять движок на главном потоке и переставить дорожку.
   */
  private workerFailed(message: string) {
    if (this.workerBroken) return;
    this.workerBroken = true;
    console.warn('[cord] background worker failed, running on the main thread:', message);
    void this.enqueue(async () => {
      const previous = await this.path?.catch(() => null);
      previous?.stop();
      this.path = null;
      const attached = this.attached;
      this.attached = null;
      const choice = this.choice;
      this.choice = { kind: 'none' };
      if (!attached) return;
      const path = await this.ensurePath();
      this.attached = await path.attach(attached.source);
      await this.apply(path, choice);
      // Потребитель держит прежнюю обработанную дорожку — она остановлена; скажем, что есть новая.
      this.onReplaced?.(attached.source, this.attached.output);
    });
  }

  /** Обработанная дорожка сменилась не по просьбе потребителя (переезд с воркера на главный поток). */
  onReplaced?: (source: MediaStreamTrack, output: MediaStreamTrack) => void;
}
