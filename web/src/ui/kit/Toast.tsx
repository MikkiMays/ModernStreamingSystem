import { Toast as BaseToast } from '@base-ui/react/toast';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton } from './IconButton';

/**
 * Тосты: короткие сообщения внизу по центру, слой `--z-toast` (70) — выше загрузки и
 * диалогов. `ToastProvider` оборачивает приложение один раз; `useToast()` в любом месте:
 * `toast.add({ title: 'Ссылка скопирована' })`. `type` красит полоску слева: `success`,
 * `danger`, `info`. Тост сам уходит через 5 с, при наведении ждёт; с клавиатуры — F6 к тостам.
 */
export const useToast = BaseToast.useToastManager;

export function ToastProvider({
  children,
  place,
}: {
  children: ReactNode;
  /** Во встрече тосты встают над пультом звонка, а не на него (R142). */
  place?: 'meeting';
}) {
  const { t } = useTranslation();
  return (
    <BaseToast.Provider>
      {children}
      <BaseToast.Portal>
        <BaseToast.Viewport
          className="ui-toast__viewport"
          data-place={place}
          aria-label={t(($) => $.kit.toasts)}
        >
          <ToastList />
        </BaseToast.Viewport>
      </BaseToast.Portal>
    </BaseToast.Provider>
  );
}

function ToastList() {
  const { t } = useTranslation();
  const { toasts } = BaseToast.useToastManager();
  return toasts.map((toast) => (
    <BaseToast.Root key={toast.id} toast={toast} className="ui-toast" data-type={toast.type}>
      <BaseToast.Content className="ui-toast__content">
        <BaseToast.Title className="ui-toast__title" />
        <BaseToast.Description className="ui-toast__description" />
      </BaseToast.Content>
      {toast.actionProps && <BaseToast.Action className="ui-toast__action" />}
      <BaseToast.Close
        className="ui-toast__close"
        render={
          <IconButton label={t(($) => $.common.close)} size="sm">
            <X size={16} />
          </IconButton>
        }
      />
    </BaseToast.Root>
  ));
}
