import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { useRef, useState, type ReactNode } from 'react';
import { usePlate } from './usePlate';

/**
 * Сегмент — выбор одного значения из нескольких рядом (S4, R78): «SD / HD» Discord. Радиогруппа
 * Base UI: роли `radiogroup` / `radio`, один стоп Tab на группу, стрелки переключают, недоступный
 * пункт пропускается. Не путать с `Tabs variant="segmented"`: вкладки меняют содержимое под собой,
 * сегмент — значение настройки.
 *
 * Выбранный пункт подсвечивает одна плашка, которая едет к нему (`usePlate`, общий рисунок с вкладками,
 * R123). Недоступный пункт (выше потолка сервера) объясняет причину в `title`, а не строкой под
 * сегментом. Кольцо фокуса — вокруг группы и только с клавиатуры (S1).
 */
export interface SegmentedOption<T extends string | number> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  /** Почему пункт недоступен («Этот сервер допускает до 1080p · 60 fps»). */
  title?: string;
  /** Имя для диктора, когда видимой подписи нет или она — значок. */
  ariaLabel?: string;
}

export interface SegmentedProps<T extends string | number> {
  options: readonly SegmentedOption<T>[];
  value?: T;
  defaultValue?: T;
  onValueChange?: (value: T) => void;
  /** Имя поля формы. Подпись для диктора — `aria-label` или `aria-labelledby`. */
  name?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  /** 32 или 36 px (`--tab-h-sm` / `--tab-h`). */
  size?: 'sm' | 'md';
  /** На всю ширину, пункты равной ширины. */
  full?: boolean;
  disabled?: boolean;
  className?: string;
}

export function Segmented<T extends string | number>({
  options,
  value,
  defaultValue,
  onValueChange,
  name,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  size = 'md',
  full = false,
  disabled,
  className,
}: SegmentedProps<T>) {
  const root = useRef<HTMLDivElement>(null);
  // Своё значение — только чтобы знать, есть ли выбранный пункт, когда сегментом не управляют.
  const [own, setOwn] = useState(defaultValue);
  const selected = value !== undefined ? value : own;
  const index = options.findIndex((option) => option.value === selected);
  usePlate(root, '.ui-segmented__item', '.ui-segmented__item[data-checked]', options.length);

  const classes = [
    'ui-segmented',
    size === 'sm' && 'ui-segmented--sm',
    full && 'ui-segmented--full',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <RadioGroup<T>
      ref={root}
      className={classes}
      value={value}
      defaultValue={defaultValue}
      onValueChange={(next) => {
        setOwn(next);
        onValueChange?.(next);
      }}
      name={name}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      data-empty={index < 0 || undefined}
    >
      <span className="ui-segmented__indicator" aria-hidden="true" />
      {options.map((option) => (
        <Radio.Root
          key={String(option.value)}
          value={option.value}
          disabled={option.disabled}
          title={option.title}
          aria-label={option.ariaLabel}
          className="ui-segmented__item"
        >
          {option.icon && (
            <span className="ui-segmented__icon" aria-hidden="true">
              {option.icon}
            </span>
          )}
          {/* Подпись строкой оставляет место под полужирный выбранный: соседи не сдвигаются. */}
          <span
            className="ui-segmented__label"
            data-label={typeof option.label === 'string' ? option.label : undefined}
          >
            {option.label}
          </span>
        </Radio.Root>
      ))}
    </RadioGroup>
  );
}
