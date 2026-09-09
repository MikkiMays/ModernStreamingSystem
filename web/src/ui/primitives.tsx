import { Dialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import { useSyncExternalStore, type ReactNode, type ButtonHTMLAttributes } from 'react';
import type { Store } from '../core/store';

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
export function IconButton({
  label,
  children,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button type="button" aria-label={label} title={label} className={`icon-button ${className}`} {...props}>
      {children}
    </button>
  );
}
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide = false,
}: {
  wide?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="modal-backdrop" />
        <Dialog.Popup className={`modal ${wide ? 'modal-wide' : ''}`}>
          <div className="modal-heading">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close
              render={
                <IconButton label="Закрыть">
                  <X size={20} />
                </IconButton>
              }
            />
          </div>
          {description && <Dialog.Description className="muted">{description}</Dialog.Description>}
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function Avatar({ name, large = false }: { name: string; large?: boolean }) {
  const color = [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 5;
  return (
    <span className={`avatar avatar-${color} ${large ? 'avatar-large' : ''}`} aria-hidden="true">
      {name.trim().slice(0, 1).toLocaleUpperCase() || 'Г'}
    </span>
  );
}
export function Logo() {
  return (
    <span className="brand">
      <span className="brand-symbol" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      cord<span className="brand-dot">.</span>
    </span>
  );
}
