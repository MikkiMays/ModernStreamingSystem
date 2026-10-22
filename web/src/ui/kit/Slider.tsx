import { useEffect, useEffectEvent, useRef, type ComponentProps, type CSSProperties, type Ref } from 'react';

/**
 * Ползунок, у которого ноль пуст, а сотня полна (R14 — один на всё приложение).
 *
 * Нативный `input[type=range]` — клавиатура, диктор и касание даром. Заливка считается от
 * самого значения (`--slider-p`, доля от 0 до 1), а бегунок её накрывает: на краях расхождение
 * нативной заливки «до центра бегунка» прячется под ним. Кольцо фокуса — только с клавиатуры (S1).
 *
 * Шаг по умолчанию — 1. `onChange` приходит на каждое движение (заливка, подпись значения), а
 * `onValueCommitted` — когда значение окончательное: бегунок отпустили или сдвинули клавишей
 * (событие `change` браузера). Туда — запись настроек и всё дорогое: перетаскивание не должно
 * писать хранилище на каждый пиксель.
 */
export interface SliderProps extends Omit<
  ComponentProps<'input'>,
  'type' | 'value' | 'min' | 'max' | 'step'
> {
  min?: number;
  max?: number;
  step?: number;
  value: number;
  /** Подпись для диктора, когда рядом нет видимой `<label>`. */
  label?: string;
  /** Окончательное значение: бегунок отпущен или сдвинут клавишей. */
  onValueCommitted?: (value: number) => void;
}

export function Slider({
  min = 0,
  max = 100,
  step = 1,
  value,
  label,
  className,
  style,
  onValueCommitted,
  ref,
  ...props
}: SliderProps) {
  const input = useRef<HTMLInputElement>(null);
  const commit = useEffectEvent((element: HTMLInputElement) => onValueCommitted?.(Number(element.value)));
  // `change` у ползунка — отпускание, а React зовёт `onChange` на каждое `input`: слушаем сами.
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    const committed = () => commit(element);
    element.addEventListener('change', committed);
    return () => element.removeEventListener('change', committed);
  }, []);
  const span = max - min || 1;
  const filled = Math.min(1, Math.max(0, (value - min) / span));
  return (
    <input
      {...props}
      ref={merge(input, ref)}
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      aria-label={label ?? props['aria-label']}
      className={className ? `ui-slider ${className}` : 'ui-slider'}
      style={{ ...style, '--slider-p': filled } as CSSProperties}
    />
  );
}

/** Своя ссылка и та, что передали снаружи, — на один и тот же элемент. */
function merge<T>(own: { current: T | null }, outer: Ref<T> | undefined) {
  if (!outer) return own;
  return (element: T | null) => {
    own.current = element;
    if (typeof outer === 'function') return outer(element);
    outer.current = element;
  };
}
