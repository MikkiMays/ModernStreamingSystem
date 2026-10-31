import type { BoardElement, InkStyle } from './protocol';

/**
 * Слияние сцены доски (R159) — правила без Excalidraw, чтобы их проверял тест и чтобы браузер и ядро
 * отвечали одинаково.
 *
 * Элемент Excalidraw несёт `version` (растёт на каждую правку) и `versionNonce` (случайное число
 * правки). Побеждает большая версия, при равной — меньший `versionNonce`: та же формула у ядра
 * (`BoardRoom.wins`) и у `reconcileElements` Excalidraw. Своё, что человек прямо сейчас правит (текст,
 * растягиваемая фигура), чужой правкой не перебивается — иначе буквы пропадали бы из-под пальцев.
 */

/** Что можно рисовать — то же, что пускает ядро (`BoardRoom.TYPES`). */
export const ELEMENT_TYPES: ReadonlySet<string> = new Set([
  'rectangle',
  'diamond',
  'ellipse',
  'arrow',
  'line',
  'freedraw',
  'text',
  'image',
  'frame',
]);

const POINTED = new Set(['arrow', 'line', 'freedraw']);

/** Правка `a` побеждает `b`. */
export function wins(a: Pick<BoardElement, 'version' | 'versionNonce'>, b: typeof a): boolean {
  return a.version > b.version || (a.version === b.version && a.versionNonce < b.versionNonce);
}

/** Чужая правка ложится поверх своей: своей нет, её сейчас не правят и она не новее. */
export function remoteWins(
  local: BoardElement | undefined,
  remote: BoardElement,
  editing: ReadonlySet<string>,
): boolean {
  if (!local) return true;
  if (editing.has(local.id)) return false;
  return !wins(local, remote);
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * Чужой элемент — после проверки: без `id`, вида и версий он не годится, а недостающее заполняется
 * так, чтобы Excalidraw не споткнулся. `restoreElements` Excalidraw здесь не подходит: пустой текст он
 * помечает удалённым с новой версией (и эхо стёрло бы текст, который сосед как раз набирает), а
 * совсем мелкие элементы выбрасывает — вместе с отметкой их удаления.
 */
export function normalizeRemote(value: unknown): BoardElement | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as BoardElement;
  if (typeof source.id !== 'string' || !source.id || !ELEMENT_TYPES.has(source.type)) return null;
  if (!finite(source.version) || !finite(source.versionNonce)) return null;
  const el: BoardElement = { ...source };
  for (const field of ['x', 'y', 'width', 'height', 'angle'] as const) if (!finite(el[field])) el[field] = 0;
  if (typeof el.isDeleted !== 'boolean') el.isDeleted = false;
  if (!Array.isArray(el.groupIds)) el.groupIds = [];
  if (el.boundElements !== null && !Array.isArray(el.boundElements)) el.boundElements = null;
  if (el.frameId === undefined) el.frameId = null;
  if (el.index === undefined) el.index = null;
  if (POINTED.has(el.type)) {
    const points = Array.isArray(el.points)
      ? el.points.filter((point) => Array.isArray(point) && finite(point[0]) && finite(point[1]))
      : [];
    if (points.length < 2) {
      if (!el.isDeleted) return null;
      el.points = [
        [0, 0],
        [0, 0],
      ];
    } else el.points = points;
    if (el.type === 'freedraw' && !Array.isArray(el.pressures)) el.pressures = [];
  }
  if (el.type === 'text') {
    if (typeof el.text !== 'string') el.text = '';
    if (typeof el.originalText !== 'string') el.originalText = el.text;
  }
  return el;
}

/**
 * Порядок слоёв — по дробному индексу (`index`), как в Excalidraw: строки сравниваются побайтно, без
 * индекса — в конец. Нужен поддельному холсту тестов; настоящий упорядочивает сам `reconcileElements`.
 */
export function byIndex(a: BoardElement, b: BoardElement): number {
  const x = a.index ?? '￿';
  const y = b.index ?? '￿';
  return x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Штрих соседа «в процессе»: точки и нажим по номерам, вид и когда пришла последняя дельта. */
export interface InkStroke {
  from: string;
  points: number[][];
  pressures: number[];
  style: InkStyle;
  at: number;
}

/**
 * Положить дельту точек на место. Дельта с номера дальше конца (пропущенное потерялось) встаёт в конец:
 * прямой отрезок через пропуск лучше, чем штрих, застывший на полпути, — готовый элемент всё равно
 * придёт целиком.
 */
export function addInk(stroke: InkStroke, start: number, points: readonly (readonly number[])[]) {
  const at = Math.min(Math.max(0, start), stroke.points.length);
  stroke.points.length = at;
  stroke.pressures.length = at;
  for (const point of points) {
    if (!finite(point[0]) || !finite(point[1])) continue;
    stroke.points.push([point[0], point[1]]);
    stroke.pressures.push(finite(point[2]) ? point[2] : 0.5);
  }
}

/** Устойчивое «случайное» зерно штриха по его номеру — тот же вид при каждой перерисовке. */
function seedOf(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (Math.imul(hash, 31) + id.charCodeAt(i)) | 0;
  return Math.abs(hash) || 1;
}

/**
 * Временный элемент штриха соседа — пока его перо не поднялось. Версия 1 и `locked`: готовый элемент
 * автора (его версия больше) заменит этот при слиянии, а взять чужое недорисованное в руки нельзя.
 */
export function inkElement(id: string, stroke: InkStroke, now = Date.now()): BoardElement {
  const xs = stroke.points.map((point) => point[0]!);
  const ys = stroke.points.map((point) => point[1]!);
  const style = stroke.style;
  return {
    id,
    type: 'freedraw',
    x: style.x ?? 0,
    y: style.y ?? 0,
    width: xs.length ? Math.max(...xs) - Math.min(...xs) : 0,
    height: ys.length ? Math.max(...ys) - Math.min(...ys) : 0,
    angle: style.angle ?? 0,
    strokeColor: style.strokeColor ?? '#1e1e1e',
    backgroundColor: style.backgroundColor ?? 'transparent',
    fillStyle: style.fillStyle ?? 'solid',
    strokeWidth: style.strokeWidth ?? 2,
    strokeStyle: style.strokeStyle ?? 'solid',
    roughness: style.roughness ?? 0,
    opacity: style.opacity ?? 100,
    groupIds: [],
    frameId: style.frameId ?? null,
    index: style.index ?? null,
    roundness: null,
    seed: seedOf(id),
    version: 1,
    versionNonce: 0,
    isDeleted: false,
    boundElements: null,
    updated: now,
    link: null,
    locked: true,
    points: stroke.points.map((point) => [point[0]!, point[1]!]),
    pressures: [...stroke.pressures],
    simulatePressure: style.simulatePressure ?? true,
    lastCommittedPoint: null,
    customData: { cordInk: true },
  };
}

/** Вид своего штриха «в процессе» для соседей — только то, что пропускает ядро. */
export function inkStyle(el: BoardElement): InkStyle {
  const style: InkStyle = {};
  for (const field of ['x', 'y', 'strokeWidth', 'opacity', 'roughness', 'angle'] as const)
    if (finite(el[field])) style[field] = el[field] as number;
  for (const field of [
    'strokeColor',
    'backgroundColor',
    'strokeStyle',
    'fillStyle',
    'index',
    'frameId',
  ] as const)
    if (typeof el[field] === 'string') style[field] = el[field] as string;
  if (typeof el.simulatePressure === 'boolean') style.simulatePressure = el.simulatePressure;
  return style;
}

const encoder = new TextEncoder();

/** Байты значения в JSON — для нарезки правок на сообщения. */
export function jsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}
