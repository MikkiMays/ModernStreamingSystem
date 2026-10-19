import { Separator as BaseSeparator } from '@base-ui/react/separator';
import type { ComponentProps } from 'react';

/**
 * Разделитель: тонкая линия между группами. Для диктора — `role="separator"`. Там, где
 * глубина задаётся слоями, линии почти нет: она — для списков и меню, не для панелей.
 */
export function Separator({
  className,
  orientation = 'horizontal',
  ...props
}: ComponentProps<typeof BaseSeparator>) {
  const classes = ['ui-separator', `ui-separator--${orientation}`, className].filter(Boolean).join(' ');
  return <BaseSeparator orientation={orientation} className={classes} {...props} />;
}
