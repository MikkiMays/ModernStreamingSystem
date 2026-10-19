import type { ComponentProps } from 'react';

/**
 * Кнопка-значок. Имя обязательно: оно и для диктора, и для подсказки при наведении.
 * `pressed` — переключатель состояния (микрофон, камера): `aria-pressed` и свой вид.
 * `tone="stage"` — на тёмной медиасцене и в пульте, где фон всегда тёмный.
 */
export interface IconButtonProps extends ComponentProps<'button'> {
  label: string;
  variant?: 'ghost' | 'solid' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  pressed?: boolean;
  tone?: 'theme' | 'stage';
}

export function IconButton({
  label,
  variant = 'ghost',
  size = 'md',
  pressed,
  tone = 'theme',
  className,
  children,
  type = 'button',
  ...props
}: IconButtonProps) {
  const classes = [
    'ui-icon-button',
    `ui-icon-button--${variant}`,
    `ui-icon-button--${size}`,
    tone === 'stage' && 'ui-icon-button--stage',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      type={type}
      className={classes}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      data-pressed={pressed || undefined}
      {...props}
    >
      {children}
    </button>
  );
}
