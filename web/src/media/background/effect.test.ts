import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EffectEnv, WorkerLike } from './effect';

/*
  Движок фона на странице (R186, ревью A1–A4): выходная дорожка принадлежит странице и переживает
  переезд с воркера на главный поток и смену источника; превью не отбирает движок у обработчика
  встречи; ленивое снятие не убивает только что поставленный выход; отказ открыть путь не запоминается.
  Потоки — настоящие WHATWG (`TransformStream`), кадры — заглушки, движок — подменён.
*/

type Frame = { id: number; close: () => void };

/** Фальшивый движок: кадр проходит как есть, выбор запоминается. */
const engineLog = vi.hoisted(() => ({ constructed: 0, failConstruct: false, choices: [] as unknown[] }));
vi.mock('./engine', () => ({
  Engine: class {
    onLevel?: unknown;
    stats = { level: 0, segmentEvery: 1, costMs: 0, intervalMs: 33, fps: 0, segmentMs: 0, active: true };
    constructor() {
      if (engineLog.failConstruct) throw new Error('no webgl');
      engineLog.constructed++;
    }
    warm = async () => {};
    setChoice = (choice: unknown) => {
      engineLog.choices.push(choice);
    };
    setFrameRate = () => {};
    resetSource = () => {};
    process = (frame: Frame) => frame;
    dispose = async () => {};
  },
}));
vi.mock('../background-effect', async (original) => ({
  ...(await original<typeof import('../background-effect')>()),
  builtinBackgroundUrl: async () => 'blob:builtin',
  customBackgroundUrl: async () => null,
}));

/** Источник кадров: `push` кладёт кадр во все открытые потоки процессоров (у каждого — свой, как у MSTP). */
function fakeTrack(label: string) {
  const controllers = new Set<ReadableStreamDefaultController<Frame>>();
  return {
    label,
    kind: 'video',
    readyState: 'live' as 'live' | 'ended',
    getSettings: () => ({ width: 640, height: 360, frameRate: 30 }),
    stop() {
      this.readyState = 'ended';
    },
    open: () =>
      new ReadableStream<Frame>({
        start(c) {
          controllers.add(c);
        },
        cancel() {
          /* контроллер остаётся в наборе: push в закрытый поток ниже обёрнут */
        },
      }),
    push: (frame: Frame) => {
      for (const c of controllers)
        try {
          c.enqueue(frame);
        } catch {
          controllers.delete(c);
        }
    },
    end: () => {
      for (const c of controllers)
        try {
          c.close();
        } catch {
          /* уже закрыт */
        }
      controllers.clear();
    },
  };
}
type FakeTrack = ReturnType<typeof fakeTrack>;

/** Генератор страницы: всё, что в него записали, — в `frames`. */
class FakeGenerator {
  readyState: 'live' | 'ended' = 'live';
  kind = 'video';
  frames: Frame[] = [];
  writable = new WritableStream<Frame>({ write: (frame) => void this.frames.push(frame) });
  stop() {
    this.readyState = 'ended';
  }
  getSettings = () => ({});
}

const streams = (): EffectEnv['streams'] extends () => infer R ? R : never =>
  ({
    Processor: class {
      readable: ReadableStream<Frame>;
      constructor({ track }: { track: FakeTrack }) {
        this.readable = track.open();
      }
    },
    Generator: FakeGenerator,
  }) as never;

/** Фальшивый воркер: отвечает «готов», переливает кадры, по `fail()` сообщает об ошибке. */
class FakeWorker implements WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  messages: unknown[] = [];
  private abort: AbortController | null = null;
  postMessage(message: unknown) {
    const m = message as { type: string; readable?: ReadableStream<Frame>; writable?: WritableStream<Frame> };
    this.messages.push(m);
    if (m.type === 'init') queueMicrotask(() => this.reply({ type: 'ready' }));
    if (m.type === 'source' && m.readable && m.writable) {
      this.abort?.abort();
      this.abort = new AbortController();
      m.readable.pipeTo(m.writable, { signal: this.abort.signal }).catch(() => {});
    }
    if (m.type === 'detach') this.abort?.abort();
  }
  fail(text: string) {
    this.reply({ type: 'error', message: text });
  }
  terminate() {}
  private reply(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const frame = (id: number): Frame => ({ id, close: () => {} });

let worker: FakeWorker;
let env: EffectEnv;
beforeEach(() => {
  engineLog.constructed = 0;
  engineLog.failConstruct = false;
  engineLog.choices = [];
  worker = new FakeWorker();
  env = { streams, workerCapable: () => true, worker: () => worker };
});
afterEach(() => vi.useRealTimers());

async function effect() {
  const { BackgroundEffect } = await import('./effect');
  return new BackgroundEffect(env);
}

describe('движок фона на странице (R186, ревью A1–A4)', () => {
  it('воркер упал посреди работы — выход тот же, кадры идут дальше с главного потока (A1)', async () => {
    const engine = await effect();
    const source = fakeTrack('cam');
    const output = (await engine.attach(
      source as never,
      { kind: 'blur', strength: 'light' },
      'full',
      'processor',
    )) as unknown as FakeGenerator;
    source.push(frame(1));
    await tick();
    expect(output.frames.map((f) => f.id)).toEqual([1]);
    expect(worker.messages.some((m) => (m as { type: string }).type === 'source')).toBe(true);

    worker.fail('model failed');
    await tick();
    await tick();
    // Путь сменился на главный поток (движок собран у страницы), а дорожка на выходе — прежняя и живая.
    expect(engineLog.constructed).toBe(1);
    expect(output.readyState).toBe('live');
    expect(engine.stats.get()?.transport ?? 'main').toBe('main');
    // Главному потоку источник подан заново: у воркера свой процессор был забран, кадр идёт по новому.
    source.push(frame(2));
    await tick();
    expect(output.frames.map((f) => f.id)).toEqual([1, 2]);
    // Выбор переехал вместе с движком.
    expect(engineLog.choices).toEqual([{ mode: 'blur', strength: 'light' }]);
  });

  it('новая дорожка у того же держателя — тот же выход (включение после выключения, переворот)', async () => {
    const engine = await effect();
    const first = fakeTrack('cam-1');
    const output = (await engine.attach(
      first as never,
      { kind: 'blur', strength: 'strong' },
      'full',
      'processor',
    )) as unknown as FakeGenerator;
    first.push(frame(1));
    first.end();
    await tick();
    const second = fakeTrack('cam-2');
    const again = await engine.attach(
      second as never,
      { kind: 'blur', strength: 'strong' },
      'full',
      'processor',
    );
    expect(again).toBe(output);
    expect(output.readyState).toBe('live');
    second.push(frame(2));
    await tick();
    expect(output.frames.map((f) => f.id)).toEqual([1, 2]);
  });

  it('превью не отбирает движок у обработчика встречи — получает сырую дорожку; обработчик превью отбирает (A2)', async () => {
    const engine = await effect();
    const meeting = fakeTrack('meeting');
    const output = (await engine.attach(
      meeting as never,
      { kind: 'blur', strength: 'light' },
      'full',
      'processor',
    )) as unknown as FakeGenerator;
    const preview = fakeTrack('preview');
    const got = await engine.attach(preview as never, { kind: 'blur', strength: 'light' }, 'full', 'preview');
    expect(got).toBe(preview);
    expect(engine.owner).toBe('processor');
    expect(output.readyState).toBe('live');
    meeting.push(frame(1));
    await tick();
    expect(output.frames).toHaveLength(1);

    engine.detach(meeting as never);
    await tick();
    const previewOut = (await engine.attach(
      preview as never,
      { kind: 'blur', strength: 'light' },
      'full',
      'preview',
    )) as unknown as FakeGenerator;
    expect(previewOut).not.toBe(preview);
    const meeting2 = fakeTrack('meeting-2');
    await engine.attach(meeting2 as never, { kind: 'blur', strength: 'light' }, 'full', 'processor');
    expect(previewOut.readyState).toBe('ended');
    expect(engine.owner).toBe('processor');
  });

  it('ленивое снятие, назначенное до нового attach, не трогает новый выход (A3)', async () => {
    const engine = await effect();
    const source = fakeTrack('cam');
    const output = (await engine.attach(
      source as never,
      { kind: 'blur', strength: 'light' },
      'full',
    )) as unknown as FakeGenerator;
    // Как делает React при смене выбора: чистка прежнего эффекта (ленивое снятие), сразу новый attach,
    // причём очередь занята долгой подготовкой картинки.
    engine.detach(source as never, true);
    const again = engine.attach(source as never, { kind: 'image', id: 'forest' }, 'full');
    await tick();
    await tick();
    expect(await again).toBe(output);
    expect(output.readyState).toBe('live');
    source.push(frame(1));
    await tick();
    expect(output.frames).toHaveLength(1);
  });

  it('ленивое снятие без нового attach снимает фон и гасит выход', async () => {
    const engine = await effect();
    const source = fakeTrack('cam');
    const output = (await engine.attach(
      source as never,
      { kind: 'blur', strength: 'light' },
      'full',
    )) as unknown as FakeGenerator;
    engine.detach(source as never, true);
    await tick();
    await tick();
    expect(output.readyState).toBe('ended');
    expect(engine.source).toBeNull();
  });

  it('путь не открылся — отказ не запоминается, следующий attach пробует снова (A4)', async () => {
    env.workerCapable = () => false;
    engineLog.failConstruct = true;
    const engine = await effect();
    const source = fakeTrack('cam');
    await expect(engine.attach(source as never, { kind: 'blur', strength: 'light' }, 'full')).rejects.toThrow(
      'no webgl',
    );
    engineLog.failConstruct = false;
    const output = await engine.attach(source as never, { kind: 'blur', strength: 'light' }, 'full');
    expect((output as unknown as FakeGenerator).readyState).toBe('live');
    expect(engineLog.constructed).toBe(1);
  });

  it('частота источника изменилась на лету — движку уходит новый интервал (A9)', async () => {
    vi.useFakeTimers();
    const engine = await effect();
    const source = fakeTrack('cam');
    let rate = 30;
    source.getSettings = () => ({ width: 640, height: 360, frameRate: rate });
    const attached = engine.attach(source as never, { kind: 'blur', strength: 'light' }, 'full', 'processor');
    await vi.advanceTimersByTimeAsync(10);
    await attached;
    rate = 60;
    await vi.advanceTimersByTimeAsync(2100);
    const rates = worker.messages.filter((m) => (m as { type: string }).type === 'rate');
    expect(rates).toEqual([{ type: 'rate', frameRate: 60 }]);
  });
});
