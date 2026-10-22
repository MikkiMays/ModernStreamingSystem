import { Menu as BaseMenu } from '@base-ui/react/menu';
import { ChevronRight } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';

/**
 * Меню по образцу владельца (`refs/README.md`, меню ChatGPT): значок слева, название,
 * сочетание клавиш справа серым, подменю со стрелкой, группы разделены линиями, разрушительное
 * действие последним и красным. Слой — `--z-menu` (40). Открывается по кнопке, ПКМ и долгому
 * касанию — это решает триггер снаружи.
 */
export const Menu = BaseMenu.Root;
export const MenuTrigger = BaseMenu.Trigger;
export const MenuGroup = BaseMenu.Group;
export const MenuCheckboxItem = BaseMenu.CheckboxItem;
export const MenuRadioGroup = BaseMenu.RadioGroup;
export const MenuRadioItem = BaseMenu.RadioItem;

export interface MenuContentProps extends ComponentProps<typeof BaseMenu.Popup> {
  side?: ComponentProps<typeof BaseMenu.Positioner>['side'];
  align?: ComponentProps<typeof BaseMenu.Positioner>['align'];
  sideOffset?: number;
}

export function MenuContent({
  side = 'bottom',
  align = 'start',
  sideOffset = 6,
  className,
  ...props
}: MenuContentProps) {
  return (
    <BaseMenu.Portal>
      <BaseMenu.Positioner className="ui-menu__positioner" side={side} align={align} sideOffset={sideOffset}>
        <BaseMenu.Popup className={className ? `ui-menu ${className}` : 'ui-menu'} {...props} />
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  );
}

export interface MenuItemProps extends ComponentProps<typeof BaseMenu.Item> {
  icon?: ReactNode;
  shortcut?: string;
  destructive?: boolean;
}

export function MenuItem({
  icon,
  shortcut,
  destructive = false,
  className,
  children,
  ...props
}: MenuItemProps) {
  const classes = ['ui-menu__item', destructive && 'ui-menu__item--destructive', className]
    .filter(Boolean)
    .join(' ');
  return (
    <BaseMenu.Item className={classes} {...props}>
      <span className="ui-menu__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="ui-menu__label">{children}</span>
      {shortcut && <kbd className="ui-menu__shortcut">{shortcut}</kbd>}
    </BaseMenu.Item>
  );
}

export interface MenuSwitchItemProps extends Omit<
  ComponentProps<typeof BaseMenu.CheckboxItem>,
  'children' | 'className'
> {
  /** Постоянный значок слева: состояние показывает переключатель, а не смена значка. */
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * Пункт меню с переключателем (X4, R70): «Автоподключение» и другие да/нет прямо в меню. Роль —
 * `menuitemcheckbox` с `aria-checked` (на неё опираются e2e и диктор); в третьей колонке —
 * неинтерактивный переключатель того же вида, что `Switch`. Настоящий `Switch` внутрь не кладётся:
 * вложенный интерактив поймал бы axe. Щелчок не закрывает меню — видно, что переключилось.
 */
export function MenuSwitchItem({
  icon,
  children,
  closeOnClick = false,
  className,
  ...props
}: MenuSwitchItemProps) {
  return (
    <BaseMenu.CheckboxItem
      className={['ui-menu__item', 'ui-menu__item--switch', className].filter(Boolean).join(' ')}
      closeOnClick={closeOnClick}
      {...props}
    >
      <span className="ui-menu__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="ui-menu__label">{children}</span>
      <span className="ui-switch ui-switch--menu" aria-hidden="true">
        <span className="ui-switch__thumb" />
      </span>
    </BaseMenu.CheckboxItem>
  );
}

export function MenuLabel({ className, ...props }: ComponentProps<typeof BaseMenu.GroupLabel>) {
  return (
    <BaseMenu.GroupLabel
      className={className ? `ui-menu__group-label ${className}` : 'ui-menu__group-label'}
      {...props}
    />
  );
}

export function MenuSeparator({ className, ...props }: ComponentProps<typeof BaseMenu.Separator>) {
  return (
    <BaseMenu.Separator
      className={className ? `ui-menu__separator ${className}` : 'ui-menu__separator'}
      {...props}
    />
  );
}

export interface MenuSubmenuProps {
  icon?: ReactNode;
  label: ReactNode;
  children: ReactNode;
}

/** Подменю: пункт со стрелкой вправо (значок `--icon-sm`, не символ «›»), раскрывается справа. */
export function MenuSubmenu({ icon, label, children }: MenuSubmenuProps) {
  return (
    <BaseMenu.SubmenuRoot>
      <BaseMenu.SubmenuTrigger className="ui-menu__item ui-menu__item--submenu">
        <span className="ui-menu__icon" aria-hidden="true">
          {icon}
        </span>
        <span className="ui-menu__label">{label}</span>
        <span className="ui-menu__chevron" aria-hidden="true">
          <ChevronRight />
        </span>
      </BaseMenu.SubmenuTrigger>
      <BaseMenu.Portal>
        <BaseMenu.Positioner className="ui-menu__positioner" side="right" align="start" sideOffset={4}>
          <BaseMenu.Popup className="ui-menu">{children}</BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.SubmenuRoot>
  );
}
