import { Dialog } from '@base-ui/react/dialog';
import { useTranslation } from 'react-i18next';
import { isDesktop } from '../core/desktop';
import { X } from 'lucide-react';
import { useSyncExternalStore, type ReactNode, type ButtonHTMLAttributes } from 'react';
import type { Store } from '../core/store';
import { AppIcon } from './brand/Logo';
import { Slider as KitSlider, type SliderProps } from './kit/Slider';

export { AppIcon, Logo } from './brand/Logo';

/**
 * Ссылка на клиент для Windows.
 *
 * Ведёт на `/download` всегда: если сборки на сервере сейчас нет, страница так и скажет.
 * Скрывается лишь там, где бессмысленна, — внутри самого приложения. Номера версии в подсказке
 * нет (T58): его показывает только «О программе», поэтому и спрашивать манифест здесь незачем.
 */
export function DownloadLink({ className = 'shell-download' }: { className?: string }) {
  const { t } = useTranslation();
  if (isDesktop()) return null;
  return (
    <a className={className} href="/download" title={t(($) => $.app.downloadTitle)}>
      <AppIcon size={22} />
      <span>{t(($) => $.app.downloadLabel)}</span>
    </a>
  );
}

export type Theme = 'system' | 'light' | 'dark';
export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
/**
 * Отвечает ли устройство на этот запрос вёрстки прямо сейчас.
 *
 * Для случаев, где одним CSS не обойтись: на телефоне часть кнопок не прячется, а переезжает
 * в меню, и это решает разметка, а не стиль. `useSyncExternalStore` — чтобы не расходиться
 * с серверной отрисовкой и не хранить копию состояния, которое и так есть у браузера.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = (listener: () => void) => {
    if (typeof matchMedia !== 'function') return () => {};
    const media = matchMedia(query);
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  };
  return useSyncExternalStore(
    subscribe,
    () => typeof matchMedia === 'function' && matchMedia(query).matches,
    () => false,
  );
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
/**
 * Прежнее имя ползунка — тот же `Slider` набора (R14): шаг 1, заливка от значения, запись по
 * отпусканию (`onValueCommitted`). Класс `.slider` остаётся: по нему правила кинозала и столов
 * перекрашивают дорожку на тёмном пульте.
 */
export function Slider({ className, ...props }: SliderProps) {
  return <KitSlider {...props} className={className ? `slider ${className}` : 'slider'} />;
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
  closeLabel,
}: {
  wide?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  closeLabel?: string;
}) {
  const { t } = useTranslation();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="modal-backdrop" />
        <Dialog.Popup className={`modal ${wide ? 'modal-wide' : ''}`}>
          <div className="modal-heading">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close
              render={
                <IconButton label={closeLabel ?? t(($) => $.common.close)}>
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
  const { t } = useTranslation();
  const color = [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 5;
  // Only a data URI is rendered. A picture arrives from another participant through the room,
  // so it must never be able to name an address this browser would go and fetch.
  const picture = src && src.startsWith('data:image/') ? src : null;
  return (
    <span className={`avatar avatar-${color} ${large ? 'avatar-large' : ''}`} aria-hidden="true">
      {picture ? (
        <img className="avatar-image" src={picture} alt="" />
      ) : (
        name.trim().slice(0, 1).toLocaleUpperCase() || t(($) => $.common.guestInitial)
      )}
    </span>
  );
}
