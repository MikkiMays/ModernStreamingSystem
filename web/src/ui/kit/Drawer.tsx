import { Drawer as BaseDrawer } from '@base-ui/react/drawer';
import { X } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton } from './IconButton';

/**
 * Лист снизу — окно для пальца (DESIGN.md → «Новые компоненты набора»): плеер, виджет музыки,
 * длинные меню на телефоне. Drawer Base UI: модальный, подложка `--scrim`, Esc и щелчок мимо
 * закрывают, ручку можно стянуть вниз — лист идёт за пальцем и закрывается по порогу или скорости.
 * Высота — по содержимому или долей экрана (`50` / `85` / `full`, в `dvh`), прокрутка — внутри
 * листа, низ — с отступом под жест «домой» (`safe-area-inset-bottom`). Слой — `--z-dialog`.
 */
export interface DrawerProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  title?: ReactNode;
  /** Кнопка, которая открывает лист, — если им не управляют снаружи. */
  trigger?: ReactElement;
  height?: 'auto' | '50' | '85' | 'full';
  /** `false` — лист не закрывается ни жестом, ни щелчком мимо, ни Esc: только своими кнопками. */
  dismissible?: boolean;
  closeLabel?: string;
  className?: string;
  children?: ReactNode;
}

export function Drawer({
  open,
  defaultOpen,
  onOpenChange,
  title,
  trigger,
  height = 'auto',
  dismissible = true,
  closeLabel,
  className,
  children,
}: DrawerProps) {
  const { t } = useTranslation();
  const classes = ['ui-drawer', `ui-drawer--${height}`, className].filter(Boolean).join(' ');
  return (
    <BaseDrawer.Root
      open={open}
      defaultOpen={defaultOpen}
      disablePointerDismissal={!dismissible}
      onOpenChange={(next, details) => {
        if (!next && !dismissible && details.reason !== 'close-press') {
          details.cancel();
          return;
        }
        onOpenChange?.(next);
      }}
    >
      {trigger && <BaseDrawer.Trigger render={trigger} />}
      <BaseDrawer.Portal>
        <BaseDrawer.Backdrop className="ui-drawer__backdrop" />
        <BaseDrawer.Viewport className="ui-drawer__viewport">
          <BaseDrawer.Popup className={classes}>
            <div className="ui-drawer__handle" aria-hidden="true" />
            <BaseDrawer.Content className="ui-drawer__content">
              {title && (
                <header className="ui-drawer__head">
                  <BaseDrawer.Title className="ui-drawer__title">{title}</BaseDrawer.Title>
                  <BaseDrawer.Close
                    render={
                      <IconButton label={closeLabel ?? t(($) => $.common.close)}>
                        <X />
                      </IconButton>
                    }
                  />
                </header>
              )}
              <div className="ui-drawer__body">{children}</div>
            </BaseDrawer.Content>
          </BaseDrawer.Popup>
        </BaseDrawer.Viewport>
      </BaseDrawer.Portal>
    </BaseDrawer.Root>
  );
}
