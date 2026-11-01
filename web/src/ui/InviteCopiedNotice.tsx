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
 *
 * «Скопирована» — коротко (R171): 2,5 с. Base UI замораживает срок тоста, пока окно не в фокусе, а ссылку
 * сразу уносят вставлять в другое окно — и плашка ждала человека обратно. Поэтому ещё и предел по часам.
 */
/** Сколько живёт «Ссылка на встречу скопирована». */
const BRIEF = 2500;

export function InviteCopiedNotice({ meeting }: { meeting: Meeting }) {
  const { t } = useTranslation();
  const toast = useToast();
  useEffect(() => {
    /** Убрать тост по часам, даже если окно не в фокусе и срок Base UI стоит. */
    const brief = (id: string) => setTimeout(() => toast.close(id), BRIEF + 500);
    const copy = takeInviteCopy();
    if (!copy) return;
    void copy.copied.then(async (done) => {
      if (done) {
        brief(toast.add({ title: t(($) => $.meeting.inviteCopy.done), type: 'success', timeout: BRIEF }));
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
              .then(() => {
                toast.update(id, {
                  title: t(($) => $.meeting.inviteCopy.done),
                  type: 'success',
                  actionProps: undefined,
                  timeout: BRIEF,
                });
                brief(id);
              })
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
