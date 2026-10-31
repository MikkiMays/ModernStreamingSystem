import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { inviteLink, takeInviteCopy } from '../core/invite-copy';
import type { Meeting } from '../core/meeting';
import { useToast } from './kit';

/**
 * Тост в начале только что созданной встречи (R142): «Ссылка на встречу скопирована» — ссылку
 * положило в буфер нажатие «Начать встречу» (`core/invite-copy.ts`). Буфер не дался (запрет сайта,
 * старый браузер) — тост говорит об этом и даёт «Скопировать»: нажатие — жест, запись пройдёт.
 * Встреча, в которую вошли, а не создали, ничего не забирает и молчит.
 */
export function InviteCopiedNotice({ meeting }: { meeting: Meeting }) {
  const { t } = useTranslation();
  const toast = useToast();
  useEffect(() => {
    const copy = takeInviteCopy();
    if (!copy) return;
    void copy.copied.then(async (done) => {
      if (done) {
        toast.add({ title: t(($) => $.meeting.inviteCopy.done), type: 'success' });
        return;
      }
      const link = (await copy.link) ?? meeting.invite.get() ?? inviteLink(meeting.admission);
      if (!link) return;
      const id = toast.add({
        title: t(($) => $.meeting.inviteCopy.failed),
        type: 'info',
        timeout: 10_000,
        actionProps: {
          children: t(($) => $.meeting.inviteCopy.copy),
          onClick: () => {
            void navigator.clipboard
              ?.writeText(link)
              .then(() =>
                toast.update(id, {
                  title: t(($) => $.meeting.inviteCopy.done),
                  type: 'success',
                  actionProps: undefined,
                  timeout: 4000,
                }),
              )
              .catch(() => {});
          },
        },
      });
    });
    // Один раз на встречу: итог копирования принадлежит только что открывшейся встрече.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
