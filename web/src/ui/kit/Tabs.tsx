import { Tabs as BaseTabs } from '@base-ui/react/tabs';
import { Children, useRef, type ComponentProps, type ReactNode } from 'react';
import { usePlate } from './usePlate';

/**
 * Вкладки. `segmented` — плотный переключатель в панели (Люди / Чат / Интеграции): дорожка и светлая
 * плашка выбранной вкладки, которая едет к ней (R123, общий рисунок с `Segmented`). `line` — вкладки
 * страницы с подчёркиванием. Стрелки влево-вправо переключают, фокус-кольцо только с клавиатуры.
 */
export interface TabsProps extends Omit<ComponentProps<typeof BaseTabs.Root>, 'className'> {
  variant?: 'segmented' | 'line';
  className?: string;
}

export function Tabs({ variant = 'segmented', className, ...props }: TabsProps) {
  const classes = ['ui-tabs', `ui-tabs--${variant}`, className].filter(Boolean).join(' ');
  return <BaseTabs.Root className={classes} {...props} />;
}

/**
 * Плашка — своя, а не `Tabs.Indicator` Base UI: тот считает смещение от `clientLeft` (целые
 * CSS-пиксели) и ставит его `translate` — на 125 % плашка стояла на полпикселя мимо вкладки с
 * размытым краем (`usePlate`).
 */
export function TabList({ className, children, ...props }: ComponentProps<typeof BaseTabs.List>) {
  const list = useRef<HTMLDivElement>(null);
  usePlate(list, '.ui-tabs__tab', ".ui-tabs__tab[aria-selected='true']", Children.count(children));
  return (
    <BaseTabs.List
      ref={list}
      className={className ? `ui-tabs__list ${className}` : 'ui-tabs__list'}
      {...props}
    >
      {children}
      <span className="ui-tabs__indicator" aria-hidden="true" />
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
      <span className="ui-tabs__label">{children}</span>
    </BaseTabs.Tab>
  );
}

export function TabPanel({ className, ...props }: ComponentProps<typeof BaseTabs.Panel>) {
  return (
    <BaseTabs.Panel className={className ? `ui-tabs__panel ${className}` : 'ui-tabs__panel'} {...props} />
  );
}
