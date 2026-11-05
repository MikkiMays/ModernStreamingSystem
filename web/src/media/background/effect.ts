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
 *    по `requestVideoFrameCallback`, в скрытой вкладке — по таймеру.
 *
 * **Выходная дорожка принадлежит странице и устойчива** (ревью R186, A1): генератор кадров создаётся
 * здесь и живёт, пока держатель не снимет фон; воркер и главный поток только пишут в него через
 * сток (`WritableStream`). Поэтому переезд с воркера на главный поток, смена камеры, включение после
 * выключения не меняют `processedTrack` у LiveKit — отправитель и клон у запасного кодека продолжают
 * получать кадры, а не замирают на последнем.
 *
 * **Держатели** (A2): `processor` — обработчик дорожки встречи, `preview` — превью предвхода и
 * настроек. Движок обслуживает один источник; превью никогда не отбирает его у обработчика: получает
 * сырую дорожку. Обработчик превью отбирает.
 */
type TrackProcessorCtor = new (init: { track: MediaStreamTrack }) => {
  readable: ReadableStream<VideoFrame>;
};
type TrackGeneratorCtor = new (init: { kind: 'video' }) => MediaStreamTrack & {
  writable: WritableStream<VideoFrame>;
};
export type StreamApis = { Processor: TrackProcessorCtor; Generator: TrackGeneratorCtor } | null;
const streams = (): StreamApis => {
  const g = globalThis as {
    MediaStreamTrackProcessor?: TrackProcessorCtor;
    MediaStreamTrackGenerator?: TrackGeneratorCtor;
  };
  return g.MediaStreamTrackProcessor && g.MediaStreamTrackGenerator
    ? { Processor: g.MediaStreamTrackProcessor, Generator: g.MediaStreamTrackGenerator }
    : null;
};

export type Transport = 'worker' | 'main' | 'canvas';
export type Owner = 'processor' | 'preview';
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

/**
 * Картинки фонов, уже раскодированные (A11): по адресу — один `ImageBitmap` на страницу; движку
 * каждый раз уходит копия (воркер забирает её владением, конвейер закрывает после загрузки в текстуру).
 */
const images = new Map<string, Promise<ImageBitmap>>();
const IMAGES_KEPT = 8;
async function imageFor(url: string): Promise<ImageBitmap> {
  let master = images.get(url);
  if (!master) {
    master = fetch(url)
      .then((r) => r.blob())
      .then((blob) => createImageBitmap(blob));
    master.catch(() => images.delete(url));
    images.set(url, master);
    if (images.size > IMAGES_KEPT) {
      const [oldest] = images.keys();
      if (oldest !== undefined) {
        void images.get(oldest)?.then(
          (b) => b.close(),
          () => {},
        );
        images.delete(oldest);
      }
    }
  }
  return createImageBitmap(await master);
}

/** Что сказать движку под выбор: картинка — растровым `ImageBitmap` (в воркер — владением). */
async function engineChoice(choice: BackgroundChoice): Promise<EngineChoice> {
  if (choice.kind === 'blur') return { mode: 'blur', strength: choice.strength };
  if (choice.kind === 'image') {
    const url = choice.id === 'custom' ? await customBackgroundUrl() : await builtinBackgroundUrl(choice.id);
    if (!url) return { mode: 'none' };
    return { mode: 'image', image: await imageFor(url) };
  }
  return { mode: 'none' };
}

/** Идущая обработка одного источника. `output` — только у пути через холст (свой захват с холста). */
interface Running {
  output: MediaStreamTrack | null;
  /** Кадров ушло в выход — сторожу живости (R189, И5). */
  frames: () => number;
  stop: () => Promise<void>;
}

/** Закрыть кадр, если это кадр (в тестах — заглушки без `close`). */
const closeFrame = (frame: VideoFrame) => {
  (frame as { close?: () => void }).close?.();
};

/**
 * Кадры из воркера — в сток страницы владением через `MessagePort` (R189, И5). Напор — сбросом: пока
 * прошлый кадр пишется в генератор, следующий закрывается, а не ждёт в очереди; в эфире это один
 * пропущенный кадр, а не растущая задержка.
 */
function receiveFrames(sink: WritableStream<VideoFrame>): {
  port: MessagePort;
  frames: () => number;
  dropped: () => number;
  stop: () => void;
} {
  const channel = new MessageChannel();
  const writer = sink.getWriter();
  let busy = false;
  let alive = true;
  let frames = 0;
  let dropped = 0;
  channel.port1.onmessage = (event: MessageEvent<VideoFrame>) => {
    const frame = event.data;
    if (!alive || busy) {
      if (alive) dropped++;
      closeFrame(frame);
      return;
    }
    busy = true;
    frames++;
    writer
      .write(frame)
      .catch(() => closeFrame(frame))
      .finally(() => {
        busy = false;
      });
  };
  return {
    port: channel.port2,
    frames: () => frames,
    dropped: () => dropped,
    stop: () => {
      alive = false;
      channel.port1.onmessage = null;
      channel.port1.close();
      try {
        writer.releaseLock();
      } catch {
        /* писатель уже отпущен */
      }
    },
  };
}

/** Путь кадров: воркер, главный поток или холст. Один живой на страницу. */
interface Path {
  readonly kind: Transport;
  /** Пустить кадры `source` через движок в `sink` (сток генератора страницы); без стока — путь через холст. */
  run(source: MediaStreamTrack, sink: WritableStream<VideoFrame> | null): Promise<Running>;
  choice(choice: EngineChoice): void;
  warm(width: number, height: number): void;
  frameRate(frameRate: number | undefined): void;
  stop(): Promise<void>;
}

/** Параметры pipeTo в сток страницы: сток переживает и остановку, и ошибку, и конец источника. */
const KEEP_SINK = { preventClose: true, preventAbort: true, preventCancel: true } as const;

const READY_TIMEOUT_MS = 20_000;

/** Воркер — как его видит путь; в тестах подменяется. */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

/** Что подменяют тесты: API потоков, возможность воркера и сам воркер. */
export interface EffectEnv {
  streams: () => StreamApis;
  workerCapable: () => boolean;
  worker: () => WorkerLike;
}

class WorkerPath implements Path {
  readonly kind = 'worker';
  private readonly worker: WorkerLike;
  private pending: { resolve: () => void; reject: (e: Error) => void } | null = null;
  /** Поднялся: ошибки до этого решает `start()` (отказ), после — `onError` (переезд на главный поток). */
  private started = false;
  constructor(
    private readonly env: EffectEnv,
    private readonly onStats: (stats: EngineStats) => void,
    private readonly onError: (message: string) => void,
  ) {
    this.worker = env.worker();
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
  async run(source: MediaStreamTrack, sink: WritableStream<VideoFrame> | null): Promise<Running> {
    const api = this.env.streams();
    if (!api || !sink) throw new Error('insertable streams');
    const processor = new api.Processor({ track: source });
    // Воркер получает поток источника владением, а обработанные кадры возвращает владением через порт
    // (И5); генератор остаётся у страницы.
    const receiver = receiveFrames(sink);
    this.post(
      {
        type: 'source',
        readable: processor.readable,
        port: receiver.port,
        frameRate: source.getSettings().frameRate,
      },
      [processor.readable, receiver.port],
    );
    return {
      output: null,
      frames: receiver.frames,
      stop: async () => {
        this.post({ type: 'detach' });
        receiver.stop();
      },
    };
  }
  choice(choice: EngineChoice) {
    this.post({ type: 'choice', choice }, choice.mode === 'image' ? [choice.image] : []);
  }
  warm(width: number, height: number) {
    this.post({ type: 'warm', width, height });
  }
  frameRate(frameRate: number | undefined) {
    this.post({ type: 'rate', frameRate });
  }
  async stop() {
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
  private statsTimer: ReturnType<typeof setInterval> | undefined;
  constructor(
    protected readonly env: EffectEnv,
    protected readonly onStats: (stats: EngineStats) => void,
  ) {}
  async start() {
    const { Engine } = await import('./engine');
    const canvas =
      typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(2, 2) : document.createElement('canvas');
    this.engine = new Engine(canvas, assets());
    this.engine.onLevel = (state) => console.info(`[cord] background level (${this.kind})`, state);
    // Модель — заранее, как в воркере (R189): пока она грузится, кадры уходят размытыми целиком.
    void this.engine.warm(1280, 720).catch(() => {});
    this.statsTimer = setInterval(() => this.engine && this.onStats(this.engine.stats), 1000);
  }
  abstract run(source: MediaStreamTrack, sink: WritableStream<VideoFrame> | null): Promise<Running>;
  choice(choice: EngineChoice) {
    this.engine?.setChoice(choice);
  }
  warm(width: number, height: number) {
    void this.engine?.warm(width, height).catch(() => {});
  }
  frameRate(frameRate: number | undefined) {
    this.engine?.setFrameRate(frameRate);
  }
  async stop() {
    clearInterval(this.statsTimer);
    const engine = this.engine;
    this.engine = null;
    await engine?.dispose();
  }
}

class MainPath extends LocalPath {
  readonly kind = 'main';
  async run(source: MediaStreamTrack, sink: WritableStream<VideoFrame> | null): Promise<Running> {
    const api = this.env.streams();
    const engine = this.engine;
    if (!api || !sink || !engine) throw new Error('insertable streams');
    const processor = new api.Processor({ track: source });
    const abort = new AbortController();
    engine.resetSource(source.getSettings().frameRate);
    let frames = 0;
    const done = processor.readable
      .pipeThrough(
        new TransformStream<VideoFrame, VideoFrame>({
          transform(frame, controller) {
            frames++;
            controller.enqueue(engine.process(frame));
          },
        }),
        { signal: abort.signal },
      )
      .pipeTo(sink, { ...KEEP_SINK, signal: abort.signal })
      .catch(() => {});
    return {
      output: null,
      frames: () => frames,
      stop: async () => {
        abort.abort();
        await done;
      },
    };
  }
}

/** Сколько ждать кадра на пути через холст, прежде чем нарисовать сырой кадр самим (сторож, A5). */
const CANVAS_WATCHDOG_MS = 1000;

/**
 * Путь через холст — для браузеров без `MediaStreamTrackProcessor`: кадр из `<video>`, результат на
 * холст, с холста — `captureStream()`. Холст — в документе, но невидим: Safari не снимает кадры с
 * холста вне документа. Кадры — по `requestVideoFrameCallback`; в скрытой вкладке он не зовётся —
 * тогда по таймеру. Сторож раз в секунду: если ничего не нарисовано, рисует сырой кадр и будит цикл —
 * дорожка в эфире не замирает, даже если движок споткнулся.
 */
class CanvasPath extends LocalPath {
  readonly kind = 'canvas';
  async run(source: MediaStreamTrack): Promise<Running> {
    const engine = this.engine;
    if (!engine) throw new Error('engine');
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
    engine.resetSource(source.getSettings().frameRate);
    const output = canvas.captureStream().getVideoTracks()[0];
    if (!output) throw new Error('captureStream');
    let alive = true;
    let armed = false;
    let drawnAt = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fit = () => {
      if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
      }
    };
    const hasFrame = () => video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0;
    let drawn = 0;
    const tick = () => {
      armed = false;
      if (!alive) return;
      let frame: VideoFrame | null = null;
      let processed: VideoFrame | null = null;
      try {
        if (hasFrame()) {
          fit();
          frame = new VideoFrame(video, { timestamp: Math.round(video.currentTime * 1e6) });
          processed = engine.process(frame);
          context.drawImage(processed, 0, 0, canvas.width, canvas.height);
          drawnAt = performance.now();
          drawn++;
        }
      } catch (error) {
        console.warn('[cord] background canvas frame failed', error);
        try {
          if (hasFrame()) context.drawImage(video, 0, 0, canvas.width, canvas.height);
        } catch {
          /* нарисовать не вышло — сторож попробует через секунду */
        }
      } finally {
        // Входной кадр движок закрывает сам, когда отдаёт новый; тот же объект — закрыть один раз.
        processed?.close();
        if (frame && frame !== processed) frame.close();
        schedule();
      }
    };
    const schedule = () => {
      if (!alive || armed) return;
      armed = true;
      const interval = 1000 / (source.getSettings().frameRate || 30);
      if (!document.hidden && 'requestVideoFrameCallback' in video) video.requestVideoFrameCallback(tick);
      else timer = setTimeout(tick, interval);
    };
    const watchdog = setInterval(() => {
      if (!alive || performance.now() - drawnAt < CANVAS_WATCHDOG_MS) return;
      try {
        if (hasFrame()) {
          fit();
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
        }
      } catch {
        /* кадра нет — пусть остаётся прошлый */
      }
      armed = false;
      schedule();
    }, CANVAS_WATCHDOG_MS);
    void video.play().then(schedule, schedule);
    return {
      output,
      frames: () => drawn,
      stop: async () => {
        alive = false;
        clearTimeout(timer);
        clearInterval(watchdog);
        video.pause();
        video.srcObject = null;
        output.stop();
        canvas.remove();
      },
    };
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

const defaultEnv: EffectEnv = {
  streams,
  workerCapable,
  // Классический воркер (без `type: 'module'`): MediaPipe грузит wasm через `importScripts`.
  worker: () => new Worker(new URL('./background.worker.ts', import.meta.url)),
};

interface Attachment {
  owner: Owner;
  source: MediaStreamTrack;
  /** Выходная дорожка держателя — генератор страницы (или захват холста). */
  output: MediaStreamTrack;
  sink: WritableStream<VideoFrame> | null;
  running: Running | null;
  /** Частота источника, о которой знает движок; меняется на лету (`enforceCameraRate`, A9). */
  frameRate: number | undefined;
  rateTimer: ReturnType<typeof setInterval>;
  /** Сторож живости (R189, И5): кадров на прошлом такте, с каких пор тихо, подряд застываний. */
  liveTimer: ReturnType<typeof setInterval>;
  lastFrames: number;
  quietSince: number | null;
  flowingSince: number | null;
  stalls: number;
}

/** Что случилось с конвейером держателя — сессии (журнал, снятие фона). */
export interface EffectEvent {
  kind: 'stalled' | 'dropped';
  owner: Owner;
  transport: Transport;
  at: number;
}

/** Выход молчит при живом источнике дольше этого — застывание. */
export const STALL_MS = 3_000;
/** Столько застываний подряд — конвейер снимается: живая камера важнее фона (И5). */
export const STALLS_TO_DROP = 3;
/** Столько кадры шли без застываний — счёт застываний обнуляется. */
const FLOWING_MS = 15_000;

/** Как часто сверять частоту источника с тем, что знает сторож бюджета. */
const RATE_POLL_MS = 2000;

let shared: BackgroundEffect | null = null;

export class BackgroundEffect {
  /** Один движок на страницу. */
  static shared(): BackgroundEffect {
    return (shared ??= new BackgroundEffect());
  }

  /** Статистика движка — для журнала и диагностики; `null` — движок ещё не поднят. */
  readonly stats = new Store<BackgroundStats | null>(null);
  /** Последнее происшествие конвейера (R189, И5): каждое — новый объект, подписчики видят каждое. */
  readonly events = new Store<EffectEvent | null>(null);
  private path: Promise<Path> | null = null;
  /** Каким путём идут кадры сейчас; `null` — путь ещё не открыт. */
  private transport: Transport | null = null;
  private attached: Attachment | null = null;
  private choice: BackgroundChoice = { kind: 'none' };
  private release: ReturnType<typeof setTimeout> | undefined;
  /** Номер последнего `attach`: ленивое снятие, назначенное до него, уже не актуально (A3). */
  private generation = 0;
  private queue: Promise<unknown> = Promise.resolve();
  /** Воркер однажды не поднялся — больше не пробовать на этой странице. */
  private workerBroken = false;

  constructor(private readonly env: EffectEnv = defaultEnv) {}

  /**
   * Поставить фон на дорожку и вернуть обработанную. У того же держателя та же дорожка — только смена
   * выбора; другая дорожка — тот же выход, новый источник (генератор страницы не меняется). Превью не
   * отбирает движок у обработчика встречи — получает сырую дорожку (A2).
   */
  attach(
    source: MediaStreamTrack,
    choice: BackgroundChoice,
    support: BackgroundSupport,
    owner: Owner = 'preview',
  ): Promise<MediaStreamTrack> {
    // Ленивое снятие, назначенное прежним эффектом React, отменяется сразу, а не в очереди (A3).
    clearTimeout(this.release);
    this.release = undefined;
    this.generation++;
    return this.enqueue(async () => {
      const current = this.attached;
      if (current && current.owner !== owner) {
        if (owner === 'preview') return source;
        await this.stopAttachment(current);
      }
      const path = await this.ensurePath();
      const wanted = allowed(choice, support) ? choice : ({ kind: 'none' } as BackgroundChoice);
      if (this.attached?.source !== source) {
        const { width, height } = source.getSettings();
        if (width && height) path.warm(width, height);
        if (this.attached && this.attached.sink) {
          // Тот же держатель, новая дорожка (смена камеры, включение после выключения): новый источник
          // в тот же сток — `processedTrack` у LiveKit прежний, клон у запасного кодека жив.
          const attachment = this.attached;
          await attachment.running?.stop();
          attachment.running = null;
          attachment.source = source;
          attachment.frameRate = source.getSettings().frameRate;
          attachment.running = await path.run(source, attachment.sink);
        } else {
          if (this.attached) await this.stopAttachment(this.attached);
          this.attached = await this.open(path, owner, source);
        }
      }
      await this.apply(path, wanted);
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
   * ставит новый, и немедленное снятие пересобирало бы потоки на каждую смену выбора. Снятие, пережившее
   * новый `attach` (номер поколения другой), ничего не делает.
   */
  detach(source?: MediaStreamTrack, lazy = false) {
    const generation = this.generation;
    const stop = () => {
      void this.enqueue(async () => {
        if (generation !== this.generation) return;
        if (!this.attached || (source && this.attached.source !== source)) return;
        await this.stopAttachment(this.attached);
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

  /** Кто держит движок сейчас. */
  get owner(): Owner | null {
    return this.attached?.owner ?? null;
  }

  dispose() {
    void this.enqueue(async () => {
      if (this.attached) await this.stopAttachment(this.attached);
      const path = await this.path?.catch(() => null);
      this.path = null;
      this.transport = null;
      await path?.stop();
      this.stats.set(null);
    });
    if (shared === this) shared = null;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => {}).then(task);
    this.queue = next;
    return next;
  }

  /** Новый держатель: генератор страницы (сток) или захват с холста. */
  private async open(path: Path, owner: Owner, source: MediaStreamTrack): Promise<Attachment> {
    const api = this.env.streams();
    const generator = api ? new api.Generator({ kind: 'video' }) : null;
    const sink = generator?.writable ?? null;
    const running = await path.run(source, sink);
    const output = generator ?? running.output;
    if (!output) throw new Error('no output track');
    const attachment: Attachment = {
      owner,
      source,
      output,
      sink,
      running,
      frameRate: source.getSettings().frameRate,
      rateTimer: setInterval(() => {
        const rate = attachment.source.getSettings().frameRate;
        if (rate !== attachment.frameRate) {
          attachment.frameRate = rate;
          void this.path?.then((p) => p.frameRate(rate)).catch(() => {});
        }
      }, RATE_POLL_MS),
      liveTimer: setInterval(() => this.checkLiveness(attachment), 1000),
      lastFrames: 0,
      quietSince: null,
      flowingSince: null,
      stalls: 0,
    };
    return attachment;
  }

  /**
   * Сторож живости (R189, И5): источник жив и не заглушён, а в выход кадры не идут {@link STALL_MS} —
   * конвейер застыл (воркер завис, поток оборвался, движок молчит). Первый раз — тот же путь заново;
   * второй — с воркера на главный поток; третий — держателю: снять фон, живая камера важнее.
   */
  private checkLiveness(attachment: Attachment) {
    const running = attachment.running;
    if (!running || this.attached !== attachment) return;
    const now = Date.now();
    const frames = running.frames();
    const source = attachment.source;
    if (source.readyState !== 'live' || source.muted) {
      attachment.lastFrames = frames;
      attachment.quietSince = null;
      return;
    }
    if (frames !== attachment.lastFrames) {
      attachment.lastFrames = frames;
      attachment.quietSince = null;
      attachment.flowingSince ??= now;
      if (now - attachment.flowingSince >= FLOWING_MS) attachment.stalls = 0;
      return;
    }
    attachment.flowingSince = null;
    attachment.quietSince ??= now;
    if (now - attachment.quietSince < STALL_MS) return;
    attachment.quietSince = null;
    attachment.stalls++;
    const transport = this.transport ?? 'main';
    if (attachment.stalls >= STALLS_TO_DROP) {
      console.warn('[cord] background pipeline stalled repeatedly, dropping the effect');
      this.events.set({ kind: 'dropped', owner: attachment.owner, transport, at: now });
      return;
    }
    console.warn('[cord] background pipeline stalled, rebuilding', { stalls: attachment.stalls, transport });
    this.events.set({ kind: 'stalled', owner: attachment.owner, transport, at: now });
    if (attachment.stalls >= 2 && transport === 'worker') {
      this.workerFailed('stalled');
      return;
    }
    void this.enqueue(async () => {
      if (this.attached !== attachment || !attachment.running) return;
      await attachment.running.stop();
      attachment.running = null;
      const path = await this.ensurePath();
      attachment.running = await path.run(attachment.source, attachment.sink);
      attachment.lastFrames = attachment.running.frames();
    });
  }

  private async stopAttachment(attachment: Attachment) {
    if (this.attached === attachment) this.attached = null;
    clearInterval(attachment.rateTimer);
    clearInterval(attachment.liveTimer);
    await attachment.running?.stop();
    attachment.running = null;
    attachment.output.stop();
  }

  /** Применить выбор; отказ (картинка не скачалась, не раскодировалась) не роняет держателя — прежний фон. */
  private async apply(path: Path, choice: BackgroundChoice) {
    if (JSON.stringify(choice) === JSON.stringify(this.choice) && choice.kind !== 'image') return;
    try {
      const prepared = await engineChoice(choice);
      this.choice = choice;
      path.choice(prepared);
    } catch (error) {
      console.warn('[cord] background choice failed', error);
    }
  }

  /** Путь кадров; отказ открыть не запоминается — следующий вызов пробует снова (A4). */
  private ensurePath(): Promise<Path> {
    if (!this.path) {
      const opening = this.openPath();
      this.path = opening;
      opening.then(
        (path) => {
          if (this.path === opening) this.transport = path.kind;
        },
        () => {
          if (this.path === opening) this.path = null;
        },
      );
    }
    return this.path;
  }

  private async openPath(): Promise<Path> {
    const onStats = (kind: Transport) => (stats: EngineStats) =>
      this.stats.set({ ...stats, transport: kind });
    if (!this.workerBroken && this.env.workerCapable()) {
      const worker = new WorkerPath(this.env, onStats('worker'), (message) => this.workerFailed(message));
      try {
        await worker.start();
        return worker;
      } catch (error) {
        void worker.stop();
        this.workerBroken = true;
        console.warn('[cord] background worker unavailable, running on the main thread', error);
      }
    }
    const local = this.env.streams()
      ? new MainPath(this.env, onStats('main'))
      : new CanvasPath(this.env, onStats('canvas'));
    await local.start();
    return local;
  }

  /**
   * Воркер упал уже в работе (не смог загрузить модель, исключение в движке): поднять движок на главном
   * потоке и пустить тот же источник в тот же сток. Выходная дорожка держателя не меняется — отправитель
   * LiveKit ничего не замечает (A1).
   */
  private workerFailed(message: string) {
    if (this.workerBroken) return;
    this.workerBroken = true;
    console.warn('[cord] background worker failed, running on the main thread:', message);
    void this.enqueue(async () => {
      const previous = await this.path?.catch(() => null);
      this.path = null;
      this.transport = null;
      const attachment = this.attached;
      await attachment?.running?.stop();
      if (attachment) attachment.running = null;
      await previous?.stop();
      const choice = this.choice;
      this.choice = { kind: 'none' };
      if (!attachment) return;
      const path = await this.ensurePath();
      attachment.running = await path.run(attachment.source, attachment.sink);
      attachment.lastFrames = attachment.running.frames();
      await this.apply(path, choice);
    });
  }
}
