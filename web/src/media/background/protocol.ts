import type { BudgetState } from './budget';
import type { EngineChoice, EngineStats } from './engine';
import type { SegmenterAssets } from './segmenter';

/**
 * Сообщения между страницей и воркером фона (R186). Потоки кадров и картинка фона передаются
 * владением (`transfer`), не копией.
 */
export type ToWorker =
  | { type: 'init'; assets: SegmenterAssets }
  | { type: 'warm'; width: number; height: number }
  | {
      type: 'source';
      readable: ReadableStream<VideoFrame>;
      writable: WritableStream<VideoFrame>;
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
