import type { ComponentProps, ReactNode } from 'react';

/**
 * Кнопка. `primary` — одно главное действие на экране, `secondary` — остальные, `quiet` —
 * действие в строке текста или в панели, `danger` — разрушительное («Сбросить», «Удалить»).
 * Размер `lg` — для касания (48 px); на устройствах с грубым указателем любой размер не
 * меньше 44 px — это делает CSS. Фокус-кольцо только с клавиатуры (`:focus-visible`, T31).
 */
export interface ButtonProps extends ComponentProps<'button'> {
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  /** Значок слева от подписи. */
  icon?: ReactNode;
  /** Кнопка ждёт ответа: нажать нельзя, подпись остаётся, чтобы ширина не прыгала. */
  loading?: boolean;
  full?: boolean;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  loading = false,
  full = false,
  className,
  children,
  disabled,
  type = 'button',
  ...props
}: ButtonProps) {
  const classes = [
    'ui-button',
    `ui-button--${variant}`,
    `ui-button--${size}`,
    full && 'ui-button--full',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      type={type}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      data-loading={loading || undefined}
      {...props}
    >
      {icon && (
        <span className="ui-button__icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="ui-button__label">{children}</span>
      {loading && <span className="ui-spinner" aria-hidden="true" />}
    </button>
  );
}
