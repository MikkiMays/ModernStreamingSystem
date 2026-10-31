/**
 * Провод сокета доски `/api/v1/board` (R159) — то же, что описано у ядра (`events/BoardSocket.java`).
 *
 * Элемент сцены — элемент Excalidraw как есть: ядру из него важны `id`, `type`, `version`,
 * `versionNonce`, `isDeleted` и у картинки `fileId`, остальное оно хранит и раздаёт не читая.
 */

/** Элемент сцены Excalidraw — в том виде, в каком его знает провод. */
export interface BoardElement {
  id: string;
  type: string;
  version: number;
  versionNonce: number;
  isDeleted?: boolean;
  index?: string | null;
  fileId?: string | null;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  points?: readonly (readonly number[])[];
  pressures?: readonly number[];
  [field: string]: unknown;
}

/** Картинка, которая уже лежит на сервере у этой доски. */
export interface BoardFileMeta {
  id: string;
  mime: string;
  size: number;
}

/** Вид штриха «в процессе» — ровно то, что пропускает ядро. */
export interface InkStyle {
  x?: number;
  y?: number;
  strokeColor?: string;
  backgroundColor?: string;
  strokeWidth?: number;
  strokeStyle?: string;
  fillStyle?: string;
  opacity?: number;
  roughness?: number;
  angle?: number;
  simulatePressure?: boolean;
  index?: string;
  frameId?: string;
}

export type Tool = 'pointer' | 'laser';

/** Что приходит от ядра. */
export type ServerMessage =
  | {
      type: 'hello';
      me: string;
      canDraw: boolean;
      epoch: number;
      seq: number;
      peers: string[];
      mode: 'scene' | 'replay';
      st: number;
    }
  | { type: 'scene'; epoch: number; seq: number; files: BoardFileMeta[]; els: BoardElement[] }
  | {
      type: 'ops';
      seq: number;
      from: string;
      t?: number;
      st?: number;
      replay?: boolean;
      els: BoardElement[];
    }
  | {
      type: 'ack';
      seq: number;
      n: number;
      rejected?: { id: string; version: number; code: string }[];
      stale?: BoardElement[];
    }
  | { type: 'synced'; seq: number }
  | {
      type: 'presence';
      from: string;
      x: number;
      y: number;
      tool: Tool;
      button: 'up' | 'down';
      sel?: string[];
      t?: number;
    }
  | {
      type: 'ink';
      from: string;
      id: string;
      start: number;
      pts: number[][];
      el?: InkStyle;
      t: number;
      st: number;
    }
  | { type: 'joined'; from: string }
  | { type: 'left'; from: string }
  | { type: 'cleared'; epoch: number; seq: number; by: string }
  | { type: 'access'; canDraw: boolean }
  | { type: 'pong'; id: string; st: number }
  | { type: 'error'; code: string };

/** Что уходит в ядро. */
export type ClientMessage =
  | { type: 'auth'; roomId: string; credential: string; epoch: number; since: number }
  | { type: 'ops'; els: BoardElement[]; t: number }
  | { type: 'presence'; x: number; y: number; tool: Tool; button: 'up' | 'down'; sel?: string[]; t: number }
  | { type: 'ink'; id: string; start: number; pts: number[][]; el: InkStyle; t: number }
  | { type: 'sync'; epoch: number; since: number }
  | { type: 'ping'; id: string };

/**
 * Коды закрытия сокета доски (`BoardSocket.java`). После «доски нет», «пропуск не годится» и «вытеснила
 * другая вкладка» сокет не возвращается сам; после «слишком часто» и «не успевает» — возвращается и
 * досылает своё.
 */
export const CLOSE = {
  boardClosed: 4001,
  forbidden: 4003,
  rate: 4008,
  slow: 4009,
  replaced: 4010,
} as const;

/** Пределы провода: сообщение ядро режет на 96 КиБ, элемент — на 64 КиБ. */
export const LIMITS = {
  /** Правки режутся на сообщения не больше этого (байт JSON). */
  messageBytes: 60_000,
  /** Элемент больше этого ядро не примет — и слать его незачем. */
  elementBytes: 64 * 1024,
  /** Элементов в одном сообщении — не больше, чем принимает ядро. */
  batchElements: 2000,
  /** Курсор — не чаще 30 раз в секунду. */
  presenceMs: 33,
} as const;
