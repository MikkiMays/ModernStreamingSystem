import type { BudgetState } from './budget';
import type { EngineChoice, EngineStats } from './engine';
import type { SegmenterAssets } from './segmenter';

/**
 * Сообщения между страницей и воркером фона (R186). Поток кадров источника и картинка фона передаются
 * владением (`transfer`), не копией. Обработанные кадры возвращаются на страницу через `MessagePort`
 * тоже владением — `postMessage(frame, [frame])` (R189, И5): писать их в перенесённый `WritableStream`
 * нельзя, по спецификации чанк такого потока клонируется, и оригинал `VideoFrame` в воркере жил бы до
 * сборки мусора («A VideoFrame was garbage collected without being closed»).
 */
export type ToWorker =
  | { type: 'init'; assets: SegmenterAssets }
  | { type: 'warm'; width: number; height: number }
  | {
      type: 'source';
      readable: ReadableStream<VideoFrame>;
      port: MessagePort;
      frameRate?: number;
    }
  | { type: 'detach' }
  | { type: 'rate'; frameRate: number | undefined }
  | { type: 'choice'; choice: EngineChoice }
  | { type: 'stop' };

export type FromWorker =
  | { type: 'ready' }
  | { type: 'error'; message: string }
  | { type: 'level'; state: BudgetState }
  | { type: 'stats'; stats: EngineStats };
