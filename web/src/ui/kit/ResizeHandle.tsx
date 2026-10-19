import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

/**
 * Ручка-разделитель тянущейся панели — одна на все панели (T46, П11).
 *
 * Курсор `col-resize`, полоса видна при наведении и всё время, пока тянут; клавиатура —
 * стрелки по 16 px (с Shift — по 64), Home и End — к пределам, двойное нажатие — к ширине по
 * умолчанию. `edge` говорит, с какой стороны от ручки стоит панель: `start` — панель слева
 * (главная, список разделов), `end` — справа (панель встречи). От этого зависит, в какую
 * сторону движение мыши делает панель шире.
 */
export interface ResizeHandleProps {
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
  onReset?: () => void;
  /** Где панель относительно ручки. */
  edge?: 'start' | 'end';
  label: string;
  step?: number;
  className?: string;
}

export function ResizeHandle({
  value,
  min,
  max,
  onChange,
  onReset,
  edge = 'start',
  label,
  step = 16,
  className,
}: ResizeHandleProps) {
  const [dragging, setDragging] = useState(false);
  const origin = useRef<{ x: number; width: number } | null>(null);
  const direction = edge === 'start' ? 1 : -1;
  const clamp = (next: number) => Math.min(max, Math.max(min, next));

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = event.shiftKey ? step * 4 : step;
    const moves: Record<string, number | undefined> = {
      ArrowRight: value + delta * direction,
      ArrowLeft: value - delta * direction,
      Home: min,
      End: max,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    onChange(clamp(next));
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    origin.current = { x: event.clientX, width: value };
    setDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!origin.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    onChange(clamp(origin.current.width + (event.clientX - origin.current.x) * direction));
  };
  const onPointerUp = () => {
    origin.current = null;
    setDragging(false);
  };

  return (
    <div
      className={className ? `ui-handle ${className}` : 'ui-handle'}
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      data-dragging={dragging || undefined}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onLostPointerCapture={onPointerUp}
      onDoubleClick={onReset}
    >
      <span className="ui-handle__bar" aria-hidden="true" />
    </div>
  );
}
