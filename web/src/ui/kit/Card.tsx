import type { HTMLAttributes } from 'react';

/**
 * Карточка: поверхность первого уровня с лёгкой тенью вместо рамки. `interactive` — вся
 * карточка нажимается (строка избранного): появляется подсветка при наведении и кольцо фокуса.
 * `level` поднимает её выше — для всплывающих блоков без меню и диалога.
 */
export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  interactive?: boolean;
  level?: 1 | 2 | 3;
  padding?: 'none' | 'sm' | 'md' | 'lg';
}

export function Card({
  interactive = false,
  level = 1,
  padding = 'md',
  className,
  children,
  ...props
}: CardProps) {
  const classes = [
    'ui-card',
    `ui-card--level-${level}`,
    `ui-card--pad-${padding}`,
    interactive && 'ui-card--interactive',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={classes} tabIndex={interactive ? 0 : undefined} {...props}>
      {children}
    </div>
  );
}
