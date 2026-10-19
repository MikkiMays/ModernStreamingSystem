import { Switch as BaseSwitch } from '@base-ui/react/switch';
import type { ReactNode } from 'react';

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
  ariaLabel,
  name,
  className,
}: SwitchProps) {
  const control = (
    <BaseSwitch.Root
      className="ui-switch"
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      name={name}
      aria-label={label === undefined ? ariaLabel : undefined}
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
        <span className="ui-switch-row__label">{label}</span>
        {description && <span className="ui-switch-row__hint">{description}</span>}
      </span>
      {control}
    </label>
  );
}
