import { Dialog } from '@base-ui/react/dialog';
import { Monitor, Moon, Sun, X } from 'lucide-react';
import {
  useEffect,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
  type ButtonHTMLAttributes,
} from 'react';
import type { Store } from '../core/store';
import { windowsRelease } from '../core/download';

/**
 * The application's own mark, in the proportions of `Cord.ico`: three bars leaning fifteen
 * degrees on a blue tile. Drawn rather than fetched so it is crisp at any size and needs no
 * second request.
 */
export function AppIcon({ size = 64 }: { size?: number }) {
  return (
    <span className="app-icon" style={{ '--icon': `${size}px` } as CSSProperties} aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

/**
 * Offered only where it can be honoured: a server whose operator never published a Windows
 * build has nothing behind this link, and the application itself is already the download.
 */
export function DownloadLink() {
  const [version, setVersion] = useState('');
  useEffect(() => {
    if (window.chrome?.webview) return;
    let active = true;
    void windowsRelease().then((release) => {
      if (active && release) setVersion(release.version);
    });
    return () => {
      active = false;
    };
  }, []);
  if (!version) return null;
  return (
    <a className="download-link" href="/download" title={`Cord для Windows ${version}`}>
      <AppIcon size={22} />
      <span>Скачать Cord</span>
    </a>
  );
}

export type Theme = 'system' | 'light' | 'dark';
export function ThemeButton({ theme, setTheme }: { theme: Theme; setTheme: (theme: Theme) => void }) {
  const next = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
  return (
    <IconButton
      label={`Тема: ${theme === 'system' ? 'системная' : theme === 'light' ? 'светлая' : 'тёмная'}. Переключить`}
      onClick={() => setTheme(next)}
    >
      {theme === 'system' ? (
        <Monitor size={20} />
      ) : theme === 'light' ? (
        <Sun size={20} />
      ) : (
        <Moon size={20} />
      )}
    </IconButton>
  );
}

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
  // A dialog that has its own «Закрыть» button must not also have a corner cross called the
  // same thing: two controls, one name, and nothing to tell them apart by ear.
  closeLabel = 'Закрыть',
}: {
  wide?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  closeLabel?: string;
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
                <IconButton label={closeLabel}>
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
export function Avatar({
  name,
  large = false,
  src = null,
}: {
  name: string;
  large?: boolean;
  src?: string | null;
}) {
  const color = [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 5;
  // Only a data URI is rendered. A picture arrives from another participant through the room,
  // so it must never be able to name an address this browser would go and fetch.
  const picture = src && src.startsWith('data:image/') ? src : null;
  return (
    <span className={`avatar avatar-${color} ${large ? 'avatar-large' : ''}`} aria-hidden="true">
      {picture ? (
        <img className="avatar-image" src={picture} alt="" />
      ) : (
        name.trim().slice(0, 1).toLocaleUpperCase() || 'Г'
      )}
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
