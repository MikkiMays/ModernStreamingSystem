import { Engine } from './engine';
import type { FromWorker, ToWorker } from './protocol';

/**
 * Воркер фона (R186, Р-89): сегментация и сведение кадров — не на главном потоке.
 *
 * ЗАЧЕМ. Прежний обработчик считал модель синхронно на главном потоке на каждом кадре: 15–60 мс
 * подряд, и на это время замирали и интерфейс встречи, и сам поток кадров (React, пульт, чат — всё в
 * одной очереди). Здесь поток кадров камеры (`MediaStreamTrackProcessor.readable`) и приёмник
 * (`MediaStreamTrackGenerator.writable`) передаются сюда владением, кадры идут сквозь движок, и главный
 * поток видит только статистику раз в секунду. Скрытая вкладка воркер не тормозит — видео у
 * собеседников не замирает.
 *
 * Воркер **классический** (`importScripts`): среда MediaPipe грузит wasm-загрузчик именно так, а в
 * модульном воркере `importScripts` запрещён. Сборка Vite складывает его одним файлом; dev-сервер
 * Vite отдаёт воркеры только модулями — там воркер не поднимется, и движок идёт на главном потоке
 * (`effect.ts`, запасной путь).
 */
const send = (message: FromWorker) => postMessage(message);

let engine: Engine | null = null;
let abort: AbortController | null = null;
let statsTimer: ReturnType<typeof setInterval> | undefined;

async function handle(message: ToWorker) {
  switch (message.type) {
    case 'init': {
      try {
        engine = new Engine(new OffscreenCanvas(2, 2), message.assets);
        engine.onLevel = (state) => send({ type: 'level', state });
        engine.onError = (error) =>
          send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
        // Модель грузится до «готов»: если здесь её не загрузить (модульный воркер dev-сервера), страница
        // узнаёт об этом сразу и поднимает движок у себя, а не после первой дорожки.
        await engine.warm(1280, 720);
        statsTimer = setInterval(() => engine && send({ type: 'stats', stats: engine.stats }), 1000);
        send({ type: 'ready' });
      } catch (error) {
        send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    case 'warm':
      await engine?.warm(message.width, message.height);
      return;
    case 'source': {
      if (!engine) return;
      abort?.abort();
      abort = new AbortController();
      engine.resetSource(message.frameRate);
      const current = engine;
      const port = message.port;
      const transform = new TransformStream<VideoFrame, VideoFrame>({
        transform(frame, controller) {
          controller.enqueue(current.process(frame));
        },
      });
      // Кадр уходит на страницу владением: после `postMessage` он здесь закрыт (И5). Напор — на
      // странице: занятый генератор закрывает лишний кадр, а не копит очередь.
      const sink = new WritableStream<VideoFrame>({
        write(frame) {
          port.postMessage(frame, [frame]);
        },
      });
      message.readable
        .pipeThrough(transform, { signal: abort.signal })
        .pipeTo(sink, { signal: abort.signal })
        .catch(() => {})
        .finally(() => port.close());
      return;
    }
    case 'detach':
      abort?.abort();
      abort = null;
      return;
    case 'rate':
      engine?.setFrameRate(message.frameRate);
      return;
    case 'choice':
      engine?.setChoice(message.choice);
      return;
    case 'stop':
      abort?.abort();
      clearInterval(statsTimer);
      await engine?.dispose();
      engine = null;
      close();
  }
}

onmessage = (event: MessageEvent<ToWorker>) => {
  handle(event.data).catch((error) =>
    send({ type: 'error', message: error instanceof Error ? error.message : String(error) }),
  );
};
