import { Switch as BaseSwitch } from '@base-ui/react/switch';
import { useId, type ReactNode } from 'react';
import { HintIcon } from './HintIcon';

/**
 * Переключатель «включено / выключено». С подписью — одна строка, нажимается целиком;
 * без подписи нужен `label` для диктора. Движение бегунка — `--motion-fast`, при
 * `prefers-reduced-motion` длительность из токенов становится нулём.
 */
export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Видимая подпись; переключатель становится строкой настройки. */
  label?: ReactNode;
  description?: ReactNode;
  /**
   * Пояснение значком «?» у подписи (R173) — по наведению, а не строкой под ней. В имя переключателя
   * не входит: для диктора это описание.
   */
  hint?: string;
  /** Имя значка «?» для диктора. */
  hintLabel?: string;
  /** Имя для диктора, когда видимой подписи нет (переключатель в шапке, в строке таблицы). */
  ariaLabel?: string;
  name?: string;
  className?: string;
}

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  label,
  description,
  hint,
  hintLabel,
  ariaLabel,
  name,
  className,
}: SwitchProps) {
  const labelId = useId();
  const hintId = useId();
  const control = (
    <BaseSwitch.Root
      className="ui-switch"
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      name={name}
      aria-label={label === undefined ? ariaLabel : undefined}
      aria-labelledby={hint && label !== undefined ? labelId : undefined}
      aria-describedby={hint ? hintId : undefined}
    >
      <BaseSwitch.Thumb className="ui-switch__thumb" />
    </BaseSwitch.Root>
  );
  if (label === undefined) return control;
  return (
    <label
      className={className ? `ui-switch-row ${className}` : 'ui-switch-row'}
      data-disabled={disabled || undefined}
    >
      <span className="ui-switch-row__text">
        {hint ? (
          <span className="ui-switch-row__head">
            <span className="ui-switch-row__label" id={labelId}>
              {label}
            </span>
            <HintIcon text={hint} label={hintLabel} focusable id={hintId} />
          </span>
        ) : (
          <span className="ui-switch-row__label">{label}</span>
        )}
        {description && <span className="ui-switch-row__hint">{description}</span>}
      </span>
      {control}
    </label>
  );
}
