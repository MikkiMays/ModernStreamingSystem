import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { Check, Eraser, Pencil, RotateCw, Trash2, Undo2, WifiOff } from 'lucide-react';
import { DRAWING_LIMITS, DrawingQueue, drawingPoint, mergeDrawing, type DrawingStroke } from '../core/gartic';

export interface GarticCanvasHandle {
  flush: () => Promise<void>;
}

const COLORS = [
  ['#222631', 'Чёрный'],
  ['#ffffff', 'Белый'],
  ['#ef4444', 'Красный'],
  ['#f97316', 'Оранжевый'],
  ['#facc15', 'Жёлтый'],
  ['#22c55e', 'Зелёный'],
  ['#14b8a6', 'Бирюзовый'],
  ['#38bdf8', 'Голубой'],
  ['#3564f3', 'Синий'],
  ['#8b5cf6', 'Фиолетовый'],
  ['#ec4899', 'Розовый'],
  ['#92400e', 'Коричневый'],
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

/** Only validated geometry becomes SVG attributes; no remote markup or bitmap payloads. */
export function GarticPicture({
  strokes,
  label = 'Рисунок',
  children,
}: {
  strokes: DrawingStroke[];
  label?: string;
  children?: ReactNode;
}) {
  return (
    <div className="gartic-paper">
      <svg viewBox="0 0 1000 625" role="img" aria-label={label}>
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
  interval = 250,
  onDraw,
  onEdit,
  ref,
}: {
  strokes: DrawingStroke[];
  editable: boolean;
  connected: boolean;
  locked?: boolean;
  interval?: number;
  onDraw: (text: string) => Promise<unknown>;
  onEdit: (option: 'undo' | 'clear') => Promise<unknown>;
  ref?: Ref<GarticCanvasHandle>;
}) {
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
    setError('На листе уже много штрихов. Отмените последний или очистите лист.');
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
        <div className="gartic-tools" aria-label="Инструменты рисования">
          <div className="gartic-palette" aria-label="Цвет кисти">
            {COLORS.map(([value, name]) => (
              <button
                key={value}
                type="button"
                aria-label={name}
                aria-pressed={!eraser && color === value}
                style={{ '--ink': value } as CSSProperties}
                onClick={() => {
                  setColor(value);
                  setEraser(false);
                }}
              >
                {!eraser && color === value && (
                  <Check
                    size={15}
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
              aria-label="Кисть"
              aria-pressed={!eraser}
              onClick={() => setEraser(false)}
            >
              <Pencil size={18} />
            </button>
            <button
              type="button"
              className="gartic-tool"
              aria-label="Ластик"
              aria-pressed={eraser}
              onClick={() => setEraser(true)}
            >
              <Eraser size={18} />
            </button>
            <label className="gartic-brush">
              Толщина{' '}
              <select
                aria-label="Толщина кисти"
                value={width}
                onChange={(event) => setWidth(Number(event.target.value))}
              >
                <option value="3">Тонкая</option>
                <option value="6">Средняя</option>
                <option value="12">Толстая</option>
                <option value="24">Широкая</option>
              </select>
            </label>
          </div>
          <div className="gartic-tool-group">
            <button
              type="button"
              className="gartic-tool"
              aria-label="Отменить последний штрих"
              title="Отменить последний штрих (Ctrl+Z)"
              disabled={busy || locked || !connected || !ink.length}
              onClick={() => void edit('undo')}
            >
              <Undo2 size={18} />
            </button>
            <button
              type="button"
              className="gartic-tool"
              aria-label="Очистить рисунок"
              disabled={busy || locked || !connected || !ink.length}
              onClick={() => void edit('clear')}
            >
              <Trash2 size={18} />
            </button>
          </div>
        </div>
      )}
      <div className="gartic-paper" data-editable={editable || undefined} data-eraser={eraser || undefined}>
        <svg
          viewBox="0 0 1000 625"
          role="img"
          aria-label={editable ? 'Холст для рисования' : 'Рисунок на столе'}
          tabIndex={editable ? 0 : undefined}
          onPointerDown={begin}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          onLostPointerCapture={end}
        >
          <rect width="1000" height="625" fill="#ffffff" />
          {ink.map((stroke) => (
            <Ink key={stroke.id} stroke={stroke} />
          ))}
          {editable && active && <Ink stroke={active} />}
        </svg>
        {!ink.length && !active && (
          <div className="gartic-paper-empty" aria-hidden="true">
            <Pencil size={30} strokeWidth={1.25} />
            <span>{editable ? 'Ваш первый штрих' : 'Здесь появится рисунок'}</span>
          </div>
        )}
      </div>
      {editable && (
        <div className="gartic-canvas-status" role="status">
          {!connected ? (
            <>
              <WifiOff size={14} /> Связь восстанавливается. Штрихи сохранены на этом устройстве.
            </>
          ) : pending ? (
            'Сохраняем рисунок…'
          ) : (
            'Рисунок сохранён'
          )}
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
              <RotateCw size={15} /> Повторить отправку
            </button>
          )}
        </div>
      )}
    </div>
  );
}
