import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { Check, Eraser, Pencil, RotateCw, Trash2, Undo2, WifiOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { DRAWING_LIMITS, DrawingQueue, drawingPoint, mergeDrawing, type DrawingStroke } from '../core/gartic';
import { useMediaQuery } from './primitives';

export interface GarticCanvasHandle {
  flush: () => Promise<void>;
}

/** Цвет кисти и его имя в каталоге (`gartic.canvas.colors`). */
const COLORS = [
  ['#222631', 'black'],
  ['#ffffff', 'white'],
  ['#ef4444', 'red'],
  ['#f97316', 'orange'],
  ['#facc15', 'yellow'],
  ['#22c55e', 'green'],
  ['#14b8a6', 'teal'],
  ['#38bdf8', 'lightBlue'],
  ['#3564f3', 'blue'],
  ['#8b5cf6', 'violet'],
  ['#ec4899', 'pink'],
  ['#92400e', 'brown'],
] as const;

const WIDTHS = [
  [3, 'thin'],
  [6, 'medium'],
  [12, 'thick'],
  [24, 'wide'],
] as const;

function Ink({ stroke }: { stroke: DrawingStroke }) {
  if (stroke.points.length === 1) {
    const point = stroke.points[0]!;
    return <circle cx={point[0]} cy={point[1]! * 0.625} r={stroke.width / 2} fill={stroke.color} />;
  }
  return (
    <polyline
      points={stroke.points.map(([x, y]) => `${x},${y! * 0.625}`).join(' ')}
      fill="none"
      stroke={stroke.color}
      strokeWidth={stroke.width}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
}

function sameStroke(before: DrawingStroke, after: DrawingStroke | undefined) {
  return (
    !!after &&
    before.id === after.id &&
    before.color === after.color &&
    before.width === after.width &&
    before.points.length === after.points.length &&
    before.points.every(
      (point, index) => point[0] === after.points[index]![0] && point[1] === after.points[index]![1],
    )
  );
}

type InkAnimation = { frame: number; paths: SVGPolylineElement[] };
function finishInk(animation: InkAnimation | null) {
  if (!animation) return;
  cancelAnimationFrame(animation.frame);
  for (const path of animation.paths) {
    path.removeAttribute('pathLength');
    path.style.removeProperty('stroke-dasharray');
    path.style.removeProperty('stroke-dashoffset');
    path.style.removeProperty('visibility');
  }
}

/** Present fresh remote ink between snapshots; never delay authoritative canvas changes. */
function RemoteInk({ strokes, connected }: { strokes: DrawingStroke[]; connected: boolean }) {
  const group = useRef<SVGGElement>(null);
  const previous = useRef<DrawingStroke[] | null>(null);
  const awaitingSnapshot = useRef(false);
  const animation = useRef<InkAnimation | null>(null);
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');

  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = strokes;
    if (!connected) awaitingSnapshot.current = true;
    if (!connected || awaitingSnapshot.current || reducedMotion || document.hidden || !before) {
      finishInk(animation.current);
      animation.current = null;
      // Authentication can finish before its first snapshot. Wait for that snapshot,
      // including an identical copy, so recovered strokes never replay as live ink.
      if (connected && !document.hidden && strokes !== before) awaitingSnapshot.current = false;
      return;
    }
    const appended = strokes.length - before.length;
    const prefixUnchanged = before.every((stroke, index) => sameStroke(stroke, strokes[index]));
    if (appended === 0 && prefixUnchanged) return;
    finishInk(animation.current);
    animation.current = null;
    // Large batches are catch-up. There is no animation queue: a newer batch finishes
    // the previous one immediately, keeping presentation latency bounded to 200 ms.
    if (!prefixUnchanged || appended < 1 || appended > 4 || !group.current) return;
    const paths = [...group.current.children]
      .slice(before.length)
      .filter((element): element is SVGPolylineElement => element.tagName.toLowerCase() === 'polyline');
    if (!paths.length) return;
    for (const path of paths) {
      path.setAttribute('pathLength', '1');
      path.style.strokeDasharray = '1';
      path.style.strokeDashoffset = '1';
      path.style.visibility = 'hidden';
    }
    const current: InkAnimation = { frame: 0, paths };
    animation.current = current;
    const started = performance.now();
    const paint = (now: number) => {
      const progress = Math.min(1, (now - started) / 200);
      if (progress >= 1) {
        finishInk(current);
        animation.current = null;
        return;
      }
      paths.forEach((path, index) => {
        const revealed = Math.max(0, Math.min(1, progress * paths.length - index));
        path.style.visibility = progress * paths.length >= index ? '' : 'hidden';
        path.style.strokeDashoffset = String(1 - revealed);
      });
      current.frame = requestAnimationFrame(paint);
    };
    current.frame = requestAnimationFrame(paint);
  }, [strokes, connected, reducedMotion]);

  useLayoutEffect(() => {
    const visibilityChanged = () => {
      if (!document.hidden) return;
      awaitingSnapshot.current = true;
      finishInk(animation.current);
      animation.current = null;
    };
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => {
      document.removeEventListener('visibilitychange', visibilityChanged);
      finishInk(animation.current);
      animation.current = null;
    };
  }, []);

  return (
    <g ref={group}>
      {strokes.map((stroke) => (
        <Ink key={stroke.id} stroke={stroke} />
      ))}
    </g>
  );
}

/** Only validated geometry becomes SVG attributes; no remote markup or bitmap payloads. */
export function GarticPicture({
  strokes,
  label,
  children,
}: {
  strokes: DrawingStroke[];
  label?: string;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="gartic-paper">
      <svg viewBox="0 0 1000 625" role="img" aria-label={label ?? t(($) => $.gartic.canvas.picture)}>
        <rect width="1000" height="625" fill="#ffffff" />
        {strokes.map((stroke) => (
          <Ink key={stroke.id} stroke={stroke} />
        ))}
      </svg>
      {children}
    </div>
  );
}

/** A keyed instance owns one phase's optimistic ink and its strictly serialized queue. */
export default function GarticCanvas({
  strokes,
  editable,
  connected,
  locked = false,
  smoothRemote = false,
  interval = 250,
  onDraw,
  onEdit,
  ref,
}: {
  strokes: DrawingStroke[];
  editable: boolean;
  connected: boolean;
  locked?: boolean;
  smoothRemote?: boolean;
  interval?: number;
  onDraw: (text: string) => Promise<unknown>;
  onEdit: (option: 'undo' | 'clear') => Promise<unknown>;
  ref?: Ref<GarticCanvasHandle>;
}) {
  const { t } = useTranslation();
  const [color, setColor] = useState('#222631');
  const [width, setWidth] = useState(6);
  const [eraser, setEraser] = useState(false);
  const [local, setLocal] = useState<DrawingStroke[]>([]);
  const [active, setActive] = useState<DrawingStroke | null>(null);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const queue = useRef<DrawingQueue | null>(null);
  const input = useRef<{ pointer: number; stroke: DrawingStroke; dirty: boolean } | null>(null);
  const current = useRef({ strokes, local, editable, connected, busy: busy || locked });
  current.current = { strokes, local, editable, connected, busy: busy || locked };
  const callbacks = useRef({ onDraw, onEdit });
  callbacks.current = { onDraw, onEdit };

  useEffect(() => {
    if (!editable) return;
    const next = new DrawingQueue({
      send: (text) => callbacks.current.onDraw(text),
      interval,
      changed: setPending,
      acknowledged: (ids) => {
        const accepted = new Set(ids);
        // A retry can acknowledge an ID already undone/cleared by another tab.
        // onDraw refreshes the authoritative canvas before this callback runs.
        current.current.local = current.current.local.filter((stroke) => !accepted.has(stroke.id));
        setLocal((previous) => previous.filter((stroke) => !accepted.has(stroke.id)));
      },
      failed: (failure) => setError(failure.message),
    });
    next.setConnected(current.current.connected);
    queue.current = next;
    return () => {
      next.dispose();
      if (queue.current === next) queue.current = null;
      input.current = null;
    };
  }, [editable, interval]);

  useEffect(() => {
    queue.current?.setConnected(connected);
  }, [connected]);
  useEffect(() => {
    const accepted = new Set(strokes.map((stroke) => stroke.id));
    setLocal((previous) =>
      previous.some((stroke) => accepted.has(stroke.id))
        ? previous.filter((stroke) => !accepted.has(stroke.id))
        : previous,
    );
  }, [strokes]);

  const seal = (continuing = false) => {
    const drawing = input.current;
    if (!drawing) return;
    if (drawing.dirty) {
      queue.current?.enqueue(drawing.stroke);
      const next = [...current.current.local, drawing.stroke];
      current.current.local = next;
      setLocal(next);
    }
    const last = drawing.stroke.points.at(-1)!;
    const total = mergeDrawing(current.current.strokes, current.current.local);
    if (
      continuing &&
      total.length < DRAWING_LIMITS.strokes &&
      total.reduce((sum, stroke) => sum + stroke.points.length, 0) < DRAWING_LIMITS.points
    ) {
      input.current = {
        pointer: drawing.pointer,
        dirty: false,
        stroke: { ...drawing.stroke, id: crypto.randomUUID(), points: [last] },
      };
      setActive(input.current.stroke);
    } else {
      input.current = null;
      setActive(null);
    }
  };
  const sealRef = useRef(seal);
  sealRef.current = seal;
  useEffect(() => {
    if (!editable) return;
    const timer = setInterval(() => {
      if (input.current?.dirty) sealRef.current(true);
    }, interval);
    return () => clearInterval(timer);
  }, [editable, interval]);

  useImperativeHandle(
    ref,
    () => ({
      flush: async () => {
        sealRef.current();
        await queue.current?.flush();
      },
    }),
    [],
  );

  const limit = () => {
    setError(t(($) => $.gartic.canvas.tooManyStrokes));
    seal();
  };
  const begin = (event: PointerEvent<SVGSVGElement>) => {
    if (!editable || !connected || busy || locked || input.current || event.button !== 0) return;
    const used = mergeDrawing(current.current.strokes, current.current.local);
    if (
      used.length >= DRAWING_LIMITS.strokes ||
      used.reduce((sum, stroke) => sum + stroke.points.length, 0) >= DRAWING_LIMITS.points
    ) {
      limit();
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const stroke: DrawingStroke = {
      id: crypto.randomUUID(),
      color: eraser ? '#ffffff' : color,
      width: eraser ? Math.max(width, 20) : width,
      points: [drawingPoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect())],
    };
    input.current = { pointer: event.pointerId, stroke, dirty: true };
    setActive(stroke);
  };
  const move = (event: PointerEvent<SVGSVGElement>) => {
    const drawing = input.current;
    if (!drawing || drawing.pointer !== event.pointerId) return;
    if (!current.current.editable || !current.current.connected || current.current.busy) {
      seal();
      return;
    }
    const point = drawingPoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect());
    const last = drawing.stroke.points.at(-1)!;
    if (Math.hypot(point[0]! - last[0]!, point[1]! - last[1]!) < 2) return;
    const used = mergeDrawing(current.current.strokes, current.current.local);
    const count = used.reduce((sum, stroke) => sum + stroke.points.length, 0);
    if (count + drawing.stroke.points.length >= DRAWING_LIMITS.points) {
      limit();
      return;
    }
    drawing.stroke = { ...drawing.stroke, points: [...drawing.stroke.points, point] };
    drawing.dirty = true;
    setActive(drawing.stroke);
    if (drawing.stroke.points.length >= DRAWING_LIMITS.segment) seal(true);
  };
  const end = (event: PointerEvent<SVGSVGElement>) => {
    if (input.current?.pointer !== event.pointerId) return;
    seal();
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const edit = async (option: 'undo' | 'clear') => {
    if (!editable || busy || locked || !connected) return;
    setBusy(true);
    setError('');
    try {
      if (option === 'clear') {
        input.current = null;
        setActive(null);
        const discarded = new Set(await queue.current?.discardPending());
        current.current.local = current.current.local.filter((stroke) => !discarded.has(stroke.id));
        setLocal((previous) => previous.filter((stroke) => !discarded.has(stroke.id)));
      } else {
        seal();
        await queue.current?.flush();
      }
      await callbacks.current.onEdit(option);
      current.current.local = [];
      setLocal([]);
      setError('');
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const ink = mergeDrawing(strokes, local);
  return (
    <div
      className="gartic-drawing"
      onKeyDown={(event) => {
        if (editable && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
          event.preventDefault();
          void edit('undo');
        }
      }}
    >
      {editable && (
        <div className="gartic-tools" aria-label={t(($) => $.gartic.canvas.tools)}>
          <div className="gartic-palette" aria-label={t(($) => $.gartic.canvas.palette)}>
            {COLORS.map(([value, name]) => (
              <button
                key={value}
                type="button"
                aria-label={t(($) => $.gartic.canvas.colors[name])}
                aria-pressed={!eraser && color === value}
                style={{ '--ink': value } as CSSProperties}
                onClick={() => {
                  setColor(value);
                  setEraser(false);
                }}
              >
                {!eraser && color === value && (
                  <Check
                    size={16}
                    style={{
                      color: ['#ffffff', '#facc15', '#38bdf8'].includes(value) ? '#222631' : '#ffffff',
                    }}
                  />
                )}
              </button>
            ))}
          </div>
          <div className="gartic-tool-group">
            <button
              type="button"
              className="gartic-tool"
              aria-label={t(($) => $.gartic.canvas.brush)}
              aria-pressed={!eraser}
              onClick={() => setEraser(false)}
            >
              <Pencil size={20} />
            </button>
            <button
              type="button"
              className="gartic-tool"
              aria-label={t(($) => $.gartic.canvas.eraser)}
              aria-pressed={eraser}
              onClick={() => setEraser(true)}
            >
              <Eraser size={20} />
            </button>
            <label className="gartic-brush">
              {t(($) => $.gartic.canvas.width)}{' '}
              <select
                aria-label={t(($) => $.gartic.canvas.widthLabel)}
                value={width}
                onChange={(event) => setWidth(Number(event.target.value))}
              >
                {WIDTHS.map(([value, name]) => (
                  <option key={value} value={value}>
                    {t(($) => $.gartic.canvas.widths[name])}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="gartic-tool-group">
            <button
              type="button"
              className="gartic-tool"
              aria-label={t(($) => $.gartic.canvas.undo)}
              title={t(($) => $.gartic.canvas.undoTitle)}
              disabled={busy || locked || !connected || !ink.length}
              onClick={() => void edit('undo')}
            >
              <Undo2 size={20} />
            </button>
            <button
              type="button"
              className="gartic-tool"
              aria-label={t(($) => $.gartic.canvas.clear)}
              disabled={busy || locked || !connected || !ink.length}
              onClick={() => void edit('clear')}
            >
              <Trash2 size={20} />
            </button>
          </div>
        </div>
      )}
      <div className="gartic-paper" data-editable={editable || undefined} data-eraser={eraser || undefined}>
        <svg
          viewBox="0 0 1000 625"
          role="img"
          aria-label={editable ? t(($) => $.gartic.canvas.editable) : t(($) => $.gartic.canvas.view)}
          tabIndex={editable ? 0 : undefined}
          onPointerDown={begin}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          onLostPointerCapture={end}
        >
          <rect width="1000" height="625" fill="#ffffff" />
          {smoothRemote && !editable ? (
            <RemoteInk strokes={strokes} connected={connected} />
          ) : (
            ink.map((stroke) => <Ink key={stroke.id} stroke={stroke} />)
          )}
          {editable && active && <Ink stroke={active} />}
        </svg>
        {!ink.length && !active && (
          <div className="gartic-paper-empty" aria-hidden="true">
            <Pencil size={32} strokeWidth={1.25} data-own-stroke />
            <span>
              {editable ? t(($) => $.gartic.canvas.firstStroke) : t(($) => $.gartic.canvas.emptyView)}
            </span>
          </div>
        )}
      </div>
      {editable && !connected && (
        <div className="gartic-canvas-status" role="status">
          <WifiOff size={12} /> {t(($) => $.gartic.canvas.offline)}
        </div>
      )}
      {error && (
        <div className="gartic-error" role="alert">
          <span>{error}</span>
          {pending > 0 && (
            <button
              type="button"
              disabled={!connected}
              onClick={() => {
                setError('');
                queue.current?.retry();
              }}
            >
              <RotateCw size={16} /> {t(($) => $.gartic.canvas.retry)}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
