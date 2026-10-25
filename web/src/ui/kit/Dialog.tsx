import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton } from './IconButton';

/**
 * Диалог поверх приложения: затемнение, окно на `--z-dialog` (50), заголовок, крестик, тело
 * и подвал с действиями. Появляется коротким физичным движением (`--motion-base`,
 * `--ease-emphasized`), уходит быстрее. Фокус возвращается туда, откуда открыли, — Base UI.
 * Если в подвале есть своя «Закрыть», крестику даётся другое имя (`closeLabel`), чтобы на слух
 * это были разные кнопки. `icon` — значок в круге перед заголовком («Поддержка» с гарнитурой).
 */
export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Значок перед заголовком — в круге `--accent-soft`, для диктора не читается. */
  icon?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  closeLabel?: string;
  className?: string;
}

export function Dialog({
  open,
  onOpenChange,
  title,
  icon,
  description,
  children,
  footer,
  size = 'md',
  closeLabel,
  className,
}: DialogProps) {
  const { t } = useTranslation();
  const classes = ['ui-dialog', `ui-dialog--${size}`, className].filter(Boolean).join(' ');
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="ui-dialog__backdrop" />
        <BaseDialog.Viewport className="ui-dialog__viewport">
          <BaseDialog.Popup className={classes}>
            <header className="ui-dialog__head">
              {icon && (
                <span className="ui-dialog__icon" aria-hidden="true">
                  {icon}
                </span>
              )}
              <BaseDialog.Title className="ui-dialog__title">{title}</BaseDialog.Title>
              <BaseDialog.Close
                render={
                  <IconButton label={closeLabel ?? t(($) => $.common.close)} size="sm">
                    <X size={20} />
                  </IconButton>
                }
              />
            </header>
            {description && (
              <BaseDialog.Description className="ui-dialog__description">
                {description}
              </BaseDialog.Description>
            )}
            {children && <div className="ui-dialog__body">{children}</div>}
            {footer && <footer className="ui-dialog__footer">{footer}</footer>}
          </BaseDialog.Popup>
        </BaseDialog.Viewport>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

export const DialogTrigger = BaseDialog.Trigger;
export const DialogClose = BaseDialog.Close;
