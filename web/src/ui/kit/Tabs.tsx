import { Tabs as BaseTabs } from '@base-ui/react/tabs';
import type { ComponentProps, ReactNode } from 'react';

/**
 * Вкладки. `segmented` — плотный переключатель в панели (Люди / Чат / Боты): активная вкладка
 * — светлая плашка, которая едет под палец (`Tabs.Indicator`). `line` — вкладки страницы с
 * подчёркиванием. Стрелки влево-вправо переключают, фокус-кольцо только с клавиатуры.
 */
export interface TabsProps extends Omit<ComponentProps<typeof BaseTabs.Root>, 'className'> {
  variant?: 'segmented' | 'line';
  className?: string;
}

export function Tabs({ variant = 'segmented', className, ...props }: TabsProps) {
  const classes = ['ui-tabs', `ui-tabs--${variant}`, className].filter(Boolean).join(' ');
  return <BaseTabs.Root className={classes} {...props} />;
}

export function TabList({ className, children, ...props }: ComponentProps<typeof BaseTabs.List>) {
  return (
    <BaseTabs.List className={className ? `ui-tabs__list ${className}` : 'ui-tabs__list'} {...props}>
      {children}
      <BaseTabs.Indicator className="ui-tabs__indicator" />
    </BaseTabs.List>
  );
}

export function Tab({
  className,
  icon,
  children,
  ...props
}: ComponentProps<typeof BaseTabs.Tab> & { icon?: ReactNode }) {
  return (
    <BaseTabs.Tab className={className ? `ui-tabs__tab ${className}` : 'ui-tabs__tab'} {...props}>
      {icon && (
        <span className="ui-tabs__icon" aria-hidden="true">
          {icon}
        </span>
      )}
      {children}
    </BaseTabs.Tab>
  );
}

export function TabPanel({ className, ...props }: ComponentProps<typeof BaseTabs.Panel>) {
  return (
    <BaseTabs.Panel className={className ? `ui-tabs__panel ${className}` : 'ui-tabs__panel'} {...props} />
  );
}
