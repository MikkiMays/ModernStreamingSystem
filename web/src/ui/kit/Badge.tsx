import type { HTMLAttributes } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Бейдж: короткое слово рядом с названием. `live` — «В эфире» на плитке того, кто показывает
 * экран; `soon` — возможность, которой пока нет; `new` — свежий раздел; `count` — число.
 */
export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: 'neutral' | 'accent' | 'success' | 'danger' | 'live' | 'soon' | 'new' | 'count';
}

export function Badge({ variant = 'neutral', className, children, ...props }: BadgeProps) {
  const classes = ['ui-badge', `ui-badge--${variant}`, className].filter(Boolean).join(' ');
  return (
    <span className={classes} {...props}>
      {children}
    </span>
  );
}

/** «Скоро» — у возможности, которая объявлена, но ещё не работает. */
export function Soon(props: Omit<BadgeProps, 'variant' | 'children'>) {
  const { t } = useTranslation();
  return (
    <Badge variant="soon" {...props}>
      {t(($) => $.kit.soon)}
    </Badge>
  );
}
