import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { Meeting } from '../core/meeting';
import { useToast } from './kit';

/**
 * Вход с выключенным «звуком встречи» (R156, Р-40): выбор помнится между встречами, и без тоста
 * человек решил бы, что во встрече тишина. Тост называет причину и включает звук одним нажатием.
 */
export function DeafenedNotice({ meeting }: { meeting: Meeting }) {
  const { t } = useTranslation();
  const toast = useToast();
  useEffect(() => {
    if (!meeting.media.deafened.get()) return;
    const id = toast.add({
      title: t(($) => $.meeting.deafened.title),
      type: 'info',
      timeout: 10_000,
      actionProps: {
        children: t(($) => $.dock.undeafen),
        onClick: () => {
          void meeting.media.setDeafened(false);
          toast.close(id);
        },
      },
    });
    // Один раз на вход: дальше состояние видно по красной кнопке с наушниками.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meeting]);
  return null;
}
