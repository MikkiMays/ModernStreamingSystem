import { Popover as BasePopover } from '@base-ui/react/popover';
import { X } from 'lucide-react';
import type { CSSProperties, ReactElement, ReactNode, RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Drawer, type DrawerProps } from './Drawer';
import { IconButton } from './IconButton';
import { PHONE_QUERY, useMediaQuery } from './useMediaQuery';

/**
 * Всплывающая карточка у кнопки (DESIGN.md → «Новые компоненты набора»): виджет музыки, быстрые
 * настройки — то, что управляет, не уводя с экрана. Popover Base UI: кнопка получает
 * `aria-expanded` и `aria-haspopup="dialog"`, Esc и щелчок мимо закрывают, фокус возвращается кнопке
 * (без кольца, если открывали мышью, — S1). Слой — над меню (`--z-menu` + 1), под диалогами.
 *
 * На телефоне (≤ 767 px) та же карточка становится листом снизу (`Drawer`): карточка у кнопки на
 * узком экране закрывает её же и прыгает от края к краю. `mobile="popover"` оставляет карточку.
 */
export interface PopoverProps {
  trigger: ReactElement;
  children?: ReactNode;
  /** Заголовок с крестиком («Сейчас играет»). */
  title?: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  /** Ширина карточки: число пикселей, `trigger` — по кнопке, по умолчанию — по содержимому. */
  width?: number | 'trigger';
  /**
   * К чему прикладывать карточку, если не к самой кнопке: мини-плеер открывается нажатием на трек,
   * а карточка встаёт под всей полосой, а не под её левой частью.
   */
  anchor?: RefObject<Element | null>;
  modal?: boolean;
  mobile?: 'drawer' | 'popover';
  /** Высота листа на телефоне: виджету музыки — 85 % экрана (DESIGN → «Плеер»). */
  drawerHeight?: DrawerProps['height'];
  closeLabel?: string;
  className?: string;
}

export function Popover({
  trigger,
  children,
  title,
  open,
  defaultOpen,
  onOpenChange,
  side = 'bottom',
  align = 'end',
  sideOffset = 8,
  width,
  anchor,
  modal = false,
  mobile = 'drawer',
  drawerHeight,
  closeLabel,
  className,
}: PopoverProps) {
  const { t } = useTranslation();
  const phone = useMediaQuery(PHONE_QUERY);
  if (phone && mobile === 'drawer')
    return (
      <Drawer
        trigger={trigger}
        open={open}
        defaultOpen={defaultOpen}
        onOpenChange={onOpenChange}
        title={title}
        height={drawerHeight}
        closeLabel={closeLabel}
        className={className}
      >
        {children}
      </Drawer>
    );
  const style: CSSProperties | undefined =
    width === 'trigger' ? { width: 'var(--anchor-width)' } : width ? { width } : undefined;
  return (
    <BasePopover.Root
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={(next) => onOpenChange?.(next)}
      modal={modal}
    >
      <BasePopover.Trigger render={trigger} />
      <BasePopover.Portal>
        <BasePopover.Positioner
          className="ui-popover__positioner"
          anchor={anchor}
          side={side}
          align={align}
          sideOffset={sideOffset}
        >
          <BasePopover.Popup className={className ? `ui-popover ${className}` : 'ui-popover'} style={style}>
            {title && (
              <header className="ui-popover__head">
                <BasePopover.Title className="ui-popover__title">{title}</BasePopover.Title>
                <BasePopover.Close
                  render={
                    <IconButton label={closeLabel ?? t(($) => $.common.close)} size="sm">
                      <X />
                    </IconButton>
                  }
                />
              </header>
            )}
            <div className="ui-popover__body">{children}</div>
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  );
}
