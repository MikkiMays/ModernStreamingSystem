import type { CSSProperties, InputHTMLAttributes } from 'react';

/**
 * Ползунок, у которого ноль пуст, а сотня полна.
 *
 * Нативный `input[type=range]` — клавиатура, диктор и касание даром. Заливка считается от
 * самого значения (`--slider-p`, доля от 0 до 1), а бегунок её накрывает: на краях расхождение
 * нативной заливки «до центра бегунка» прячется под ним. Кольцо фокуса — только с клавиатуры
 * (`:focus-visible`, T31): клик мышью по бегунку кольца не рисует.
 */
export interface SliderProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'value' | 'min' | 'max'
> {
  min?: number;
  max?: number;
  value: number;
  /** Подпись для диктора, когда рядом нет видимой `<label>`. */
  label?: string;
}

export function Slider({ min = 0, max = 100, value, label, className, style, ...props }: SliderProps) {
  const span = max - min || 1;
  const filled = Math.min(1, Math.max(0, (value - min) / span));
  return (
    <input
      {...props}
      type="range"
      min={min}
      max={max}
      value={value}
      aria-label={label}
      className={className ? `ui-slider ${className}` : 'ui-slider'}
      style={{ ...style, '--slider-p': filled } as CSSProperties}
    />
  );
}
