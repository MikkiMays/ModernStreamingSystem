import { useEffect, useId, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { CaptureUpdateAction, hashElementsVersion } from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { useTranslation } from 'react-i18next';
import {
  centerOn,
  fitMap,
  fromMap,
  toMap,
  union,
  visibleBounds,
  type Bounds,
  type MapFit,
} from '../../core/board/view';
import { viewOf } from './excalidraw-canvas';

/** Размер мини-карты в пикселях CSS — как в `board.css` (`.board-minimap`). */
const WIDTH = 144;
const HEIGHT = 90;
/** Сцену перерисовываем не чаще, чем раз в столько мс: пока рисуют, правки идут каждый кадр. */
const REDRAW_MS = 150;
/** Больше точек у штриха мини-карте не нужно: он там в несколько пикселей. */
const POINTS = 40;
/** Картинка и встроенное — серым прямоугольником (цвет холста доски, не тема Cord). */
const PLACEHOLDER = '#c6ccd6';

/** Рамка элемента без поворота — для мини-карты хватает. */
function boxOf(el: ExcalidrawElement): Bounds | null {
  if (el.isDeleted) return null;
  if ('points' in el && Array.isArray(el.points) && el.points.length) {
    let x1 = Infinity;
    let y1 = Infinity;
    let x2 = -Infinity;
    let y2 = -Infinity;
    for (const [px, py] of el.points) {
      x1 = Math.min(x1, px);
      y1 = Math.min(y1, py);
      x2 = Math.max(x2, px);
      y2 = Math.max(y2, py);
    }
    return [el.x + x1, el.y + y1, el.x + x2, el.y + y2];
  }
  const x2 = el.x + el.width;
  const y2 = el.y + el.height;
  return [Math.min(el.x, x2), Math.min(el.y, y2), Math.max(el.x, x2), Math.max(el.y, y2)];
}

function contentBounds(elements: readonly ExcalidrawElement[]): Bounds | null {
  return union(elements.map(boxOf));
}

const filled = (color: string) => !!color && color !== 'transparent';

/** Сцена на мини-карте — упрощённо: фигуры рамками и заливкой, штрихи — ломаной в 40 точек, текст — плашкой. */
function drawScene(ctx: CanvasRenderingContext2D, elements: readonly ExcalidrawElement[], fit: MapFit) {
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const el of elements) {
    const box = boxOf(el);
    if (!box) continue;
    const a = toMap(box[0], box[1], fit);
    const b = toMap(box[2], box[3], fit);
    const w = Math.max(b.x - a.x, 1);
    const h = Math.max(b.y - a.y, 1);
    ctx.globalAlpha = Math.max(0.15, el.opacity / 100);
    if (el.type === 'line' || el.type === 'arrow' || el.type === 'freedraw') {
      const points = el.points;
      const step = Math.max(1, Math.ceil(points.length / POINTS));
      ctx.beginPath();
      for (let i = 0; i < points.length; i += step) {
        const p = toMap(el.x + points[i]![0], el.y + points[i]![1], fit);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      const last = points[points.length - 1]!;
      const end = toMap(el.x + last[0], el.y + last[1], fit);
      ctx.lineTo(end.x, end.y);
      ctx.strokeStyle = el.strokeColor;
      ctx.lineWidth = Math.min(4, Math.max(1, el.strokeWidth * fit.scale));
      ctx.stroke();
      continue;
    }
    if (el.type === 'text') {
      ctx.globalAlpha *= 0.35;
      ctx.fillStyle = el.strokeColor;
      ctx.fillRect(a.x, a.y, w, h);
      continue;
    }
    if (el.type === 'image' || el.type === 'embeddable' || el.type === 'iframe') {
      ctx.fillStyle = PLACEHOLDER;
      ctx.fillRect(a.x, a.y, w, h);
      continue;
    }
    ctx.beginPath();
    if (el.type === 'ellipse') ctx.ellipse(a.x + w / 2, a.y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    else if (el.type === 'diamond') {
      ctx.moveTo(a.x + w / 2, a.y);
      ctx.lineTo(a.x + w, a.y + h / 2);
      ctx.lineTo(a.x + w / 2, a.y + h);
      ctx.lineTo(a.x, a.y + h / 2);
      ctx.closePath();
    } else ctx.rect(a.x, a.y, w, h);
    if ('backgroundColor' in el && filled(el.backgroundColor)) {
      ctx.fillStyle = el.backgroundColor;
      ctx.fill();
    }
    ctx.strokeStyle = el.strokeColor;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/**
 * Мини-карта доски (R169) — справа внизу, на месте кнопки помощи Excalidraw (помощь — в главном меню доски
 * и на «?»): крошечное превью всей сцены и рамка того, что видно сейчас. Нажатие переносит вид в эту точку,
 * перетаскивание рамки двигает его, двойное нажатие и Enter — вся доска; стрелки двигают вид с клавиатуры.
 *
 * Дёшево: вид и рамка — раз в кадр и только стилем; сцена перерисовывается, когда она или границы мира
 * изменились, и не чаще `REDRAW_MS`. Мир — всё нарисованное вместе с видимым, чтобы рамка не уходила за
 * край; пока рамку тащат, мир не пересчитывается — иначе карта «плыла» бы под пальцем.
 */
export function Minimap({ api }: { api: ExcalidrawImperativeAPI }) {
  const { t } = useTranslation();
  const hint = useId();
  const canvas = useRef<HTMLCanvasElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  /** Перевод «сцена ↔ карта» последнего кадра и то, за что держат рамку. */
  const fitRef = useRef<MapFit | null>(null);
  const drag = useRef<{ fit: MapFit; dx: number; dy: number } | null>(null);
  const repaint = useRef<() => void>(() => {});

  useEffect(() => {
    const ctx = canvas.current?.getContext('2d') ?? null;
    let elements: readonly ExcalidrawElement[] = api.getSceneElements();
    let app = api.getAppState();
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let version = -1;
    let content: Bounds | null = null;
    let drawn = '';
    let drawnAt = 0;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.current) {
      canvas.current.width = WIDTH * ratio;
      canvas.current.height = HEIGHT * ratio;
    }

    const paint = () => {
      raf = 0;
      const view = viewOf(app);
      if (!view.width || !view.height || !view.zoom) return;
      const visible = visibleBounds(view);
      const next = hashElementsVersion(elements);
      if (next !== version) {
        version = next;
        content = contentBounds(elements);
      }
      const held = drag.current;
      const fit = held ? held.fit : fitMap(union([content, visible])!, WIDTH, HEIGHT);
      fitRef.current = fit;
      // Рамка видимого — сразу.
      const a = toMap(visible[0], visible[1], fit);
      const b = toMap(visible[2], visible[3], fit);
      const style = frame.current?.style;
      if (style) {
        style.transform = `translate(${a.x}px, ${a.y}px)`;
        style.width = `${Math.max(b.x - a.x, 4)}px`;
        style.height = `${Math.max(b.y - a.y, 4)}px`;
      }
      // Сцена — когда изменилась она или мир, и не чаще REDRAW_MS.
      const key = `${version}:${fit.scale}:${fit.originX}:${fit.originY}`;
      if (key === drawn || !ctx) return;
      const wait = drawnAt + REDRAW_MS - performance.now();
      if (wait > 0) {
        if (!timer)
          timer = setTimeout(() => {
            timer = undefined;
            schedule();
          }, wait);
        return;
      }
      drawn = key;
      drawnAt = performance.now();
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, WIDTH, HEIGHT);
      drawScene(ctx, elements, fit);
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(paint);
    };
    repaint.current = schedule;
    const stop = api.onChange((nextElements, nextApp) => {
      elements = nextElements;
      app = nextApp;
      schedule();
    });
    schedule();
    return () => {
      stop();
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      repaint.current = () => {};
    };
  }, [api]);

  /** Поставить середину вида в точку сцены. */
  const goTo = (x: number, y: number) => {
    api.updateScene({
      appState: centerOn(x, y, viewOf(api.getAppState())),
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  };

  const at = (event: PointerEvent<HTMLDivElement>, fit: MapFit) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return fromMap(event.clientX - rect.left, event.clientY - rect.top, fit);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const fit = fitRef.current;
    if (!fit || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const point = at(event, fit);
    const [x1, y1, x2, y2] = visibleBounds(viewOf(api.getAppState()));
    // Взялись за рамку — она едет за пальцем, не прыгая серединой под него; мимо рамки — вид туда.
    const inside = point.x >= x1 && point.x <= x2 && point.y >= y1 && point.y <= y2;
    drag.current = {
      fit,
      dx: inside ? point.x - (x1 + x2) / 2 : 0,
      dy: inside ? point.y - (y1 + y2) / 2 : 0,
    };
    goTo(point.x - drag.current.dx, point.y - drag.current.dy);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const held = drag.current;
    if (!held) return;
    const point = at(event, held.fit);
    goTo(point.x - held.dx, point.y - held.dy);
  };

  const release = () => {
    drag.current = null;
    repaint.current();
  };

  const showAll = () => api.scrollToContent(undefined, { fitToContent: true, animate: true });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const view = viewOf(api.getAppState());
    const [x1, y1, x2, y2] = visibleBounds(view);
    const share = event.shiftKey ? 1 : 0.25;
    const dx = (x2 - x1) * share;
    const dy = (y2 - y1) * share;
    const move: Record<string, [number, number]> = {
      ArrowLeft: [-dx, 0],
      ArrowRight: [dx, 0],
      ArrowUp: [0, -dy],
      ArrowDown: [0, dy],
    };
    const step = move[event.key];
    if (step) goTo((x1 + x2) / 2 + step[0], (y1 + y2) / 2 + step[1]);
    else if (event.key === 'Enter' || event.key === 'Home') showAll();
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div
      className="board-minimap"
      role="application"
      tabIndex={0}
      aria-label={t(($) => $.board.minimap.label)}
      aria-describedby={hint}
      title={t(($) => $.board.minimap.title)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onDoubleClick={showAll}
      onKeyDown={onKeyDown}
    >
      <canvas ref={canvas} className="board-minimap__scene" aria-hidden="true" />
      <div ref={frame} className="board-minimap__view" aria-hidden="true" />
      <span id={hint} className="board-minimap__hint">
        {t(($) => $.board.minimap.keys)}
      </span>
    </div>
  );
}
